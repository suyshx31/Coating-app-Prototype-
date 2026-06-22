"""Coating Portal backend — FastAPI + MongoDB.

Implements the domain model from the spec:
- purchase_order / purchase_order_line (work order, fixed WO-YYYY-NNNN id)
- operator (inspector), paint_product, paint_specification, gauge
- Inspection / InspectionStage (6 stages)
- WeatherReading (API-sourced) + SurfaceTemperatureReading (manual Elcometer)
  captured as a start/end pair per coat-stage
- MeasuredParameter (Surface Profile µm, DFT µm with min+max hard-block, Soluble Salts mg/m^2)
- AuditLogEntry for traceability

Auth: JWT email/password (Entra ID deferred to real Spring Boot backend).
"""

import logging
import os
import random
import uuid
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import List, Literal, Optional

import jwt
from dotenv import load_dotenv
from fastapi import Depends, FastAPI, APIRouter, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from motor.motor_asyncio import AsyncIOMotorClient
from passlib.context import CryptContext
from pydantic import BaseModel, EmailStr, Field
from starlette.middleware.cors import CORSMiddleware

ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / ".env")

# ---------- config ----------
MONGO_URL = os.environ["MONGO_URL"]
DB_NAME = os.environ["DB_NAME"]
JWT_SECRET = os.environ.get("JWT_SECRET", "coating-portal-dev-secret-change-me")
JWT_ALG = "HS256"
JWT_EXP_HOURS = 12

pwd_ctx = CryptContext(schemes=["bcrypt"], deprecated="auto")
bearer = HTTPBearer(auto_error=False)

client = AsyncIOMotorClient(MONGO_URL)
db = client[DB_NAME]

# ---------- stages ----------
STAGES = [
    {"key": "surface_prep",     "name": "Surface Prep",     "description": "Degreasing and mechanical abrasion",     "requires_coat_readings": True},
    {"key": "primer_coat",      "name": "Primer Coat",      "description": "Epoxy base application",                 "requires_coat_readings": True},
    {"key": "mid_inspection",   "name": "Mid-Inspection",   "description": "Thickness uniformity check",             "requires_coat_readings": False},
    {"key": "top_coat",         "name": "Top Coat",         "description": "Finish layer application",               "requires_coat_readings": True},
    {"key": "curing",           "name": "Curing Process",   "description": "Oven cycle: 200\u00b0C for 45 mins",     "requires_coat_readings": False},
    {"key": "final_qc",         "name": "Final QC",         "description": "Visual and adherence testing",           "requires_coat_readings": False},
]
STAGE_KEYS = [s["key"] for s in STAGES]


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
    soluble_salts_max_mg_m2: float

class WorkOrderSummary(BaseModel):
    work_order_id: str
    customer_name: str
    paint_product_code: str
    paint_product_name: str
    part_description: str
    quantity: int
    serial_range: str
    priority: bool
    progress: int  # number of stages done
    total_stages: int = 6
    overall_status: str  # pending | in_progress | done | fail

class WorkOrderDetail(WorkOrderSummary):
    po_number: str
    spec: PaintSpec
    stages: List[dict]

class StageReadings(BaseModel):
    # weather (auto, from OpenWeather — mocked when key not present)
    ambient_temp_c: Optional[float] = None
    relative_humidity_pct: Optional[float] = None
    dew_point_c: Optional[float] = None
    # surface temp (manual Elcometer 319)
    surface_temp_c: Optional[float] = None

class StageReadingPair(BaseModel):
    start: StageReadings
    end: StageReadings

class MeasuredParameters(BaseModel):
    surface_profile_um: float
    dft_um: float
    soluble_salts_mg_m2: float

class StageSubmission(BaseModel):
    readings: StageReadingPair
    parameters: MeasuredParameters
    notes: Optional[str] = ""
    photos: List[str] = Field(default_factory=list)  # base64 strings
    result: Literal["pass", "fail"] = "pass"

