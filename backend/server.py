"""Coating Portal backend — FastAPI + PostgreSQL (Supabase).

Implements the domain model from the spec:
- work_orders / work_order_stages (case-type-driven workflow, WO-YYYY-NNNN ids):
  each work order picks one of 4 case types (only_primer, primer_intermediate,
  primer_intermediate_top, top_coat_only) whose stage sequence + per-stage
  field sets come from case_type_stage_templates and are snapshotted onto
  work_order_stages at creation
- inspectors (JWT email/password auth), audit_log, quota, wo_counters
- paint_system_specifications (imported from MVG040014N.xlsx) drives the
  coating-spec picker and per-coat DFT validation windows
- WeatherReading (API-sourced, mocked) + manual surface temperature captured
  as separate start-of-stage and end-of-stage submissions
- MeasuredParameter validation is stage-specific (stage row's params): surface
  profile + soluble salts at surface prep, cumulative DFT at coat stages,
  observational only at curing / final QC. DFT over max hard-blocks.

Auth: JWT email/password (Entra ID deferred to real Spring Boot backend).
"""

import asyncio
import json
import logging
import os
import random
import re
import resend
import tempfile
import time
from contextlib import asynccontextmanager
from datetime import date, datetime, timedelta, timezone
from datetime import time as dt_time
from pathlib import Path
from typing import List, Literal, Optional

import asyncpg
import jwt
import requests
from dotenv import load_dotenv
from fastapi import Depends, FastAPI, APIRouter, HTTPException
from fastapi.responses import Response
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from passlib.context import CryptContext
from pydantic import BaseModel, EmailStr, Field
from starlette.middleware.cors import CORSMiddleware

import reports as report_gen
from report_generation.fill_nov_report import fill_report as fill_nov_report
from report_generation.nov_payload import build_nov_payload

ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / ".env")

# ---------- config ----------
DATABASE_URL = os.environ["DATABASE_URL"]  # Supabase Postgres, direct 5432 connection
JWT_SECRET = os.environ.get("JWT_SECRET", "coating-portal-dev-secret-change-me")
JWT_ALG = "HS256"
JWT_EXP_HOURS = 12

pwd_ctx = CryptContext(schemes=["bcrypt"], deprecated="auto")
bearer = HTTPBearer(auto_error=False)

pool: Optional[asyncpg.Pool] = None

# ---------- case types ----------
# Stage sequences and per-stage field sets live in case_type_stage_templates;
# each work order snapshots its case's template rows into work_order_stages at
# creation. This Literal mirrors the DB CHECK constraint on work_orders.case_type.
CaseType = Literal["only_primer", "primer_intermediate", "primer_intermediate_top", "top_coat_only",
                   "primer_top_coat"]

MILS_TO_UM = 25.4


# ---------- models ----------
class LoginRequest(BaseModel):
    email: EmailStr
    password: str

class LoginResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user: dict

class InspectorOut(BaseModel):
    id: str
    employee_id: str
    name: str
    email: EmailStr
    role: str
    shift: str
    department: str
    avatar_url: Optional[str] = None

class PaintSpec(BaseModel):
    surface_profile_min_um: float
    surface_profile_max_um: float
    dft_min_um: float
    dft_max_um: float
    # Paint-system specs imported from Excel carry no soluble-salts limit;
    # None means "no limit defined in spec" and the check is skipped.
    soluble_salts_max_mg_m2: Optional[float] = None

class WorkOrderSummary(BaseModel):
    work_order_id: str
    case_type: str
    customer_name: str
    paint_product_code: str
    paint_product_name: str
    part_description: str
    quantity: int
    serial_range: str
    priority: bool
    progress: int       # number of stages done
    total_stages: int   # stage count depends on case_type
    overall_status: str  # pending | in_progress | done | fail

class WorkOrderDetail(WorkOrderSummary):
    po_number: str
    spec: PaintSpec
    # Per-coat cumulative DFT windows in µm, derived from the paint-system row
    # at creation: {"primer": [lo,hi], "intermediate": [lo,hi]|None,
    # "mid_cumulative": [lo,hi]|None, "total": [lo,hi]}. None for legacy WOs.
    coat_limits: Optional[dict] = None
    stages: List[dict]

class StageReadings(BaseModel):
    # weather (auto, from OpenWeather — mocked when key not present)
    ambient_temp_c: Optional[float] = None
    relative_humidity_pct: Optional[float] = None
    dew_point_c: Optional[float] = None
    # surface temp (manual Elcometer 319)
    surface_temp_c: Optional[float] = None

class StageReadingPair(BaseModel):
    # start is optional: with the two-step flow the start readings were
    # already stored by POST .../start; a full pair is still accepted for
    # single-shot (legacy/offline) submissions.
    start: Optional[StageReadings] = None
    end: StageReadings = Field(default_factory=StageReadings)

class StageStartRequest(BaseModel):
    readings: StageReadings = Field(default_factory=StageReadings)
    # start-phase field values (paint identification, operator, batch/expiry
    # on curing_qa) and before-work photos
    fields: dict = Field(default_factory=dict)
    photos: List[str] = Field(default_factory=list)

class StageSubmission(BaseModel):
    readings: StageReadingPair
    # values keyed by the stage's field definitions (work_order_stages.fields,
    # snapshotted from the case-type template); validated server-side per type
    fields: dict = Field(default_factory=dict)
    notes: Optional[str] = ""
    photos: List[str] = Field(default_factory=list)  # base64 strings
    result: Literal["pass", "fail"] = "pass"

class CreateWorkOrderRequest(BaseModel):
    case_type: CaseType
    customer_name: str = Field(..., min_length=1)
    customer_address: Optional[str] = ""  # only optional field
    po_number: str = Field(..., min_length=1)            # external customer PO ref
    po_line_item_number: int = Field(..., ge=1)          # which line within that PO
    part_number: str = Field(..., min_length=1)
    part_revision_number: str = Field(..., min_length=1)
    coating_spec_code: str = Field(..., min_length=1)
    coating_spec_revision_number: str = Field(..., min_length=1)
    # paint_system_specifications.id — spec codes repeat across brands/systems,
    # so the picked row is identified by its uuid.
    paint_system_id: str = Field(..., min_length=1)
    quantity: int = Field(..., ge=1)
    confirm_duplicate: bool = False  # set to True to override the duplicate guard

class PaintSystemSpec(BaseModel):
    """Row from `paint_system_specifications` (imported from MVG040014N.xlsx)."""
    id: str
    specification: str
    spec_rev: Optional[str] = None
    surface_preparation: Optional[str] = None
    curing_test_method: Optional[str] = None
    adhesion_tape_inspection_method: Optional[str] = None
    wft_measurement_method: Optional[str] = None
    oil_water_test_method: Optional[str] = None
    surface_profile_test_method: Optional[str] = None
    dft_test_method: Optional[str] = None
    mek_resistance_test_method: Optional[str] = None
    section: Optional[str] = None
    system_number: Optional[float] = None
    application_service_category: Optional[str] = None
    anchor_profile_mils: Optional[str] = None
    paint_brand: Optional[str] = None
    top_coat_ral_shade: Optional[float] = None
    primer_paint_product: Optional[str] = None
    primer_coat_dft_low_mils: Optional[float] = None
    primer_coat_dft_high_mils: Optional[float] = None
    primer_coat_color: Optional[str] = None
    primer_volume_pct_solids: Optional[float] = None
    primer_wt_pct_zinc_dft: Optional[float] = None
    intermediate_coat_product: Optional[str] = None
    intermediate_coat_dft_low_mils: Optional[float] = None
    intermediate_coat_dft_high_mils: Optional[float] = None
    intermediate_coat_color: Optional[str] = None
    intermediate_coat_volume_pct_solids: Optional[float] = None
    top_coat_product: Optional[str] = None
    top_coat_dft_low_mils: Optional[float] = None
    top_coat_dft_high_mils: Optional[float] = None
    top_coat_volume_pct_solids: Optional[str] = None
    bottom_total_dft_system: Optional[float] = None
    top_total_dft_system: Optional[float] = None
    top_coat_paint_shade: Optional[str] = None

