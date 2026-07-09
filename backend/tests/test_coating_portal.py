"""End-to-end backend tests for the Coating Portal API."""
import os
import time
import pytest
import requests

BASE = os.environ.get("EXPO_PUBLIC_BACKEND_URL", "http://localhost:8001").rstrip("/")
API = f"{BASE}/api"

EMAIL = "j.thompson@aerospace-precision.com"
PASSWORD = "Inspector@123"


@pytest.fixture(scope="session")
def token():
    r = requests.post(f"{API}/auth/login", json={"email": EMAIL, "password": PASSWORD}, timeout=15)
    assert r.status_code == 200, r.text
    return r.json()["access_token"]


@pytest.fixture
def auth(token):
    return {"Authorization": f"Bearer {token}"}


# ---------- Auth ----------
class TestAuth:
    def test_login_success(self):
        r = requests.post(f"{API}/auth/login", json={"email": EMAIL, "password": PASSWORD}, timeout=15)
        assert r.status_code == 200
        body = r.json()
        assert body["token_type"] == "bearer"
        assert body["access_token"]
        assert body["user"]["employee_id"] == "QC-7742"
        assert body["user"]["role"] == "Lead Inspector"

    def test_login_wrong_password(self):
        r = requests.post(f"{API}/auth/login", json={"email": EMAIL, "password": "wrong"}, timeout=15)
        assert r.status_code == 401

    def test_me_requires_token(self):
        r = requests.get(f"{API}/auth/me", timeout=15)
        assert r.status_code == 401

    def test_me_with_token(self, auth):
        r = requests.get(f"{API}/auth/me", headers=auth, timeout=15)
        assert r.status_code == 200
        assert r.json()["employee_id"] == "QC-7742"


# ---------- Work Orders listing ----------
class TestWorkOrders:
    def test_list_all(self, auth):
        r = requests.get(f"{API}/work-orders", headers=auth, timeout=15)
        assert r.status_code == 200
        items = r.json()
        ids = {w["work_order_id"] for w in items}
        # 4 seed work orders
        assert {"WO-2024-9901", "WO-2024-9905", "WO-2024-9912", "WO-2024-9920"}.issubset(ids)
        # WO format
        for w in items:
            assert w["work_order_id"].startswith("WO-2024-")

    def test_filter_priority(self, auth):
        r = requests.get(f"{API}/work-orders?filter=priority", headers=auth, timeout=15)
        assert r.status_code == 200
        items = r.json()
        assert all(w["priority"] for w in items)
        ids = {w["work_order_id"] for w in items}
        assert "WO-2024-9901" in ids
        assert "WO-2024-9912" in ids

    def test_filter_pending(self, auth):
        r = requests.get(f"{API}/work-orders?filter=pending", headers=auth, timeout=15)
        assert r.status_code == 200
        items = r.json()
        assert all(w["overall_status"] != "done" for w in items)

    def test_search_q(self, auth):
        r = requests.get(f"{API}/work-orders?q=Aerospace", headers=auth, timeout=15)
        assert r.status_code == 200
        items = r.json()
        assert len(items) >= 1
        assert any("Aerospace" in w["customer_name"] for w in items)

    def test_detail(self, auth):
        r = requests.get(f"{API}/work-orders/WO-2024-9901", headers=auth, timeout=15)
        assert r.status_code == 200
        wo = r.json()
        assert wo["po_number"] == "PO-AC-44821"
        assert wo["quantity"] == 24
        assert "→" in wo["serial_range"] or "\u2192" in wo["serial_range"]
        assert len(wo["stages"]) == 6
        # 2 stages pre-marked done
        done_keys = [s["key"] for s in wo["stages"] if s["status"] == "done"]
        assert set(done_keys) == {"surface_prep", "primer_coat"}
        # spec
        assert wo["spec"]["dft_min_um"] == 250
        assert wo["spec"]["dft_max_um"] == 400

    def test_detail_404(self, auth):
        r = requests.get(f"{API}/work-orders/WO-NOPE", headers=auth, timeout=15)
        assert r.status_code == 404


# ---------- Weather ----------
class TestWeather:
    def test_weather_keys(self, auth):
        r = requests.get(f"{API}/weather", headers=auth, timeout=15)
        assert r.status_code == 200
        body = r.json()
        for k in ("ambient_temp_c", "relative_humidity_pct", "dew_point_c"):
            assert k in body
            assert isinstance(body[k], (int, float))