class CreateWorkOrderRequest(BaseModel):
    customer_name: str = Field(..., min_length=1)
    customer_address: Optional[str] = ""  # only optional field
    po_number: str = Field(..., min_length=1)            # external customer PO ref
    po_line_item_number: int = Field(..., ge=1)          # which line within that PO
    part_number: str = Field(..., min_length=1)
    part_revision_number: str = Field(..., min_length=1)
    coating_spec_code: str = Field(..., min_length=1)    # must reference a known spec
    coating_spec_revision_number: str = Field(..., min_length=1)
    quantity: int = Field(..., ge=1)

class CoatingSpecOut(BaseModel):
    code: str
    name: str
    spec: PaintSpec

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

def make_token(user: dict) -> str:
    payload = {
        "sub": user["email"],
        "employee_id": user["employee_id"],
        "exp": datetime.now(timezone.utc) + timedelta(hours=JWT_EXP_HOURS),
    }
    return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALG)

async def get_current_user(creds: Optional[HTTPAuthorizationCredentials] = Depends(bearer)) -> dict:
    if creds is None:
        raise HTTPException(status_code=401, detail="Missing auth token")
    try:
        payload = jwt.decode(creds.credentials, JWT_SECRET, algorithms=[JWT_ALG])
    except jwt.PyJWTError:
        raise HTTPException(status_code=401, detail="Invalid or expired token")
    user = await db.inspectors.find_one({"email": payload.get("sub")}, {"_id": 0, "password_hash": 0})
    if not user:
        raise HTTPException(status_code=401, detail="User not found")
    return user

async def write_audit(work_order_id: str, stage_key: Optional[str], actor: dict, action: str, detail: str):
    entry = {
        "id": str(uuid.uuid4()),
        "work_order_id": work_order_id,
        "stage_key": stage_key,
        "actor_employee_id": actor["employee_id"],
        "actor_name": actor["name"],
        "action": action,
        "detail": detail,
        "timestamp": now_iso(),
    }
    await db.audit_log.insert_one(entry.copy())


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