class AuditEntry(BaseModel):
    id: str
    work_order_id: str
    stage_key: Optional[str]
    actor_employee_id: str
    actor_name: str
    action: str
    detail: str
    timestamp: str

class HistoryItem(BaseModel):
    work_order_id: str
    customer_name: str
    stage_key: str
    stage_name: str
    result: str
    timestamp: str
    inspector_name: str


# ---------- helpers ----------
def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()

def _iso(dt: Optional[datetime]) -> Optional[str]:
    return dt.astimezone(timezone.utc).isoformat() if dt else None

def make_token(user: dict) -> str:
    payload = {
        "sub": user["email"],
        "employee_id": user["employee_id"],
        "exp": datetime.now(timezone.utc) + timedelta(hours=JWT_EXP_HOURS),
    }
    return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALG)


def _inspector_public(row) -> dict:
    return {
        "id": str(row["id"]),
        "employee_id": row["employee_id"],
        "name": row["name"],
        "email": row["email"],
        "role": row["role"],
        "shift": row["shift"],
        "department": row["department"],
        "avatar_url": row["avatar_url"],
    }


async def get_current_user(creds: Optional[HTTPAuthorizationCredentials] = Depends(bearer)) -> dict:
    if creds is None:
        raise HTTPException(status_code=401, detail="Missing auth token")
    try:
        payload = jwt.decode(creds.credentials, JWT_SECRET, algorithms=[JWT_ALG])
    except jwt.PyJWTError:
        raise HTTPException(status_code=401, detail="Invalid or expired token")
    assert pool is not None
    row = await pool.fetchrow("select * from inspectors where email = $1", payload.get("sub"))
    if not row:
        raise HTTPException(status_code=401, detail="User not found")
    return _inspector_public(row)


async def write_audit(work_order_id: str, stage_key: Optional[str], actor: dict, action: str, detail: str):
    assert pool is not None
    await pool.execute(
        """insert into audit_log (work_order_id, stage_key, actor_employee_id, actor_name, action, detail)
           values ($1, $2, $3, $4, $5, $6)""",
        work_order_id, stage_key, actor["employee_id"], actor["name"], action, detail,
    )


def stage_progress(stages: List[dict]) -> tuple[int, str]:
    done = sum(1 for s in stages if s.get("status") == "done")
    has_fail = any(s.get("status") == "fail" for s in stages)
    in_progress = any(s.get("status") == "in_progress" for s in stages)
    if has_fail:
        return done, "fail"
    if done == len(stages):
        return done, "done"
    if in_progress or done > 0:
        return done, "in_progress"
    return done, "pending"


def _spec_from_paint_system_row(row: dict) -> dict:
    """Derive the µm limits used by stage validation from a paint-system row.

    Converts mils → µm (×25.4). The imported spec sheet has no soluble-salts
    limit, so that stays None and the salts check is skipped for these WOs.
    """
    try:
        lo_str, hi_str = str(row["anchor_profile_mils"]).split("-", 1)
        sp_min_um = float(lo_str) * MILS_TO_UM
        sp_max_um = float(hi_str) * MILS_TO_UM
    except (KeyError, TypeError, ValueError):
        raise HTTPException(
            400, f"Paint system row has unusable anchor profile: {row.get('anchor_profile_mils')!r}"
        )
    if row.get("bottom_total_dft_system") is None or row.get("top_total_dft_system") is None:
        raise HTTPException(400, "Paint system row lacks total DFT limits")
    return {
        "surface_profile_min_um": round(sp_min_um, 1),
        "surface_profile_max_um": round(sp_max_um, 1),
        "dft_min_um": round(float(row["bottom_total_dft_system"]) * MILS_TO_UM, 1),
        "dft_max_um": round(float(row["top_total_dft_system"]) * MILS_TO_UM, 1),
        "soluble_salts_max_mg_m2": None,
    }


def _coat_limits_from_paint_system_row(row: dict) -> dict:
    """Per-coat cumulative DFT windows in µm from a paint-system row.

    mid_cumulative assumes the intermediate coat (when the system has one) is
    applied before mid-inspection, so its window is primer+intermediate summed.
    """
    def rng(lo_key: str, hi_key: str):
        lo, hi = row.get(lo_key), row.get(hi_key)
        if lo is None or hi is None:
            return None
        return [round(float(lo) * MILS_TO_UM, 1), round(float(hi) * MILS_TO_UM, 1)]

    primer = rng("primer_coat_dft_low_mils", "primer_coat_dft_high_mils")
    intermediate = rng("intermediate_coat_dft_low_mils", "intermediate_coat_dft_high_mils")
    top = rng("top_coat_dft_low_mils", "top_coat_dft_high_mils")
    total = rng("bottom_total_dft_system", "top_total_dft_system")
    mid = None
    if primer:
        mid = [
            round(primer[0] + (intermediate[0] if intermediate else 0), 1),
            round(primer[1] + (intermediate[1] if intermediate else 0), 1),
        ]
    # primer_top_coat skips the intermediate, so its cumulative top-coat window
    # is primer+top summed — same convention as mid_cumulative above.
    primer_top = None
    if primer and top:
        primer_top = [round(primer[0] + top[0], 1), round(primer[1] + top[1], 1)]
    # "top" is the standalone top-coat window (used by top_coat_only, where
    # there is no primer underneath); "total" is the full-system cumulative.
    return {"primer": primer, "intermediate": intermediate, "top": top,
            "mid_cumulative": mid, "primer_top_cumulative": primer_top, "total": total}


def _dft_limits_for_stage(wo: dict, stage: dict):
    """DFT window (µm) for a stage, per its snapshot dft_window; None = no check."""
    coat = wo.get("coat_limits") or {}
    window_key = stage.get("dft_window")
    window = coat.get(window_key) if window_key else None
    if window:
        return window[0], window[1]
    spec = wo.get("spec") or {}
    if spec.get("dft_min_um") is not None and spec.get("dft_max_um") is not None:
        return spec["dft_min_um"], spec["dft_max_um"]
    return None


def _gate_errors(r: StageReadings, when: str) -> List[str]:
    """Surface-temperature gate, with a distinct reason per failure mode:
    - > 60°C: too hot to coat (fails regardless of dew point)
    - not > dew point + 3°C: condensation risk
    """
    errs: List[str] = []
    if r.surface_temp_c is not None and r.surface_temp_c > 60:
        errs.append(f"Too hot for coat — Fail (surface {r.surface_temp_c}°C > 60°C at {when} of stage)")
    if r.surface_temp_c is not None and r.dew_point_c is not None and not (r.surface_temp_c > r.dew_point_c + 3):
        errs.append(
            f"Surface temp {r.surface_temp_c}°C too close to dew point {r.dew_point_c}°C "
            f"(needs > dew point + 3°C) at {when} of stage"
        )
    return errs


OK_NOTOK = {"OK", "NOT_OK"}
PASS_FAIL = {"PASS", "FAIL"}