# ---------- Dashboard ----------
class TestDashboard:
    def test_dashboard(self, auth):
        r = requests.get(f"{API}/dashboard", headers=auth, timeout=15)
        assert r.status_code == 200
        body = r.json()
        assert body["system_status"] == "SYNCED"
        assert body["quota"]["target"] >= 1
        assert body["current_assignment"] is not None
        assert body["current_assignment"]["work_order_id"].startswith("WO-2024-")


# ---------- Stage submission ----------
def _valid_readings():
    # Surface temp must be > dew point + 3
    return {
        "start": {"ambient_temp_c": 22.0, "relative_humidity_pct": 45.0, "dew_point_c": 9.5, "surface_temp_c": 18.0},
        "end":   {"ambient_temp_c": 22.5, "relative_humidity_pct": 46.0, "dew_point_c": 9.8, "surface_temp_c": 18.5},
    }


class TestStageSubmit:
    def test_happy_path_pass(self, auth):
        body = {
            "readings": _valid_readings(),
            "parameters": {"surface_profile_um": 75, "dft_um": 320, "soluble_salts_mg_m2": 10},
            "notes": "TEST submit pass",
            "photos": [],
            "result": "pass",
        }
        r = requests.post(
            f"{API}/work-orders/WO-2024-9905/stages/surface_prep/submit",
            json=body, headers=auth, timeout=15,
        )
        assert r.status_code == 200, r.text
        j = r.json()
        assert j["ok"] is True
        assert j["result"] == "pass"
        # verify stage status updated via GET
        r2 = requests.get(f"{API}/work-orders/WO-2024-9905", headers=auth, timeout=15)
        sp = next(s for s in r2.json()["stages"] if s["key"] == "surface_prep")
        assert sp["status"] == "done"
        assert sp["result"] == "pass"

    def test_dft_hard_block(self, auth):
        # WO-2024-9901 uses EPOXY-COAT-X with dft_max_um=400; 450 must hard-block
        body = {
            "readings": _valid_readings(),
            "parameters": {"surface_profile_um": 75, "dft_um": 450, "soluble_salts_mg_m2": 10},
            "notes": "TEST hard block",
            "photos": [],
            "result": "pass",
        }
        r = requests.post(
            f"{API}/work-orders/WO-2024-9901/stages/top_coat/submit",
            json=body, headers=auth, timeout=15,
        )
        assert r.status_code == 422, r.text
        detail = r.json().get("detail", {})
        assert detail.get("hard_block") is True

    def test_surface_profile_out_of_spec_marks_fail(self, auth):
        body = {
            "readings": _valid_readings(),
            "parameters": {"surface_profile_um": 5, "dft_um": 320, "soluble_salts_mg_m2": 10},
            "notes": "TEST sp fail",
            "photos": [],
            "result": "pass",
        }
        r = requests.post(
            f"{API}/work-orders/WO-2024-9920/stages/surface_prep/submit",
            json=body, headers=auth, timeout=15,
        )
        assert r.status_code == 200, r.text
        assert r.json()["result"] == "fail"

    def test_salts_over_max_marks_fail(self, auth):
        # salts are validated at surface_prep (per-stage params); ZINC-GALV-XL max is 15
        body = {
            "readings": _valid_readings(),
            "parameters": {"surface_profile_um": 70, "soluble_salts_mg_m2": 99},
            "notes": "TEST salts fail",
            "photos": [],
            "result": "pass",
        }
        r = requests.post(
            f"{API}/work-orders/WO-2024-9912/stages/surface_prep/submit",
            json=body, headers=auth, timeout=15,
        )
        assert r.status_code == 200
        assert r.json()["result"] == "fail"

    def test_missing_required_param_rejected(self, auth):
        # primer_coat requires dft_um; omitting it must 400, not silently pass
        body = {
            "readings": _valid_readings(),
            "parameters": {"surface_profile_um": 70},
            "notes": "TEST missing dft",
            "photos": [],
            "result": "pass",
        }
        r = requests.post(
            f"{API}/work-orders/WO-2024-9920/stages/primer_coat/submit",
            json=body, headers=auth, timeout=15,
        )
        assert r.status_code == 400

    def test_two_step_start_then_submit(self, auth):
        # tests run against a persistent DB and /start rejects completed stages,
        # so create a dedicated WO from a real paint-system spec each run
        specs = requests.get(f"{API}/coating-specifications", headers=auth, timeout=15).json()
        assert len(specs) >= 1
        spec = specs[0]
        create_body = {
            "customer_name": "Two-Step Test Co",
            "po_number": f"PO-TEST-{int(time.time())}",
            "po_line_item_number": 1,
            "part_number": "PN-2STEP",
            "part_revision_number": "A",
            "coating_spec_code": spec["specification"],
            "coating_spec_revision_number": spec["spec_rev"] or "0",
            "paint_system_id": spec["id"],
            "quantity": 1,
        }
        created = requests.post(f"{API}/work-orders", json=create_body, headers=auth, timeout=15)
        assert created.status_code == 201, created.text
        wo_id = created.json()["work_order_id"]

        # start-of-stage readings recorded separately
        start_body = {"readings": {"ambient_temp_c": 21.5, "relative_humidity_pct": 44.0,
                                   "dew_point_c": 9.0, "surface_temp_c": 17.5}}
        r = requests.post(f"{API}/work-orders/{wo_id}/stages/primer_coat/start",
                          json=start_body, headers=auth, timeout=15)
        assert r.status_code == 200, r.text
        assert r.json()["started_at"]

        # starting twice must conflict
        r2 = requests.post(f"{API}/work-orders/{wo_id}/stages/primer_coat/start",
                           json=start_body, headers=auth, timeout=15)
        assert r2.status_code == 409

        # stage now shows in_progress with stored start readings
        detail = requests.get(f"{API}/work-orders/{wo_id}", headers=auth, timeout=15).json()
        stg = next(s for s in detail["stages"] if s["key"] == "primer_coat")
        assert stg["status"] == "in_progress"
        assert stg["start_readings"]["surface_temp_c"] == 17.5

        # end submission carries only end readings + the stage's parameter:
        # a DFT inside this spec's primer window (per-coat limits from the paint system)
        primer_lo, primer_hi = detail["coat_limits"]["primer"]
        submit_body = {
            "readings": {"end": {"ambient_temp_c": 22.0, "relative_humidity_pct": 45.0,
                                 "dew_point_c": 9.5, "surface_temp_c": 18.0}},
            "parameters": {"dft_um": (primer_lo + primer_hi) / 2},
            "notes": "TEST two-step",
            "photos": [],
            "result": "pass",
        }
        r3 = requests.post(f"{API}/work-orders/{wo_id}/stages/primer_coat/submit",
                           json=submit_body, headers=auth, timeout=15)
        assert r3.status_code == 200, r3.text
        assert r3.json()["result"] == "pass"

        # stored submission merged the server-side start readings
        detail = requests.get(f"{API}/work-orders/{wo_id}", headers=auth, timeout=15).json()
        stg = next(s for s in detail["stages"] if s["key"] == "primer_coat")
        assert stg["status"] == "done"
        assert stg["submission"]["readings"]["start"]["surface_temp_c"] == 17.5

    def test_gate_fails_when_surface_not_gt_dew_plus_3(self, auth):
        readings = _valid_readings()
        readings["end"]["surface_temp_c"] = 10.0  # < dew(9.8)+3
        body = {
            "readings": readings,
            "parameters": {"surface_profile_um": 70, "dft_um": 320, "soluble_salts_mg_m2": 10},
            "notes": "TEST gate fail",
            "photos": [],
            "result": "pass",
        }
        r = requests.post(
            f"{API}/work-orders/WO-2024-9920/stages/top_coat/submit",
            json=body, headers=auth, timeout=15,
        )
        assert r.status_code == 200
        assert r.json()["result"] == "fail"


# ---------- Audit log & history ----------
class TestAuditAndHistory:
    def test_audit_log_has_entries(self, auth):
        # ensure we've at least produced one submission above; submit a fresh one to guarantee
        body = {
            "readings": _valid_readings(),
            "parameters": {"surface_profile_um": 75, "dft_um": 320, "soluble_salts_mg_m2": 10},
            "notes": "TEST audit",
            "photos": [],
            "result": "pass",
        }
        requests.post(
            f"{API}/work-orders/WO-2024-9905/stages/mid_inspection/submit",
            json=body, headers=auth, timeout=15,
        )
        time.sleep(0.5)
        r = requests.get(f"{API}/work-orders/WO-2024-9905/audit-log", headers=auth, timeout=15)
        assert r.status_code == 200
        entries = r.json()
        assert len(entries) >= 1
        assert any(e["action"] == "stage_submit" for e in entries)

    def test_history_desc(self, auth):
        r = requests.get(f"{API}/inspections/history", headers=auth, timeout=15)
        assert r.status_code == 200
        items = r.json()
        assert len(items) >= 1
        ts = [it["timestamp"] for it in items]
        assert ts == sorted(ts, reverse=True)