# ---------- seed ----------
async def seed_data():
    # Inspectors
    if await db.inspectors.count_documents({}) == 0:
        inspectors = [
            {
                "id": str(uuid.uuid4()),
                "employee_id": "QC-7742",
                "name": "Thompson, J.",
                "email": "j.thompson@aerospace-precision.com",
                "password_hash": pwd_ctx.hash("Inspector@123"),
                "role": "Lead Inspector",
                "shift": "Alpha - Section 4",
                "department": "Surface Coating & Prep",
                "avatar_url": "https://images.pexels.com/photos/10816007/pexels-photo-10816007.jpeg",
            },
            {
                "id": str(uuid.uuid4()),
                "employee_id": "QC-7841",
                "name": "Reyes, M.",
                "email": "m.reyes@aerospace-precision.com",
                "password_hash": pwd_ctx.hash("Inspector@123"),
                "role": "Inspector",
                "shift": "Bravo - Section 2",
                "department": "Surface Coating & Prep",
                "avatar_url": "https://images.pexels.com/photos/29852895/pexels-photo-29852895.jpeg",
            },
        ]
        await db.inspectors.insert_many([i.copy() for i in inspectors])

    # Paint specs (per-customer-product spec)
    specs = {
        "EPOXY-COAT-X": {"surface_profile_min_um": 50, "surface_profile_max_um": 100,
                         "dft_min_um": 250, "dft_max_um": 400, "soluble_salts_max_mg_m2": 20},
        "POLY-SHIELD-40": {"surface_profile_min_um": 40, "surface_profile_max_um": 90,
                           "dft_min_um": 200, "dft_max_um": 350, "soluble_salts_max_mg_m2": 20},
        "ZINC-GALV-XL":  {"surface_profile_min_um": 60, "surface_profile_max_um": 120,
                          "dft_min_um": 300, "dft_max_um": 500, "soluble_salts_max_mg_m2": 15},
        "MARINE-GUARD":  {"surface_profile_min_um": 45, "surface_profile_max_um": 95,
                          "dft_min_um": 275, "dft_max_um": 425, "soluble_salts_max_mg_m2": 18},
    }

    # Work orders
    if await db.work_orders.count_documents({}) == 0:
        seed_wos = [
            {
                "work_order_id": "WO-2024-9901",
                "po_number": "PO-AC-44821",
                "customer_name": "Aerospace Precision Corp.",
                "paint_product_code": "EPOXY-COAT-X",
                "paint_product_name": "Epoxy Coat X (Aerospace Grade)",
                "part_description": "Aerospace Chassis - Component Batch A-92",
                "quantity": 24,
                "serial_range": "AP-2024-0801 \u2192 AP-2024-0824",
                "priority": True,
            },
            {
                "work_order_id": "WO-2024-9905",
                "po_number": "PO-TD-10994",
                "customer_name": "Titan Dynamics Ltd.",
                "paint_product_code": "POLY-SHIELD-40",
                "paint_product_name": "Poly-Shield 40 Industrial Topcoat",
                "part_description": "Drilling Riser Joint - Lot R12",
                "quantity": 12,
                "serial_range": "TD-R12-0301 \u2192 TD-R12-0312",
                "priority": False,
            },
            {
                "work_order_id": "WO-2024-9912",
                "po_number": "PO-GH-77123",
                "customer_name": "Global Hydraulics",
                "paint_product_code": "ZINC-GALV-XL",
                "paint_product_name": "Zinc-Galv XL Heavy Duty",
                "part_description": "Subsea Manifold Spool",
                "quantity": 6,
                "serial_range": "GH-SMS-401 \u2192 GH-SMS-406",
                "priority": True,
            },
            {
                "work_order_id": "WO-2024-9920",
                "po_number": "PO-OM-55021",
                "customer_name": "Oceanic Marine Svcs",
                "paint_product_code": "MARINE-GUARD",
                "paint_product_name": "Marine-Guard Anticorrosive",
                "part_description": "Wellhead Christmas Tree Assembly",
                "quantity": 3,
                "serial_range": "OM-WCT-001 \u2192 OM-WCT-003",
                "priority": False,
            },
        ]
        # Pre-populate WO-2024-9901 with a couple of completed stages to match the dashboard mock
        for wo in seed_wos:
            wo["spec"] = specs[wo["paint_product_code"]]
            wo["stages"] = [
                {
                    "key": s["key"],
                    "name": s["name"],
                    "description": s["description"],
                    "requires_coat_readings": s["requires_coat_readings"],
                    "status": "pending",
                    "result": None,
                    "submission": None,
                    "submitted_at": None,
                    "submitted_by": None,
                }
                for s in STAGES
            ]
            wo["created_at"] = now_iso()

        # pre-mark some progress on the priority order
        priority_wo = next(w for w in seed_wos if w["work_order_id"] == "WO-2024-9901")
        for k in ["surface_prep", "primer_coat"]:
            stg = next(s for s in priority_wo["stages"] if s["key"] == k)
            stg["status"] = "done"
            stg["result"] = "pass"
            stg["submitted_at"] = now_iso()
            stg["submitted_by"] = "QC-7742"

        await db.work_orders.insert_many([w.copy() for w in seed_wos])

    # daily quota — just a doc keyed to today
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    if not await db.quota.find_one({"date": today}):
        await db.quota.insert_one({"date": today, "completed": 14, "target": 25})


@asynccontextmanager
async def lifespan(_: FastAPI):
    await seed_data()
    yield
    client.close()


# ---------- app ----------
app = FastAPI(lifespan=lifespan, title="Coating Portal API")
api = APIRouter(prefix="/api")


@api.get("/")
async def root():
    return {"name": "Coating Portal API", "ok": True}


