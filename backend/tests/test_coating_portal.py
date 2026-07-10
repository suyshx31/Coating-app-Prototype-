"""End-to-end backend tests for the Coating Portal API (case-type workflows).

Run against a live server + persistent DB: every test that needs a work order
creates its own (unique PO number per run), so the suite is rerunnable.
"""
import itertools
import os
import time
import pytest
import requests

# Port 8002 = the dedicated test stack provisioned by conftest.py (throwaway
# Docker Postgres + its own uvicorn). Never point this at the live backend.
BASE = os.environ.get("TEST_BACKEND_URL", "http://localhost:8002").rstrip("/")
API = f"{BASE}/api"

EMAIL = "j.thompson@aerospace-precision.com"
PASSWORD = "Inspector@123"

CASE_SEQUENCES = {
    "only_primer": ["surface_prep", "primer_coat", "curing_qa"],
    "primer_intermediate": ["surface_prep", "primer_coat", "intermediate_coat", "curing_qa"],
    "primer_intermediate_top": ["surface_prep", "primer_coat", "intermediate_coat", "top_coat", "curing_qa"],
    "top_coat_only": ["surface_prep", "top_coat", "curing_qa"],
}

_seq = itertools.count(1)


@pytest.fixture(scope="session")
def token():
    r = requests.post(f"{API}/auth/login", json={"email": EMAIL, "password": PASSWORD}, timeout=15)
    assert r.status_code == 200, r.text
    return r.json()["access_token"]


@pytest.fixture
def auth(token):
    return {"Authorization": f"Bearer {token}"}


@pytest.fixture(scope="session")
def spec(token):
    """A paint-system spec that has primer, intermediate, top and total DFT windows."""
    r = requests.get(f"{API}/coating-specifications",
                     headers={"Authorization": f"Bearer {token}"}, timeout=15)
    assert r.status_code == 200, r.text
    rows = r.json()
    return next(x for x in rows
                if x["specification"] == "MVG040014" and x["paint_brand"] == "JOTUN"
                and x["system_number"] == 2)


def _create_wo(auth, spec, case_type, **overrides):
    body = {
        "case_type": case_type,
        "customer_name": f"Test {case_type}",
        "po_number": f"PO-T-{int(time.time())}-{next(_seq)}",
        "po_line_item_number": 1,
        "part_number": f"PN-{case_type}",
        "part_revision_number": "A",
        "coating_spec_code": spec["specification"],
        "coating_spec_revision_number": spec["spec_rev"] or "0",
        "paint_system_id": spec["id"],
        "quantity": 1,
        **overrides,
    }
    r = requests.post(f"{API}/work-orders", json=body, headers=auth, timeout=15)
    assert r.status_code == 201, r.text
    return r.json()


def _detail(auth, wo_id):
    r = requests.get(f"{API}/work-orders/{wo_id}", headers=auth, timeout=15)
    assert r.status_code == 200, r.text
    return r.json()


def _readings(end_surface=18.0, end_dew=9.5):
    return {
        "start": {"ambient_temp_c": 22.0, "relative_humidity_pct": 45.0, "dew_point_c": 9.5, "surface_temp_c": 18.0},
        "end":   {"ambient_temp_c": 22.5, "relative_humidity_pct": 46.0, "dew_point_c": end_dew, "surface_temp_c": end_surface},
    }


def _submit(auth, wo_id, stage_key, parameters, result="pass", readings=None):
    body = {"readings": readings or _readings(), "parameters": parameters,
            "notes": "TEST", "photos": [], "result": result}
    return requests.post(f"{API}/work-orders/{wo_id}/stages/{stage_key}/submit",
                         json=body, headers=auth, timeout=15)


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


# ---------- Case types ----------
class TestCaseTypes:
    def test_four_case_types_with_exact_sequences(self, auth):
        r = requests.get(f"{API}/case-types", headers=auth, timeout=15)
        assert r.status_code == 200
        got = {ct["case_type"]: [s["key"] for s in ct["stages"]] for ct in r.json()}
        assert got == CASE_SEQUENCES

    def test_curing_qa_is_observational_in_all_cases(self, auth):
        r = requests.get(f"{API}/case-types", headers=auth, timeout=15)
        for ct in r.json():
            qa = next(s for s in ct["stages"] if s["key"] == "curing_qa")
            assert qa["params"] == []