def _field_range(wo: dict, stage: dict, fdef: dict, values: dict):
    """Resolve a field's validation window from its `range` name; None = no check."""
    rng = fdef.get("range")
    if rng == "pct":
        return 0.0, 100.0
    if rng == "anchor_profile":
        # spec stores the anchor window in µm; these fields are captured in mils
        spec = wo.get("spec") or {}
        if spec.get("surface_profile_min_um") is None:
            return None
        return (round(spec["surface_profile_min_um"] / MILS_TO_UM, 2),
                round(spec["surface_profile_max_um"] / MILS_TO_UM, 2))
    if rng == "dft_window":
        return _dft_limits_for_stage(wo, stage)
    if rng == "wft":
        # WFT window derived from the stage's DFT window and the submitted
        # volume % solids: WFT = DFT / (solids/100). Skipped if solids absent.
        dft = _dft_limits_for_stage(wo, stage)
        try:
            solids = float(values.get("volume_pct_solids"))
        except (TypeError, ValueError):
            return None
        if not dft or solids <= 0:
            return None
        return round(dft[0] * 100 / solids, 1), round(dft[1] * 100 / solids, 1)
    return None


def _validate_stage_fields(wo: dict, stage: dict, values: dict, phase: str = "end",
                           range_context: Optional[dict] = None):
    """Validate submitted values against the stage's field definitions for one
    capture phase ("start" = paint identification at stage start, "end" =
    results at submission; defs without a phase default to "end").

    Returns (missing_keys, errors, hard_block). fail_on values and
    out-of-range numbers produce errors (stage result -> fail); DFT fields
    marked hard_block_max escalate over-max to a submission hard block.
    range_context supplies values from the other phase for derived windows
    (e.g. WFT depends on volume % solids captured at start).
    """
    missing: List[str] = []
    errors: List[str] = []
    hard_block = False
    lookup = {**(range_context or {}), **values}
    for f in stage.get("fields") or []:
        if f.get("phase", "end") != phase:
            continue
        key, ftype = f["key"], f["type"]
        label = f.get("label", key)
        val = values.get(key)
        if val is None or (isinstance(val, str) and not val.strip()):
            if f.get("required"):
                missing.append(key)
            continue
        if ftype in ("number", "decimal"):
            try:
                num = float(val)
            except (TypeError, ValueError):
                errors.append(f"{label}: '{val}' is not a number")
                continue
            window = _field_range(wo, stage, f, lookup)
            if window:
                lo, hi = window
                unit = f.get("unit", "")
                if num < lo:
                    errors.append(f"{label} {num} {unit} below min {lo} {unit}".strip())
                if num > hi:
                    if f.get("hard_block_max"):
                        errors.append(f"{label} {num} {unit} exceeds max {hi} {unit} (hard block)".strip())
                        hard_block = True
                    else:
                        errors.append(f"{label} {num} {unit} exceeds max {hi} {unit}".strip())
        elif ftype == "ok_notok":
            if val not in OK_NOTOK:
                errors.append(f"{label}: must be OK or NOT_OK")
            elif val == f.get("fail_on"):
                errors.append(f"{label}: NOT OK")
        elif ftype == "pass_fail":
            if val not in PASS_FAIL:
                errors.append(f"{label}: must be PASS or FAIL")
            elif val == f.get("fail_on"):
                errors.append(f"{label}: FAIL")
        elif ftype == "date":
            try:
                date.fromisoformat(str(val))
            except ValueError:
                errors.append(f"{label}: invalid date, expected YYYY-MM-DD")
        elif ftype == "date_dmy":
            # strict DD/MM/YYYY: zero-padded, "/" separators, real calendar date
            sval = str(val)
            if not re.fullmatch(r"\d{2}/\d{2}/\d{4}", sval):
                errors.append(f"{label}: invalid date, expected DD/MM/YYYY")
            else:
                try:
                    datetime.strptime(sval, "%d/%m/%Y")
                except ValueError:
                    errors.append(f"{label}: '{sval}' is not a valid calendar date (DD/MM/YYYY)")
        elif ftype == "time":
            try:
                dt_time.fromisoformat(str(val))
            except ValueError:
                errors.append(f"{label}: invalid time, expected HH:MM")
        # text / note / dropdown: presence is the only server-side requirement
    return missing, errors, hard_block


def _paint_system_product_name(row: dict) -> str:
    coats = [row.get("primer_paint_product"), row.get("intermediate_coat_product"), row.get("top_coat_product")]
    chain = " → ".join(c for c in coats if c)
    brand = row.get("paint_brand") or ""
    return f"{brand}: {chain}" if brand and chain else (chain or brand or row.get("specification", ""))


# ---------- data access ----------
def _stage_dict(row) -> dict:
    return {
        "key": row["stage_key"],
        "name": row["name"],
        "description": row["description"],
        "requires_coat_readings": row["requires_coat_readings"],
        "status": row["status"],
        "result": row["result"],
        "submission": row["submission"],
        "submitted_at": _iso(row["submitted_at"]),
        "submitted_by": row["submitted_by"],
        "started_at": _iso(row["started_at"]),
        "started_by": row["started_by"],
        "start_readings": row["start_readings"],
        "params": row["params"],
        "dft_window": row["dft_window"],
        "fields": row["fields"],
        "start_fields": row["start_fields"],
        "start_photos": row["start_photos"],
    }


def _wo_dict(row, stages: List[dict]) -> dict:
    return {
        "id": str(row["id"]),
        "work_order_id": row["work_order_id"],
        "case_type": row["case_type"],
        "po_number": row["po_number"],
        "po_line_item_number": row["po_line_item_number"],
        "customer_name": row["customer_name"],
        "customer_address": row["customer_address"],
        "part_number": row["part_number"],
        "part_revision_number": row["part_revision_number"],
        "part_description": row["part_description"],
        "paint_product_code": row["paint_product_code"],
        "paint_product_name": row["paint_product_name"],
        "coating_spec_revision_number": row["coating_spec_revision_number"],
        "quantity": row["quantity"],
        "serial_range": row["serial_range"],
        "priority": row["priority"],
        "spec": {
            "surface_profile_min_um": float(row["surface_profile_min_um"]),
            "surface_profile_max_um": float(row["surface_profile_max_um"]),
            "dft_min_um": float(row["dft_min_um"]),
            "dft_max_um": float(row["dft_max_um"]),
            "soluble_salts_max_mg_m2": float(row["soluble_salts_max_mg_m2"]) if row["soluble_salts_max_mg_m2"] is not None else None,
        },
        "coat_limits": row["coat_limits"],
        "paint_system_id": str(row["paint_system_id"]) if row["paint_system_id"] else None,
        "created_at": _iso(row["created_at"]),
        "created_by": row["created_by"],
        "stages": stages,
    }


async def _fetch_work_orders(conn, work_order_id: Optional[str] = None, limit: int = 200) -> List[dict]:
    """Work orders with their ordered stage lists, shaped like the API expects."""
    if work_order_id:
        wo_rows = await conn.fetch("select * from work_orders where work_order_id = $1", work_order_id)
    else:
        wo_rows = await conn.fetch("select * from work_orders order by priority desc, work_order_id limit $1", limit)
    if not wo_rows:
        return []
    ids = [r["id"] for r in wo_rows]
    stage_rows = await conn.fetch(
        "select * from work_order_stages where work_order_id = any($1::uuid[]) order by stage_order",
        ids,
    )
    by_wo: dict = {}
    for s in stage_rows:
        by_wo.setdefault(s["work_order_id"], []).append(_stage_dict(s))
    return [_wo_dict(r, by_wo.get(r["id"], [])) for r in wo_rows]