# auth
@api.post("/auth/login", response_model=LoginResponse)
async def login(req: LoginRequest):
    user = await db.inspectors.find_one({"email": req.email.lower()})
    if not user or not pwd_ctx.verify(req.password, user["password_hash"]):
        raise HTTPException(status_code=401, detail="Invalid credentials")
    token = make_token(user)
    safe = {k: v for k, v in user.items() if k not in ("_id", "password_hash")}
    await write_audit("-", None, user, "login", f"Inspector {user['employee_id']} signed in")
    return {"access_token": token, "token_type": "bearer", "user": safe}


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
    cursor = db.work_orders.find({}, {"_id": 0}).limit(200)
    items: List[WorkOrderSummary] = []
    async for wo in cursor:
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
            customer_name=wo["customer_name"],
            paint_product_code=wo["paint_product_code"],
            paint_product_name=wo["paint_product_name"],
            part_description=wo["part_description"],
            quantity=wo["quantity"],
            serial_range=wo["serial_range"],
            priority=wo.get("priority", False),
            progress=done,
            overall_status=overall,
        ))
    # priority first
    items.sort(key=lambda x: (not x.priority, x.work_order_id))
    return items


# ---- coating specs (used by the New Work Order form) ----
COATING_SPEC_CATALOG = {
    "EPOXY-COAT-X":   {"name": "Epoxy Coat X (Aerospace Grade)",
                       "spec": {"surface_profile_min_um": 50, "surface_profile_max_um": 100,
                                "dft_min_um": 250, "dft_max_um": 400, "soluble_salts_max_mg_m2": 20}},
    "POLY-SHIELD-40": {"name": "Poly-Shield 40 Industrial Topcoat",
                       "spec": {"surface_profile_min_um": 40, "surface_profile_max_um": 90,
                                "dft_min_um": 200, "dft_max_um": 350, "soluble_salts_max_mg_m2": 20}},
    "ZINC-GALV-XL":   {"name": "Zinc-Galv XL Heavy Duty",
                       "spec": {"surface_profile_min_um": 60, "surface_profile_max_um": 120,
                                "dft_min_um": 300, "dft_max_um": 500, "soluble_salts_max_mg_m2": 15}},
    "MARINE-GUARD":   {"name": "Marine-Guard Anticorrosive",
                       "spec": {"surface_profile_min_um": 45, "surface_profile_max_um": 95,
                                "dft_min_um": 275, "dft_max_um": 425, "soluble_salts_max_mg_m2": 18}},
}


@api.get("/coating-specifications", response_model=List[CoatingSpecOut])
async def list_coating_specs(_=Depends(get_current_user)):
    return [CoatingSpecOut(code=k, name=v["name"], spec=PaintSpec(**v["spec"])) for k, v in COATING_SPEC_CATALOG.items()]


async def _next_wo_id() -> str:
    """Atomically generate the next WO-YYYY-NNNN id for the current year."""
    year = datetime.now(timezone.utc).year
    res = await db.counters.find_one_and_update(
        {"_id": f"wo_seq_{year}"},
        {"$inc": {"seq": 1}},
        upsert=True,
        return_document=True,
    )
    seq = res["seq"] if res else 1
    # Seed accounts for the four pre-existing WO-2024-99xx ids; new ones start at 0001 for current year.
    return f"WO-{year}-{seq:04d}"