# ---------- Work order creation ----------
class TestCreateWorkOrder:
    @pytest.mark.parametrize("case_type", list(CASE_SEQUENCES))
    def test_stages_generated_per_case_type(self, auth, spec, case_type):
        created = _create_wo(auth, spec, case_type)
        assert created["case_type"] == case_type
        assert created["total_stages"] == len(CASE_SEQUENCES[case_type])
        detail = _detail(auth, created["work_order_id"])
        assert [s["key"] for s in detail["stages"]] == CASE_SEQUENCES[case_type]
        assert all(s["status"] == "pending" for s in detail["stages"])

    def test_case_type_required(self, auth, spec):
        body = {
            "customer_name": "No Case", "po_number": f"PO-NC-{int(time.time())}",
            "po_line_item_number": 1, "part_number": "PN-NC", "part_revision_number": "A",
            "coating_spec_code": spec["specification"], "coating_spec_revision_number": "N",
            "paint_system_id": spec["id"], "quantity": 1,
        }
        r = requests.post(f"{API}/work-orders", json=body, headers=auth, timeout=15)
        assert r.status_code == 422  # pydantic: missing/invalid case_type

    def test_invalid_case_type_rejected(self, auth, spec):
        r = requests.post(f"{API}/work-orders", json={
            "case_type": "full_coating", "customer_name": "Bad Case",
            "po_number": f"PO-BC-{int(time.time())}", "po_line_item_number": 1,
            "part_number": "PN-BC", "part_revision_number": "A",
            "coating_spec_code": spec["specification"], "coating_spec_revision_number": "N",
            "paint_system_id": spec["id"], "quantity": 1,
        }, headers=auth, timeout=15)
        assert r.status_code == 422

    def test_duplicate_guard(self, auth, spec):
        po = f"PO-DUP-{int(time.time())}"
        _create_wo(auth, spec, "only_primer", po_number=po, part_number="PN-DUP")
        r = requests.post(f"{API}/work-orders", json={
            "case_type": "only_primer", "customer_name": "Dup Co", "po_number": po,
            "po_line_item_number": 1, "part_number": "PN-DUP", "part_revision_number": "A",
            "coating_spec_code": spec["specification"], "coating_spec_revision_number": "N",
            "paint_system_id": spec["id"], "quantity": 1,
        }, headers=auth, timeout=15)
        assert r.status_code == 409
        assert r.json()["detail"]["duplicate"] is True

    def test_detail_shape(self, auth, spec):
        created = _create_wo(auth, spec, "primer_intermediate_top")
        wo = _detail(auth, created["work_order_id"])
        assert wo["spec"]["dft_min_um"] > 0
        for window in ("primer", "intermediate", "top", "mid_cumulative", "total"):
            assert wo["coat_limits"][window], f"missing coat_limits.{window}"
        assert wo["po_number"].startswith("PO-T-")

    def test_detail_404(self, auth):
        r = requests.get(f"{API}/work-orders/WO-NOPE", headers=auth, timeout=15)
        assert r.status_code == 404


# ---------- Work order listing ----------
class TestWorkOrders:
    def test_list_contains_created_and_valid_format(self, auth, spec):
        created = _create_wo(auth, spec, "top_coat_only")
        r = requests.get(f"{API}/work-orders", headers=auth, timeout=15)
        assert r.status_code == 200
        items = r.json()
        ids = {w["work_order_id"] for w in items}
        assert created["work_order_id"] in ids
        import re
        for w in items:
            assert re.match(r"^WO-\d{4}-\d{4}$", w["work_order_id"]), w["work_order_id"]
            assert w["case_type"] in CASE_SEQUENCES
            assert w["total_stages"] == len(CASE_SEQUENCES[w["case_type"]])

    def test_search_q(self, auth, spec):
        created = _create_wo(auth, spec, "only_primer", customer_name="Searchable Unique Co")
        r = requests.get(f"{API}/work-orders?q=Searchable Unique", headers=auth, timeout=15)
        assert r.status_code == 200
        assert any(w["work_order_id"] == created["work_order_id"] for w in r.json())