# ---------- seed ----------
async def seed_data():
    assert pool is not None
    async with pool.acquire() as conn:
        if await conn.fetchval("select count(*) from inspectors") == 0:
            inspectors = [
                ("QC-7742", "Thompson, J.", "j.thompson@aerospace-precision.com", "Lead Inspector",
                 "Alpha - Section 4", "Surface Coating & Prep",
                 "https://images.pexels.com/photos/10816007/pexels-photo-10816007.jpeg"),
                ("QC-7841", "Reyes, M.", "m.reyes@aerospace-precision.com", "Inspector",
                 "Bravo - Section 2", "Surface Coating & Prep",
                 "https://images.pexels.com/photos/29852895/pexels-photo-29852895.jpeg"),
            ]
            for emp, name, email, role, shift, dept, avatar in inspectors:
                await conn.execute(
                    """insert into inspectors (employee_id, name, email, password_hash, role, shift, department, avatar_url)
                       values ($1,$2,$3,$4,$5,$6,$7,$8)""",
                    emp, name, email, pwd_ctx.hash("Inspector@123"), role, shift, dept, avatar,
                )

        # Demo work orders and mock quota are intentionally NOT seeded — the
        # database holds real work orders only. Inspector accounts above are
        # kept so a fresh environment is still log-in-able.


async def _init_conn(conn):
    for typ in ("json", "jsonb"):
        await conn.set_type_codec(typ, encoder=json.dumps, decoder=json.loads, schema="pg_catalog")


@asynccontextmanager
async def lifespan(_: FastAPI):
    global pool
    pool = await asyncpg.create_pool(DATABASE_URL, min_size=1, max_size=5, init=_init_conn)
    await seed_data()
    yield
    await pool.close()


# ---------- app ----------
app = FastAPI(lifespan=lifespan, title="Coating Portal API")
api = APIRouter(prefix="/api")


@api.get("/")
async def root():
    return {"name": "Coating Portal API", "ok": True}


# auth
@api.post("/auth/login", response_model=LoginResponse)
async def login(req: LoginRequest):
    assert pool is not None
    row = await pool.fetchrow("select * from inspectors where email = $1", req.email.lower())
    if not row or not pwd_ctx.verify(req.password, row["password_hash"]):
        raise HTTPException(status_code=401, detail="Invalid credentials")
    user = _inspector_public(row)
    token = make_token(user)
    await write_audit("-", None, user, "login", f"Inspector {user['employee_id']} signed in")
    return {"access_token": token, "token_type": "bearer", "user": user}


@api.get("/auth/me", response_model=InspectorOut)
async def me(current=Depends(get_current_user)):
    return InspectorOut(**current)


# work orders
@api.get("/work-orders", response_model=List[WorkOrderSummary])
async def list_work_orders(
    q: Optional[str] = None,
    filter: Optional[str] = None,  # "all" | "priority" | "pending"
    _=Depends(get_current_user),
):
    assert pool is not None
    async with pool.acquire() as conn:
        wos = await _fetch_work_orders(conn)
    items: List[WorkOrderSummary] = []
    for wo in wos:
        done, overall = stage_progress(wo["stages"])
        if filter == "priority" and not wo.get("priority"):
            continue
        if filter == "pending" and overall == "done":
            continue
        if q:
            needle = q.lower()
            hay = " ".join([wo["work_order_id"], wo["customer_name"], wo["paint_product_code"], wo["part_description"]]).lower()
            if needle not in hay:
                continue
        items.append(WorkOrderSummary(
            work_order_id=wo["work_order_id"],
            case_type=wo["case_type"],
            customer_name=wo["customer_name"],
            paint_product_code=wo["paint_product_code"],
            paint_product_name=wo["paint_product_name"],
            part_description=wo["part_description"],
            quantity=wo["quantity"],
            serial_range=wo["serial_range"],
            priority=wo.get("priority", False),
            progress=done,
            total_stages=len(wo["stages"]),
            overall_status=overall,
        ))
    items.sort(key=lambda x: (not x.priority, x.work_order_id))
    return items


# ---- case types (used by the New Work Order form picker) ----
@api.get("/case-types")
async def list_case_types(_=Depends(get_current_user)):
    """The four case types with their stage sequences, from the template table."""
    assert pool is not None
    rows = await pool.fetch(
        """select case_type, stage_key, stage_order, name, description,
                  requires_coat_readings, params, dft_window, fields
           from case_type_stage_templates order by case_type, stage_order"""
    )
    grouped: dict = {}
    for r in rows:
        grouped.setdefault(r["case_type"], []).append({
            "key": r["stage_key"],
            "order": r["stage_order"],
            "name": r["name"],
            "description": r["description"],
            "requires_coat_readings": r["requires_coat_readings"],
            "params": r["params"],
            "dft_window": r["dft_window"],
            "fields": r["fields"],
        })
    return [{"case_type": ct, "stages": stages} for ct, stages in grouped.items()]


# ---- paint options (feeds stage-form dropdowns) ----
@api.get("/paint-options")
async def paint_options(_=Depends(get_current_user)):
    """Dropdown options for stage forms.

    Brands/products/shades come from the normalized lookup tables
    (paint_products / paint_shades, deduped in migration 0007); RAL from the
    seeded RAL Classic chart; operators from the operators table. Colors stay
    derived from the spec sheet (no lookup table exists for them yet).
    RAL <-> paint-shade auto-matching is deliberately NOT provided — the two
    dropdowns are independent until official manufacturer equivalence data
    exists.
    """
    assert pool is not None
    brands = [r["supplier_name"] for r in
              await pool.fetch("select supplier_name from approved_paint_suppliers order by 1")]

    products: dict = {b: {"primer": [], "intermediate": [], "top": []} for b in brands}
    for r in await pool.fetch("select brand, product_name, coat_roles from paint_products order by brand, product_name"):
        for role in r["coat_roles"]:
            if r["brand"] in products and role in products[r["brand"]]:
                products[r["brand"]][role].append(r["product_name"])

    shades: dict = {}
    for r in await pool.fetch(
        """select pp.brand, pp.product_name, ps.shade_name
           from paint_shades ps join paint_products pp on pp.id = ps.product_id
           order by pp.brand, pp.product_name, ps.shade_name"""
    ):
        shades.setdefault(f"{r['brand']}::{r['product_name']}", []).append(r["shade_name"])

    color_rows = await pool.fetch(
        """select distinct c from (
             select primer_coat_color as c from paint_system_specifications
             union select intermediate_coat_color from paint_system_specifications
           ) t where c is not null order by 1"""
    )

    ral = [f"{r['ral_number']} · {r['colour_name']}" for r in
           await pool.fetch("select ral_number, colour_name from ral_shades order by ral_number")]

    operators = [{"name": r["name"], "designation": r["designation"]} for r in
                 await pool.fetch("select name, designation from operators where active order by name")]

    return {
        "brands": brands,
        "products": products,          # products[brand][primer|intermediate|top]
        "colors": [r["c"] for r in color_rows],
        "shades": shades,              # keyed "BRAND::PRODUCT"
        "ral": ral,                    # "RAL 3001 · Signal red" (217 rows)
        "operators": operators,        # [{name, designation}]
        "operator_designations": sorted({o["designation"] for o in operators}),
        "shifts": ["First Shift", "Second Shift"],
    }