@api.post("/work-orders", response_model=WorkOrderSummary, status_code=201)
async def create_work_order(body: CreateWorkOrderRequest, current=Depends(get_current_user)):
    # validate coating spec exists in the catalog
    if body.coating_spec_code not in COATING_SPEC_CATALOG:
        raise HTTPException(400, f"Unknown coating specification '{body.coating_spec_code}'")
    catalog = COATING_SPEC_CATALOG[body.coating_spec_code]

    work_order_id = await _next_wo_id()
    # composite uniqueness on (part_number, part_revision_number) is captured by the
    # part_description we build below — and indexed via the document fields too.
    part_description = f"{body.part_number} Rev {body.part_revision_number}"

    doc = {
        "work_order_id": work_order_id,
        # legacy/display fields (consumed by existing screens — left intact)
        "po_number": body.po_number,
        "customer_name": body.customer_name,
        "paint_product_code": body.coating_spec_code,
        "paint_product_name": catalog["name"],
        "part_description": part_description,
        "quantity": body.quantity,
        "serial_range": f"{body.part_number}-001 → {body.part_number}-{body.quantity:03d}",
        "priority": False,
        "spec": catalog["spec"],
        # new fields introduced by the Create-WO feature
        "customer_address": body.customer_address or "",
        "po_line_item_number": body.po_line_item_number,
        "part_number": body.part_number,
        "part_revision_number": body.part_revision_number,
        "coating_spec_revision_number": body.coating_spec_revision_number,
        # 6-stage workflow scaffold
        "stages": [
            {
                "key": s["key"],
                "name": s["name"],
                "description": s["description"],
                "requires_coat_readings": s["requires_coat_readings"],
                "status": "pending",
                "result": None,
                "submission": None,
                "submitted_at": None,
                "submitted_by": None,
            }
            for s in STAGES
        ],
        "created_at": now_iso(),
        "created_by": current["employee_id"],
    }
    await db.work_orders.insert_one(doc.copy())
    await write_audit(work_order_id, None, current, "work_order_created",
                      f"WO {work_order_id} created for {body.customer_name} / {body.po_number} line {body.po_line_item_number}")

    return WorkOrderSummary(
        work_order_id=work_order_id,
        customer_name=doc["customer_name"],
        paint_product_code=doc["paint_product_code"],
        paint_product_name=doc["paint_product_name"],
        part_description=doc["part_description"],
        quantity=doc["quantity"],
        serial_range=doc["serial_range"],
        priority=False,
        progress=0,
        overall_status="pending",
    )


@api.get("/work-orders/{work_order_id}", response_model=WorkOrderDetail)
async def get_work_order(work_order_id: str, _=Depends(get_current_user)):
    wo = await db.work_orders.find_one({"work_order_id": work_order_id}, {"_id": 0})
    if not wo:
        raise HTTPException(404, "Work order not found")
    done, overall = stage_progress(wo["stages"])
    return WorkOrderDetail(
        work_order_id=wo["work_order_id"],
        po_number=wo["po_number"],
        customer_name=wo["customer_name"],
        paint_product_code=wo["paint_product_code"],
        paint_product_name=wo["paint_product_name"],
        part_description=wo["part_description"],
        quantity=wo["quantity"],
        serial_range=wo["serial_range"],
        priority=wo.get("priority", False),
        progress=done,
        overall_status=overall,
        spec=PaintSpec(**wo["spec"]),
        stages=wo["stages"],
    )