# ---------- Stage validation per case ----------
class TestStageValidation:
    def test_surface_prep_profile_out_of_spec_fails(self, auth, spec):
        wo = _create_wo(auth, spec, "only_primer")
        # anchor profile window is 25.4-63.5 µm for this spec; 5 µm is below it
        r = _submit(auth, wo["work_order_id"], "surface_prep",
                    {"surface_profile_um": 5, "soluble_salts_mg_m2": 10})
        assert r.status_code == 200, r.text
        assert r.json()["result"] == "fail"

    def test_surface_prep_missing_param_rejected(self, auth, spec):
        wo = _create_wo(auth, spec, "only_primer")
        r = _submit(auth, wo["work_order_id"], "surface_prep", {"surface_profile_um": 40})
        assert r.status_code == 400  # soluble_salts_mg_m2 required at this stage

    def test_primer_window_hard_block(self, auth, spec):
        wo = _create_wo(auth, spec, "only_primer")
        detail = _detail(auth, wo["work_order_id"])
        _, primer_hi = detail["coat_limits"]["primer"]
        r = _submit(auth, wo["work_order_id"], "primer_coat", {"dft_um": primer_hi + 100})
        assert r.status_code == 422, r.text
        assert r.json()["detail"]["hard_block"] is True

    def test_intermediate_uses_cumulative_window(self, auth, spec):
        wo = _create_wo(auth, spec, "primer_intermediate")
        detail = _detail(auth, wo["work_order_id"])
        lo, hi = detail["coat_limits"]["mid_cumulative"]
        stage = next(s for s in detail["stages"] if s["key"] == "intermediate_coat")
        assert stage["dft_window"] == "mid_cumulative"
        r = _submit(auth, wo["work_order_id"], "intermediate_coat", {"dft_um": (lo + hi) / 2})
        assert r.status_code == 200, r.text
        assert r.json()["result"] == "pass"

    def test_top_coat_only_uses_standalone_top_window(self, auth, spec):
        wo = _create_wo(auth, spec, "top_coat_only")
        detail = _detail(auth, wo["work_order_id"])
        lo, hi = detail["coat_limits"]["top"]
        total_hi = detail["coat_limits"]["total"][1]
        assert hi < total_hi  # the standalone window is tighter than full-system
        stage = next(s for s in detail["stages"] if s["key"] == "top_coat")
        assert stage["dft_window"] == "top"
        ok = _submit(auth, wo["work_order_id"], "top_coat", {"dft_um": (lo + hi) / 2})
        assert ok.status_code == 200 and ok.json()["result"] == "pass"
        # over the top window (but under total) must still hard-block
        wo2 = _create_wo(auth, spec, "top_coat_only")
        blocked = _submit(auth, wo2["work_order_id"], "top_coat", {"dft_um": hi + 50})
        assert blocked.status_code == 422
        assert blocked.json()["detail"]["hard_block"] is True

    def test_curing_qa_observational_pass_and_fail(self, auth, spec):
        wo = _create_wo(auth, spec, "only_primer")
        r = _submit(auth, wo["work_order_id"], "curing_qa", {})
        assert r.status_code == 200, r.text
        assert r.json()["result"] == "pass"
        wo2 = _create_wo(auth, spec, "only_primer")
        r2 = _submit(auth, wo2["work_order_id"], "curing_qa", {}, result="fail")
        assert r2.status_code == 200
        assert r2.json()["result"] == "fail"

    def test_stage_not_in_case_404(self, auth, spec):
        wo = _create_wo(auth, spec, "top_coat_only")  # has no primer_coat
        r = _submit(auth, wo["work_order_id"], "primer_coat", {"dft_um": 120})
        assert r.status_code == 404

    def test_gate_fails_when_surface_not_gt_dew_plus_3(self, auth, spec):
        wo = _create_wo(auth, spec, "only_primer")
        detail = _detail(auth, wo["work_order_id"])
        lo, hi = detail["coat_limits"]["primer"]
        r = _submit(auth, wo["work_order_id"], "primer_coat", {"dft_um": (lo + hi) / 2},
                    readings=_readings(end_surface=10.0, end_dew=9.8))
        assert r.status_code == 200
        assert r.json()["result"] == "fail"