# ---- coating specs (used by the New Work Order form) ----
@api.get("/coating-specifications", response_model=List[PaintSystemSpec])
async def list_coating_specs(_=Depends(get_current_user)):
    """paint_system_specifications rows imported from MVG040014N.xlsx.

    `specification` codes are not unique (one code can have several
    system/paint-brand rows) — rows are picked by uuid in the WO form.
    """
    assert pool is not None
    rows = await pool.fetch("select * from paint_system_specifications order by specification, system_number, paint_brand")
    return [PaintSystemSpec(**{**dict(r), "id": str(r["id"])}) for r in rows]


async def _next_wo_id(conn) -> str:
    """Atomically generate the next WO-YYYY-NNNN id for the current year."""
    year = datetime.now(timezone.utc).year
    seq = await conn.fetchval(
        """insert into wo_counters (year, seq) values ($1, 1)
           on conflict (year) do update set seq = wo_counters.seq + 1
           returning seq""",
        year,
    )
    return f"WO-{year}-{seq:04d}"


@api.post("/work-orders", response_model=WorkOrderSummary, status_code=201)
async def create_work_order(body: CreateWorkOrderRequest, current=Depends(get_current_user)):
    assert pool is not None
    async with pool.acquire() as conn:
        ps_row = await conn.fetchrow(
            "select * from paint_system_specifications where id = $1::uuid", body.paint_system_id
        )
        if not ps_row:
            raise HTTPException(400, f"Unknown paint system id '{body.paint_system_id}'")
        ps = dict(ps_row)
        spec_name = _paint_system_product_name(ps)
        spec_limits = _spec_from_paint_system_row(ps)
        coat_limits = _coat_limits_from_paint_system_row(ps)

        # duplicate guard: same PO + line item + part + revision = likely the same job
        if not body.confirm_duplicate:
            dup = await conn.fetchrow(
                """select * from work_orders
                   where po_number = $1 and po_line_item_number = $2
                     and part_number = $3 and part_revision_number = $4""",
                body.po_number, body.po_line_item_number, body.part_number, body.part_revision_number,
            )
            if dup:
                dup_stages = await conn.fetch(
                    "select * from work_order_stages where work_order_id = $1 order by stage_order", dup["id"]
                )
                done, overall = stage_progress([_stage_dict(s) for s in dup_stages])
                await write_audit(
                    dup["work_order_id"], None, current, "work_order_duplicate_warned",
                    f"Inspector {current['employee_id']} attempted to create a duplicate WO for "
                    f"PO {body.po_number} line {body.po_line_item_number} part {body.part_number} rev {body.part_revision_number}",
                )
                raise HTTPException(
                    status_code=409,
                    detail={
                        "duplicate": True,
                        "message": "A work order already exists for this PO line + part + revision.",
                        "existing": {
                            "work_order_id": dup["work_order_id"],
                            "customer_name": dup["customer_name"],
                            "paint_product_code": dup["paint_product_code"],
                            "quantity": dup["quantity"],
                            "created_at": _iso(dup["created_at"]),
                            "created_by": dup["created_by"],
                            "overall_status": overall,
                            "progress": done,
                        },
                    },
                )

        part_description = f"{body.part_number} Rev {body.part_revision_number}"
        serial_range = f"{body.part_number}-001 → {body.part_number}-{body.quantity:03d}"

        # stage scaffold comes from the case type's template rows
        templates = await conn.fetch(
            "select * from case_type_stage_templates where case_type = $1 order by stage_order",
            body.case_type,
        )
        if not templates:
            raise HTTPException(500, f"No stage templates defined for case type '{body.case_type}'")

        async with conn.transaction():
            work_order_id = await _next_wo_id(conn)
            row_id = await conn.fetchval(
                """insert into work_orders
                     (work_order_id, case_type, po_number, po_line_item_number, customer_name, customer_address,
                      part_number, part_revision_number, part_description,
                      paint_product_code, paint_product_name, coating_spec_revision_number,
                      quantity, serial_range, priority,
                      surface_profile_min_um, surface_profile_max_um, dft_min_um, dft_max_um, soluble_salts_max_mg_m2,
                      coat_limits, paint_system_id, created_by)
                   values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22::uuid,$23)
                   returning id""",
                work_order_id, body.case_type, body.po_number, body.po_line_item_number, body.customer_name,
                body.customer_address or "", body.part_number, body.part_revision_number, part_description,
                body.coating_spec_code, spec_name, body.coating_spec_revision_number,
                body.quantity, serial_range, False,
                spec_limits["surface_profile_min_um"], spec_limits["surface_profile_max_um"],
                spec_limits["dft_min_um"], spec_limits["dft_max_um"], spec_limits["soluble_salts_max_mg_m2"],
                coat_limits, body.paint_system_id, current["employee_id"],
            )
            for t in templates:
                await conn.execute(
                    """insert into work_order_stages
                         (work_order_id, stage_key, stage_order, name, description,
                          requires_coat_readings, params, dft_window, fields)
                       values ($1,$2,$3,$4,$5,$6,$7,$8,$9)""",
                    row_id, t["stage_key"], t["stage_order"], t["name"], t["description"],
                    t["requires_coat_readings"], t["params"], t["dft_window"], t["fields"],
                )

    await write_audit(work_order_id, None, current, "work_order_created",
                      f"WO {work_order_id} created for {body.customer_name} / {body.po_number} line {body.po_line_item_number}")

    return WorkOrderSummary(
        work_order_id=work_order_id,
        case_type=body.case_type,
        customer_name=body.customer_name,
        paint_product_code=body.coating_spec_code,
        paint_product_name=spec_name,
        part_description=part_description,
        quantity=body.quantity,
        serial_range=serial_range,
        priority=False,
        progress=0,
        total_stages=len(templates),
        overall_status="pending",
    )


@api.get("/work-orders/{work_order_id}", response_model=WorkOrderDetail)
async def get_work_order(work_order_id: str, _=Depends(get_current_user)):
    assert pool is not None
    async with pool.acquire() as conn:
        wos = await _fetch_work_orders(conn, work_order_id)
    if not wos:
        raise HTTPException(404, "Work order not found")
    wo = wos[0]
    done, overall = stage_progress(wo["stages"])
    return WorkOrderDetail(
        work_order_id=wo["work_order_id"],
        case_type=wo["case_type"],
        po_number=wo["po_number"],
        customer_name=wo["customer_name"],
        paint_product_code=wo["paint_product_code"],
        paint_product_name=wo["paint_product_name"],
        part_description=wo["part_description"],
        quantity=wo["quantity"],
        serial_range=wo["serial_range"],
        priority=wo["priority"],
        progress=done,
        total_stages=len(wo["stages"]),
        overall_status=overall,
        spec=PaintSpec(**wo["spec"]),
        coat_limits=wo["coat_limits"],
        stages=wo["stages"],
    )