@api.post("/work-orders/{work_order_id}/stages/{stage_key}/submit")
async def submit_stage(
    work_order_id: str,
    stage_key: str,
    body: StageSubmission,
    current=Depends(get_current_user),
):
    if stage_key not in STAGE_KEYS:
        raise HTTPException(400, f"Unknown stage '{stage_key}'")
    wo = await db.work_orders.find_one({"work_order_id": work_order_id}, {"_id": 0})
    if not wo:
        raise HTTPException(404, "Work order not found")

    spec = wo["spec"]

    # ---- server-side validation (defense-in-depth) ----
    p = body.parameters
    errors: List[str] = []
    if not (spec["surface_profile_min_um"] <= p.surface_profile_um <= spec["surface_profile_max_um"]):
        errors.append(
            f"Surface profile {p.surface_profile_um} \u00b5m outside spec "
            f"{spec['surface_profile_min_um']}-{spec['surface_profile_max_um']} \u00b5m"
        )
    if p.dft_um < spec["dft_min_um"]:
        errors.append(f"DFT {p.dft_um} \u00b5m below min {spec['dft_min_um']} \u00b5m")
    if p.dft_um > spec["dft_max_um"]:
        # hard block
        errors.append(f"DFT {p.dft_um} \u00b5m exceeds max {spec['dft_max_um']} \u00b5m (hard block)")
    if p.soluble_salts_mg_m2 > spec["soluble_salts_max_mg_m2"]:
        errors.append(f"Soluble salts {p.soluble_salts_mg_m2} mg/m\u00b2 exceeds max {spec['soluble_salts_max_mg_m2']}")

    # gate check on END readings (final condition)
    end = body.readings.end
    gate_ok = True
    if end.surface_temp_c is not None and end.dew_point_c is not None:
        if not (end.surface_temp_c > end.dew_point_c + 3):
            errors.append("Surface temp not > dew point + 3\u00b0C at end of stage")
            gate_ok = False

    # Hard-block on DFT-max regardless of submitted result
    if any("hard block" in e for e in errors):
        await write_audit(work_order_id, stage_key, current, "stage_submit_blocked",
                          f"Hard-block: {'; '.join(errors)}")
        raise HTTPException(status_code=422, detail={"hard_block": True, "errors": errors})

    result = body.result if not errors else "fail"

    submission = {
        "readings": body.readings.model_dump(),
        "parameters": body.parameters.model_dump(),
        "notes": body.notes or "",
        "photos": body.photos[:5],
        "result": result,
        "errors": errors,
        "gate_ok": gate_ok,
        "submitted_by": current["employee_id"],
        "submitted_at": now_iso(),
    }

    # update the stage
    new_stages = []
    for s in wo["stages"]:
        if s["key"] == stage_key:
            s = {
                **s,
                "status": "done" if result == "pass" else "fail",
                "result": result,
                "submission": submission,
                "submitted_at": submission["submitted_at"],
                "submitted_by": current["employee_id"],
            }
        new_stages.append(s)

    await db.work_orders.update_one(
        {"work_order_id": work_order_id},
        {"$set": {"stages": new_stages}},
    )

    await write_audit(
        work_order_id, stage_key, current,
        "stage_submit",
        f"Stage '{stage_key}' submitted with result={result}. "
        f"SP={p.surface_profile_um}\u00b5m DFT={p.dft_um}\u00b5m Salts={p.soluble_salts_mg_m2}mg/m\u00b2",
    )

    # increment quota on pass
    if result == "pass":
        today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        await db.quota.update_one({"date": today}, {"$inc": {"completed": 1}}, upsert=True)

    return {"ok": True, "result": result, "errors": errors, "stage_key": stage_key,
            "work_order_id": work_order_id, "submitted_at": submission["submitted_at"]}


@api.get("/work-orders/{work_order_id}/audit-log", response_model=List[AuditEntry])
async def audit_log(work_order_id: str, _=Depends(get_current_user)):
    cursor = db.audit_log.find({"work_order_id": work_order_id}, {"_id": 0}).sort("timestamp", -1)
    return [AuditEntry(**e) async for e in cursor]


# history
@api.get("/inspections/history", response_model=List[HistoryItem])
async def history(current=Depends(get_current_user)):
    out: List[HistoryItem] = []
    cursor = db.work_orders.find({}, {"_id": 0}).limit(200)
    async for wo in cursor:
        for s in wo["stages"]:
            if s.get("submitted_at"):
                out.append(HistoryItem(
                    work_order_id=wo["work_order_id"],
                    customer_name=wo["customer_name"],
                    stage_key=s["key"],
                    stage_name=s["name"],
                    result=s.get("result") or "pending",
                    timestamp=s["submitted_at"],
                    inspector_name=s.get("submitted_by") or "",
                ))
    out.sort(key=lambda x: x.timestamp, reverse=True)
    return out


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
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    quota = await db.quota.find_one({"date": today}, {"_id": 0}) or {"completed": 0, "target": 25}
    # current assignment = first priority not-done WO
    current_wo = None
    cursor = db.work_orders.find({}, {"_id": 0}).sort("priority", -1).limit(50)
    async for wo in cursor:
        done, overall = stage_progress(wo["stages"])
        if overall != "done":
            current_wo = {
                "work_order_id": wo["work_order_id"],
                "customer_name": wo["customer_name"],
                "part_description": wo["part_description"],
                "paint_product_code": wo["paint_product_code"],
                "priority": wo.get("priority", False),
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


@app.on_event("shutdown")
async def shutdown():
    client.close()