# ---------- Two-step start/end flow ----------
class TestTwoStepFlow:
    def test_start_then_submit(self, auth, spec):
        wo = _create_wo(auth, spec, "primer_intermediate")
        wo_id = wo["work_order_id"]
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

        detail = _detail(auth, wo_id)
        stg = next(s for s in detail["stages"] if s["key"] == "primer_coat")
        assert stg["status"] == "in_progress"
        assert stg["start_readings"]["surface_temp_c"] == 17.5

        lo, hi = detail["coat_limits"]["primer"]
        submit_body = {
            "readings": {"end": {"ambient_temp_c": 22.0, "relative_humidity_pct": 45.0,
                                 "dew_point_c": 9.5, "surface_temp_c": 18.0}},
            "parameters": {"dft_um": (lo + hi) / 2},
            "notes": "TEST two-step", "photos": [], "result": "pass",
        }
        r3 = requests.post(f"{API}/work-orders/{wo_id}/stages/primer_coat/submit",
                           json=submit_body, headers=auth, timeout=15)
        assert r3.status_code == 200, r3.text
        assert r3.json()["result"] == "pass"

        detail = _detail(auth, wo_id)
        stg = next(s for s in detail["stages"] if s["key"] == "primer_coat")
        assert stg["status"] == "done"
        assert stg["submission"]["readings"]["start"]["surface_temp_c"] == 17.5

    def test_start_stage_not_in_case_404(self, auth, spec):
        wo = _create_wo(auth, spec, "only_primer")
        r = requests.post(f"{API}/work-orders/{wo['work_order_id']}/stages/top_coat/start",
                          json={"readings": {}}, headers=auth, timeout=15)
        assert r.status_code == 404


# ---------- Weather / dashboard / audit / history ----------
class TestWeather:
    def test_weather_keys(self, auth):
        r = requests.get(f"{API}/weather", headers=auth, timeout=15)
        assert r.status_code == 200
        body = r.json()
        for k in ("ambient_temp_c", "relative_humidity_pct", "dew_point_c"):
            assert k in body
            assert isinstance(body[k], (int, float))


class TestDashboard:
    def test_dashboard(self, auth, spec):
        _create_wo(auth, spec, "only_primer")  # guarantee at least one open WO
        r = requests.get(f"{API}/dashboard", headers=auth, timeout=15)
        assert r.status_code == 200
        body = r.json()
        assert body["system_status"] == "SYNCED"
        assert body["quota"]["target"] >= 1
        assert body["current_assignment"] is not None


class TestAuditAndHistory:
    def test_audit_log_has_entries(self, auth, spec):
        wo = _create_wo(auth, spec, "only_primer")
        detail = _detail(auth, wo["work_order_id"])
        lo, hi = detail["coat_limits"]["primer"]
        _submit(auth, wo["work_order_id"], "primer_coat", {"dft_um": (lo + hi) / 2})
        time.sleep(0.5)
        r = requests.get(f"{API}/work-orders/{wo['work_order_id']}/audit-log", headers=auth, timeout=15)
        assert r.status_code == 200
        actions = {e["action"] for e in r.json()}
        assert "work_order_created" in actions
        assert "stage_submit" in actions

    def test_history_desc(self, auth):
        r = requests.get(f"{API}/inspections/history", headers=auth, timeout=15)
        assert r.status_code == 200
        items = r.json()
        assert len(items) >= 1
        ts = [it["timestamp"] for it in items]
        assert ts == sorted(ts, reverse=True)