@api.post("/work-orders/{work_order_id}/stages/{stage_key}/start")
async def start_stage(
    work_order_id: str,
    stage_key: str,
    body: StageStartRequest,
    current=Depends(get_current_user),
):
    """Record start-of-stage readings as their own submission; the stage goes
    in_progress and the final submit later only needs end readings + parameters.

    Which stages exist depends on the work order's case type, so validity is
    checked against this WO's own stage rows, not a global list."""
    assert pool is not None
    async with pool.acquire() as conn:
        wo_row = await conn.fetchrow("select id from work_orders where work_order_id = $1", work_order_id)
        if not wo_row:
            raise HTTPException(404, "Work order not found")
        stage = await conn.fetchrow(
            "select * from work_order_stages where work_order_id = $1 and stage_key = $2",
            wo_row["id"], stage_key,
        )
        if not stage:
            raise HTTPException(404, f"Stage '{stage_key}' does not exist on this work order")
        if stage["status"] in ("done", "fail"):
            raise HTTPException(409, f"Stage '{stage_key}' already completed")
        if stage["started_at"]:
            raise HTTPException(409, f"Stage '{stage_key}' already started at {_iso(stage['started_at'])}")

        # surface-temperature gate at start of stage (coat stages only):
        # too-hot (>60°C) and dew-point proximity block the start, each with
        # its specific reason
        if stage["requires_coat_readings"]:
            gate = _gate_errors(body.readings, "start")
            if gate:
                raise HTTPException(status_code=422, detail={"gate_failed": True, "errors": gate})

        # start-phase fields (paint identification / operator / batch+expiry):
        # required ones must be present and valid before work begins
        wos = await _fetch_work_orders(conn, work_order_id)
        stage_dict = next(s for s in wos[0]["stages"] if s["key"] == stage_key)
        missing, errors, _ = _validate_stage_fields(wos[0], stage_dict, body.fields or {}, phase="start")
        if missing:
            raise HTTPException(400, f"Missing required start-of-stage fields for '{stage_key}': {', '.join(missing)}")
        if errors:
            raise HTTPException(status_code=422, detail={"start_fields_invalid": True, "errors": errors})

        started_at = datetime.now(timezone.utc)
        await conn.execute(
            """update work_order_stages
               set status = 'in_progress', started_at = $3, started_by = $4, start_readings = $5,
                   start_fields = $6, start_photos = $7
               where work_order_id = $1 and stage_key = $2""",
            wo_row["id"], stage_key, started_at, current["employee_id"], body.readings.model_dump(),
            body.fields or {}, (body.photos or [])[:5],
        )
    await write_audit(work_order_id, stage_key, current, "stage_started",
                      f"Stage '{stage_key}' started by {current['employee_id']}")
    return {"ok": True, "stage_key": stage_key, "work_order_id": work_order_id, "started_at": _iso(started_at)}


@api.post("/work-orders/{work_order_id}/stages/{stage_key}/submit")
async def submit_stage(
    work_order_id: str,
    stage_key: str,
    body: StageSubmission,
    current=Depends(get_current_user),
):
    assert pool is not None
    async with pool.acquire() as conn:
        wos = await _fetch_work_orders(conn, work_order_id)
        if not wos:
            raise HTTPException(404, "Work order not found")
        wo = wos[0]
        stage = next((s for s in wo["stages"] if s["key"] == stage_key), None)
        if stage is None:
            raise HTTPException(404, f"Stage '{stage_key}' does not exist on this work order")

        # ---- server-side validation from the stage's field definitions ----
        # end-phase only; start-phase values were validated and stored at /start
        # (they also feed derived ranges, e.g. WFT needs start-phase % solids)
        values = body.fields or {}
        start_values = stage.get("start_fields") or {}
        missing, errors, hard_block = _validate_stage_fields(
            wo, stage, values, phase="end", range_context=start_values)
        if missing:
            raise HTTPException(400, f"Missing required fields for stage '{stage_key}': {', '.join(missing)}")

        # surface-temperature gate on END readings, distinct reason per mode
        end = body.readings.end
        gate_errs = _gate_errors(end, "end")
        gate_ok = not gate_errs
        errors.extend(gate_errs)

        # Hard-block on DFT-max regardless of submitted result
        if hard_block:
            await write_audit(work_order_id, stage_key, current, "stage_submit_blocked",
                              f"Hard-block: {'; '.join(errors)}")
            raise HTTPException(status_code=422, detail={"hard_block": True, "errors": errors})

        result = body.result if not errors else "fail"

        # two-step flow: server-stored start readings win; body.start accepted
        # for single-shot submissions on never-started stages.
        start_readings = stage.get("start_readings") or (
            body.readings.start.model_dump() if body.readings.start else None
        )
        submitted_at = datetime.now(timezone.utc)
        submission = {
            "readings": {"start": start_readings, "end": end.model_dump()},
            # full record: start-phase identification + end-phase results
            "fields": {**start_values, **values},
            "start_photos": stage.get("start_photos") or [],
            "notes": body.notes or "",
            "photos": body.photos[:5],
            "result": result,
            "errors": errors,
            "gate_ok": gate_ok,
            "submitted_by": current["employee_id"],
            "submitted_at": _iso(submitted_at),
        }

        async with conn.transaction():
            await conn.execute(
                """update work_order_stages
                   set status = $3, result = $4, submission = $5, submitted_at = $6, submitted_by = $7
                   where work_order_id = $1::uuid and stage_key = $2""",
                wo["id"], stage_key,
                "done" if result == "pass" else "fail", result, submission, submitted_at, current["employee_id"],
            )
            if result == "pass":
                await conn.execute(
                    """insert into quota (date, completed, target) values (current_date, 1, 25)
                       on conflict (date) do update set completed = quota.completed + 1"""
                )

    measured = ", ".join(f"{k}={v}" for k, v in values.items()) if values else "observational"
    await write_audit(work_order_id, stage_key, current, "stage_submit",
                      f"Stage '{stage_key}' submitted with result={result}. {measured}")

    return {"ok": True, "result": result, "errors": errors, "stage_key": stage_key,
            "work_order_id": work_order_id, "submitted_at": _iso(submitted_at)}


@api.get("/work-orders/{work_order_id}/audit-log", response_model=List[AuditEntry])
async def audit_log(work_order_id: str, _=Depends(get_current_user)):
    assert pool is not None
    rows = await pool.fetch(
        'select * from audit_log where work_order_id = $1 order by "timestamp" desc', work_order_id
    )
    return [
        AuditEntry(
            id=str(r["id"]), work_order_id=r["work_order_id"], stage_key=r["stage_key"],
            actor_employee_id=r["actor_employee_id"], actor_name=r["actor_name"],
            action=r["action"], detail=r["detail"] or "", timestamp=_iso(r["timestamp"]) or "",
        )
        for r in rows
    ]


# history
@api.get("/inspections/history", response_model=List[HistoryItem])
async def history(current=Depends(get_current_user)):
    assert pool is not None
    rows = await pool.fetch(
        """select w.work_order_id, w.customer_name, s.stage_key, s.name, s.result, s.submitted_at, s.submitted_by
           from work_order_stages s join work_orders w on w.id = s.work_order_id
           where s.submitted_at is not null
           order by s.submitted_at desc limit 200"""
    )
    return [
        HistoryItem(
            work_order_id=r["work_order_id"], customer_name=r["customer_name"],
            stage_key=r["stage_key"], stage_name=r["name"],
            result=r["result"] or "pending", timestamp=_iso(r["submitted_at"]) or "",
            inspector_name=r["submitted_by"] or "",
        )
        for r in rows
    ]


# weather (auto-pulled). Mocked but realistic. If OPENWEATHER_API_KEY is set later,
# wire to real API here.
@api.get("/weather")
async def weather(_=Depends(get_current_user)):
    # realistic plant-floor ambient conditions
    ambient = round(random.uniform(20, 26), 1)
    rh = round(random.uniform(40, 55), 1)
    # dew point approximation (Magnus simple)
    import math
    a, b = 17.625, 243.04
    gamma = (a * ambient) / (b + ambient) + math.log(max(rh, 1) / 100.0)
    dew = round((b * gamma) / (a - gamma), 1)
    return {
        "ambient_temp_c": ambient,
        "relative_humidity_pct": rh,
        "dew_point_c": dew,
        "source": "mock",
        "fetched_at": now_iso(),
    }


# dashboard
@api.get("/dashboard")
async def dashboard(current=Depends(get_current_user)):
    assert pool is not None
    async with pool.acquire() as conn:
        quota_row = await conn.fetchrow("select completed, target from quota where date = current_date")
        wos = await _fetch_work_orders(conn, limit=50)
    quota = dict(quota_row) if quota_row else {"completed": 0, "target": 25}

    current_wo = None
    for wo in wos:
        done, overall = stage_progress(wo["stages"])
        if overall != "done":
            current_wo = {
                "work_order_id": wo["work_order_id"],
                "customer_name": wo["customer_name"],
                "part_description": wo["part_description"],
                "paint_product_code": wo["paint_product_code"],
                "priority": wo["priority"],
                "progress": done,
                "overall_status": overall,
                "stages": wo["stages"],
            }
            break

    return {
        "quota": quota,
        "shift": {
            "code": current.get("shift", "Alpha - Section 4"),
            "lead": current.get("name", ""),
        },
        "system_status": "SYNCED",
        "last_sync": now_iso(),
        "current_assignment": current_wo,
    }


# ---------- reports & distribution ----------
class RecipientIn(BaseModel):
    name: str = Field(..., min_length=1)
    email: EmailStr

class SendReportRequest(BaseModel):
    recipients: List[EmailStr] = Field(..., min_length=1)
    formats: List[Literal["pdf", "xlsx"]] = Field(default_factory=lambda: ["pdf"])
    message: Optional[str] = ""

class GenerateReportRequest(BaseModel):
    # empty recipients = generate + store only, no email
    recipients: List[EmailStr] = Field(default_factory=list)
    message: Optional[str] = ""


def _attachment_media(filename: str) -> str:
    return "application/pdf" if filename.endswith(".pdf") else \
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"


# Resend sandbox sender — replace with a verified-domain address once one exists
RESEND_FROM = "onboarding@resend.dev"


async def _send_email_with_attachments(subject: str, body_text: str,
                                       recipients: List[str],
                                       attachments: List[tuple[str, bytes]]):
    """Send via the Resend HTTPS API; raises HTTPException on failure.

    Railway blocks outbound SMTP on the current plan ([Errno 101] on 465/587),
    so Gmail/smtplib is not usable in production."""
    api_key = os.environ.get("RESEND_API_KEY", "")
    if not api_key:
        raise HTTPException(503, "Email not configured: set RESEND_API_KEY in backend/.env")

    params: resend.Emails.SendParams = {
        "from": RESEND_FROM,
        "to": recipients,
        "subject": subject,
        "text": body_text,
        "attachments": [
            {"filename": filename, "content": list(content),
             "content_type": _attachment_media(filename)}
            for filename, content in attachments
        ],
    }

    def _send():
        resend.api_key = api_key
        resend.Emails.send(params)

    try:
        await asyncio.get_running_loop().run_in_executor(None, _send)
    except resend.exceptions.InvalidApiKeyError:
        raise HTTPException(502, "Resend rejected the API key (check RESEND_API_KEY)")
    except resend.exceptions.ResendError as e:
        raise HTTPException(502, f"Email send failed: {e}")
    except (requests.RequestException, OSError) as e:
        raise HTTPException(502, f"Email send failed: {e}")


CLOUDCONVERT_API = "https://api.cloudconvert.com/v2"


def _convert_xlsx_to_pdf(xlsx_path: str) -> bytes:
    """Blocking xlsx→pdf via the CloudConvert API — call via run_in_executor.

    Cloud conversion (upload → convert → export/url job) so PDF generation
    needs no system-level application on the host (Railway can't reliably
    install LibreOffice). The rendered layout is CloudConvert's LibreOffice
    engine, matching the previous local-soffice output."""
    api_key = os.environ.get("CLOUDCONVERT_API_KEY", "")
    print(f"[CLOUDCONVERT DEBUG] key present: {bool(api_key)}, length: {len(api_key)}, "
          f"preview: {api_key[:4]}...{api_key[-4:] if len(api_key) > 8 else 'TOO_SHORT'}",
          flush=True)
    if not api_key:
        raise RuntimeError("CLOUDCONVERT_API_KEY not set — required for xlsx→pdf conversion")
    headers = {"Authorization": f"Bearer {api_key}"}

    def _fail(step: str, resp) -> RuntimeError:
        return RuntimeError(f"CloudConvert {step} failed: HTTP {resp.status_code} {resp.text[:300]}")

    try:
        resp = requests.post(f"{CLOUDCONVERT_API}/jobs", headers=headers, timeout=30, json={
            "tasks": {
                "upload": {"operation": "import/upload"},
                "convert": {"operation": "convert", "input": "upload",
                            "input_format": "xlsx", "output_format": "pdf"},
                "export": {"operation": "export/url", "input": "convert"},
            },
        })
        print(f"[CLOUDCONVERT DEBUG] job create: HTTP {resp.status_code}", flush=True)
        if resp.status_code not in (200, 201):
            print(f"[CLOUDCONVERT DEBUG] job create error body: {resp.text}", flush=True)
            raise _fail("job create", resp)
        job = resp.json()["data"]

        upload = next(t for t in job["tasks"] if t["name"] == "upload")
        form = upload["result"]["form"]
        with open(xlsx_path, "rb") as fh:
            up = requests.post(form["url"], data=form["parameters"],
                               files={"file": (os.path.basename(xlsx_path), fh)}, timeout=120)
        print(f"[CLOUDCONVERT DEBUG] file upload: HTTP {up.status_code}", flush=True)
        if up.status_code not in (200, 201):
            print(f"[CLOUDCONVERT DEBUG] file upload error body: {up.text}", flush=True)
            raise _fail("file upload", up)

        deadline = time.monotonic() + 180
        while True:
            resp = requests.get(f"{CLOUDCONVERT_API}/jobs/{job['id']}", headers=headers, timeout=30)
            if resp.status_code != 200:
                print(f"[CLOUDCONVERT DEBUG] status poll: HTTP {resp.status_code} body: {resp.text}",
                      flush=True)
                raise _fail("status poll", resp)
            job = resp.json()["data"]
            print(f"[CLOUDCONVERT DEBUG] poll: job {job['id']} status={job['status']} "
                  f"tasks={[(t['name'], t['status']) for t in job['tasks']]}", flush=True)
            if job["status"] == "finished":
                break
            if job["status"] == "error":
                print(f"[CLOUDCONVERT DEBUG] job error body: {resp.text}", flush=True)
                errs = "; ".join(f"{t['name']}: {t.get('message') or 'error'}"
                                 for t in job["tasks"] if t["status"] == "error")
                raise RuntimeError(f"CloudConvert conversion failed: {errs or 'unknown error'}")
            if time.monotonic() > deadline:
                raise RuntimeError("CloudConvert conversion timed out after 180s")
            time.sleep(2)

        export = next(t for t in job["tasks"] if t["name"] == "export")
        dl = requests.get(export["result"]["files"][0]["url"], timeout=120)
        if dl.status_code != 200 or not dl.content.startswith(b"%PDF"):
            raise _fail("result download", dl)
        return dl.content
    except requests.RequestException as e:
        raise RuntimeError(f"CloudConvert request failed: {e}")


@api.get("/report-recipients")
async def list_recipients(_=Depends(get_current_user)):
    assert pool is not None
    rows = await pool.fetch("select id, name, email from report_recipients order by name")
    return [{"id": str(r["id"]), "name": r["name"], "email": r["email"]} for r in rows]


@api.post("/report-recipients", status_code=201)
async def add_recipient(body: RecipientIn, _=Depends(get_current_user)):
    assert pool is not None
    row = await pool.fetchrow(
        """insert into report_recipients (name, email) values ($1, $2)
           on conflict (email) do update set name = excluded.name
           returning id, name, email""",
        body.name, body.email.lower(),
    )
    return {"id": str(row["id"]), "name": row["name"], "email": row["email"]}


async def _build_report(conn, work_order_id: str, fmt: str, actor: dict) -> tuple[str, bytes]:
    """Generate a report, persist a cloud-backed copy, return (filename, bytes)."""
    wos = await _fetch_work_orders(conn, work_order_id)
    if not wos:
        raise HTTPException(404, "Work order not found")
    wo = wos[0]
    company_row = await conn.fetchrow(
        "select company_name, logo_url from spec_company_logos where specification = $1",
        wo["paint_product_code"],
    )
    data = report_gen.collect_report_data(wo, dict(company_row) if company_row else None)
    content = report_gen.generate_pdf(data) if fmt == "pdf" else report_gen.generate_xlsx(data)
    filename = f"paint-report-{work_order_id}.{fmt}"
    await conn.execute(
        """insert into generated_reports (work_order_id, format, filename, content, created_by)
           values ($1, $2, $3, $4, $5)""",
        work_order_id, fmt, filename, content, actor["employee_id"],
    )
    return filename, content


@api.get("/work-orders/{work_order_id}/report")
async def download_report(work_order_id: str, format: Literal["pdf", "xlsx"] = "pdf",
                          current=Depends(get_current_user)):
    assert pool is not None
    async with pool.acquire() as conn:
        filename, content = await _build_report(conn, work_order_id, format, current)
    await write_audit(work_order_id, None, current, "report_generated", f"{format.upper()} report generated")
    media = "application/pdf" if format == "pdf" else \
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    return Response(content=content, media_type=media,
                    headers={"Content-Disposition": f'attachment; filename="{filename}"'})


@api.post("/work-orders/{work_order_id}/report/send")
async def send_report(work_order_id: str, body: SendReportRequest, current=Depends(get_current_user)):
    # config guard up front — don't build reports that can't be sent
    if not os.environ.get("RESEND_API_KEY"):
        raise HTTPException(503, "Email not configured: set RESEND_API_KEY in backend/.env")
    assert pool is not None
    async with pool.acquire() as conn:
        attachments = [await _build_report(conn, work_order_id, fmt, current) for fmt in body.formats]

    await _send_email_with_attachments(
        f"Final Paint Report — {work_order_id}",
        body.message or f"Please find attached the final paint report for {work_order_id}.",
        body.recipients, attachments,
    )
    await write_audit(work_order_id, None, current, "report_sent",
                      f"Report ({', '.join(body.formats)}) emailed to {', '.join(body.recipients)}")
    return {"ok": True, "sent_to": body.recipients, "formats": body.formats}


# ---- NOV template report (fill_nov_report.py + LibreOffice PDF) ----
@api.post("/work-orders/{work_order_id}/generate-report")
async def generate_nov_report(work_order_id: str, body: GenerateReportRequest,
                              current=Depends(get_current_user)):
    """Fill the NOV 2-coat IR xlsx template from the work order's captured data,
    convert to PDF, store both, and optionally email the PDF to recipients.
    Each new recipient email is remembered for autocomplete (report_recipients)."""
    assert pool is not None
    async with pool.acquire() as conn:
        wos = await _fetch_work_orders(conn, work_order_id)
        if not wos:
            raise HTTPException(404, "Work order not found")
        wo = wos[0]
        ps = None
        if wo.get("paint_system_id"):
            ps = await conn.fetchrow(
                "select * from paint_system_specifications where id = $1::uuid", wo["paint_system_id"])
        names = {r["employee_id"]: r["name"] for r in
                 await conn.fetch("select employee_id, name from inspectors")}

        payload = build_nov_payload(wo, dict(ps) if ps else None, names, current["name"])
        with tempfile.TemporaryDirectory(prefix="nov-report-") as tmp:
            xlsx_path = fill_nov_report(payload, out_dir=tmp, filename=f"NOV_IR_{work_order_id}.xlsx")
            with open(xlsx_path, "rb") as fh:
                xlsx_bytes = fh.read()
            try:
                pdf_bytes = await asyncio.get_running_loop().run_in_executor(
                    None, _convert_xlsx_to_pdf, xlsx_path)
            except RuntimeError as e:
                raise HTTPException(500, str(e))

        pdf_name = f"NOV_IR_{work_order_id}.pdf"
        report_ids = {}
        for fmt, fname, content in (("xlsx", f"NOV_IR_{work_order_id}.xlsx", xlsx_bytes),
                                    ("pdf", pdf_name, pdf_bytes)):
            report_ids[fmt] = await conn.fetchval(
                """insert into generated_reports (work_order_id, format, filename, content, created_by)
                   values ($1, $2, $3, $4, $5) returning id""",
                work_order_id, fmt, fname, content, current["employee_id"],
            )

        # remember recipients on first use (feeds the autocomplete)
        for email in {str(e).lower() for e in body.recipients}:
            await conn.execute(
                "insert into report_recipients (name, email) values ('', $1) on conflict (email) do nothing",
                email,
            )

    # email failure is non-fatal: the report is already generated and stored,
    # so the download URLs are still returned alongside the error
    email_sent, email_error = False, None
    if body.recipients:
        try:
            await _send_email_with_attachments(
                f"NOV Final Paint Report — {work_order_id}",
                body.message or f"Please find attached the NOV final paint report for {work_order_id}.",
                body.recipients, [(pdf_name, pdf_bytes)],
            )
            email_sent = True
        except HTTPException as e:
            email_error = str(e.detail)

    detail = "NOV report generated (xlsx+pdf)" + \
        (f", PDF emailed to {', '.join(body.recipients)}" if email_sent else "")
    await write_audit(work_order_id, None, current, "nov_report_generated", detail)
    return {
        "ok": True,
        "filename": pdf_name,
        "download_url": f"/api/reports/{report_ids['pdf']}",
        "xlsx_download_url": f"/api/reports/{report_ids['xlsx']}",
        "email_sent": email_sent,
        "email_error": email_error,
        "sent_to": [str(e) for e in body.recipients] if email_sent else [],
    }


@api.get("/reports/{report_id}")
async def download_generated_report(report_id: str, token: Optional[str] = None,
                                    creds: Optional[HTTPAuthorizationCredentials] = Depends(bearer)):
    """Download a stored generated report. Accepts the JWT either as a Bearer
    header or a ?token= query param (so mobile can open the URL in a browser)."""
    raw = creds.credentials if creds else token
    if not raw:
        raise HTTPException(status_code=401, detail="Missing auth token")
    try:
        jwt.decode(raw, JWT_SECRET, algorithms=[JWT_ALG])
    except jwt.PyJWTError:
        raise HTTPException(status_code=401, detail="Invalid or expired token")
    assert pool is not None
    row = await pool.fetchrow(
        "select filename, format, content from generated_reports where id::text = $1", report_id)
    if not row:
        raise HTTPException(404, "Report not found")
    media = "application/pdf" if row["format"] == "pdf" else \
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    return Response(content=row["content"], media_type=media,
                    headers={"Content-Disposition": f'attachment; filename="{row["filename"]}"'})


app.include_router(api)
app.add_middleware(
    CORSMiddleware,
    allow_credentials=True,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(name)s - %(levelname)s - %(message)s")
logger = logging.getLogger("coating-portal")
