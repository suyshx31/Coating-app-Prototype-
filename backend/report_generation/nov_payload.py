"""Builds the fill_nov_report.py payload from a work order's database records.

The NOV template reports in °F and mils; the app captures °C and µm, so values
are converted here. Coat rows map by role — primer → "primer", intermediate →
"second", top coat → "third" — matching how the plant fills the sheet for a
3-coat system ("fourth" stays NA). Anything the app doesn't capture (nozzle
pressure, abrasive medium, gauges) is reported as NA / left blank rather than
invented.
"""
from datetime import datetime
from typing import Optional

COAT_KEYS = ["primer", "second", "third", "fourth"]
STAGE_TO_COAT = {"primer_coat": "primer", "intermediate_coat": "second", "top_coat": "third"}
# Template column per coat stage, by case type. Columns follow application
# sequence, so primer_top_coat's top coat lands in "2nd" (intermediate is
# skipped). top_coat_only keeps its established "3rd" placement.
CASE_COAT_COLUMNS = {
    "only_primer": {"primer_coat": "primer"},
    "primer_intermediate": {"primer_coat": "primer", "intermediate_coat": "second"},
    "primer_intermediate_top": {"primer_coat": "primer", "intermediate_coat": "second", "top_coat": "third"},
    "primer_top_coat": {"primer_coat": "primer", "top_coat": "second"},
    "top_coat_only": {"top_coat": "third"},
}
# per-coat spec window key in coat_limits, and legacy curing_qa batch suffix
STAGE_ROLE = {"primer_coat": "primer", "intermediate_coat": "intermediate", "top_coat": "top"}
CUMULATIVE_WINDOWS = ("mid_cumulative", "primer_top_cumulative", "total")

NA = "NA"


def _stage(wo: dict, key: str) -> Optional[dict]:
    return next((s for s in wo["stages"] if s["key"] == key), None)


def _merged_fields(stage: Optional[dict]) -> dict:
    if not stage:
        return {}
    sub = stage.get("submission") or {}
    return {**(stage.get("start_fields") or {}), **(sub.get("fields") or {})}


def _c_to_f(c) -> Optional[float]:
    return round(c * 9 / 5 + 32) if c is not None else None


def _um_to_mils(um) -> str:
    if um is None:
        return NA
    return f"{float(um) / 25.4:.2f}".rstrip("0").rstrip(".")


def _fmt_date(iso: Optional[str]) -> str:
    if not iso:
        return NA
    try:
        return datetime.fromisoformat(iso).strftime("%d/%m/%Y")
    except ValueError:
        return iso


def _fmt_time(iso: Optional[str]) -> str:
    if not iso:
        return NA
    try:
        return datetime.fromisoformat(iso).strftime("%H:%M")
    except ValueError:
        return iso


def _rng(a, b, suffix: str = "") -> str:
    """Start/end readings as a 'lo-hi' range (template style), single value if equal."""
    vals = sorted(v for v in (a, b) if v is not None)
    if not vals:
        return NA
    if len(vals) == 2 and vals[0] != vals[1]:
        return f"{vals[0]}-{vals[1]}{suffix}"
    return f"{vals[0]}{suffix}"


def _end_readings(stage: Optional[dict]) -> dict:
    sub = (stage or {}).get("submission") or {}
    return (sub.get("readings") or {}).get("end") or {}


def _accept(stage: Optional[dict]) -> str:
    return "OK" if (stage or {}).get("result") == "pass" else "NOT OK"


def build_nov_payload(wo: dict, ps: Optional[dict], inspector_names: dict,
                      completed_by: str) -> dict:
    """wo: work order dict with stages (as from _fetch_work_orders);
    ps: its paint_system_specifications row; inspector_names: employee_id → name."""
    ps = ps or {}
    today = datetime.now().strftime("%d/%m/%Y")

    def name_of(employee_id: Optional[str]) -> str:
        return inspector_names.get(employee_id, employee_id or NA)

    serials = [s.strip() for s in (wo.get("serial_range") or "").split("→")]
    serial_no = serials[0] if serials and serials[0] else NA
    serial_end = serials[1] if len(serials) > 1 and serials[1] != serials[0] else ""

    # ---- surface preparation ----
    sp = _stage(wo, "surface_prep")
    sp_f = _merged_fields(sp)
    sp_start = (sp or {}).get("start_readings") or {}
    sp_end = _end_readings(sp)
    surface_prep = {
        "method": ps.get("surface_preparation") or NA,
        "booth_temp": _rng(_c_to_f(sp_start.get("ambient_temp_c")), _c_to_f(sp_end.get("ambient_temp_c"))),
        "surface_temp": _rng(_c_to_f(sp_start.get("surface_temp_c")), _c_to_f(sp_end.get("surface_temp_c"))),
        "nozzle_pressure": NA,  # not captured by the app
        "dew_point": _rng(_c_to_f(sp_start.get("dew_point_c")), _c_to_f(sp_end.get("dew_point_c"))),
        "relative_humidity": _rng(sp_start.get("relative_humidity_pct"), sp_end.get("relative_humidity_pct"), "%"),
        "abrasive": NA,  # not captured by the app
        "blast_profile": str(sp_f.get("surface_profile_mils", NA)),
        "time_started": str(sp_f.get("process_start_time") or _fmt_time((sp or {}).get("started_at"))),
        "accept": _accept(sp),
        "date": _fmt_date((sp or {}).get("submitted_at")),
        "operator": name_of((sp or {}).get("submitted_by")),
    }

    # ---- coats: applications, conditions, batches, DFT ----
    qa = _stage(wo, "curing_qa")
    qa_f = _merged_fields(qa)
    batch_by_coat = {k: None for k in COAT_KEYS}

    na_app = {"product": NA, "color": NA, "date": NA, "time": NA, "operator": NA}
    na_cond = {"booth_temp": NA, "surface_temp": NA, "dew_point": NA, "relative_humidity": NA}
    applications = {k: dict(na_app) for k in COAT_KEYS}
    conditions = {k: dict(na_cond) for k in COAT_KEYS}
    dft_spec = {k: [NA, NA] for k in COAT_KEYS}
    dft_measured = {k: [NA, NA] for k in COAT_KEYS}

    coat_limits = wo.get("coat_limits") or {}
    columns = CASE_COAT_COLUMNS.get(wo.get("case_type"), STAGE_TO_COAT)
    last_coat_stage = None
    prev_cumulative = None
    for stage_key, coat in columns.items():
        s = _stage(wo, stage_key)
        if not s:
            continue
        last_coat_stage = s
        f = _merged_fields(s)
        role = STAGE_ROLE[stage_key]
        # batch number now captured at the coat stage itself; legacy WOs
        # (submitted before the move) still carry it on curing_qa
        batch_by_coat[coat] = f.get("batch_number") or qa_f.get(f"batch_number_{role}")
        # "RAL 3001 · Signal red" overflows the template's COLOR column — keep the code
        color = str(f.get("color") or f.get("paint_shade") or f.get("ral_shade") or NA)
        color = color.split("·")[0].strip()
        applications[coat] = {
            "product": str(f.get("product") or NA),
            "color": color,
            "date": _fmt_date(s.get("submitted_at")),
            "time": str(f.get("process_start_time") or _fmt_time(s.get("started_at"))),
            "operator": str(f.get("operator_name") or NA),
        }
        start = s.get("start_readings") or {}
        conditions[coat] = {
            "booth_temp": _rng(_c_to_f(start.get("ambient_temp_c")), None, " °F"),
            "surface_temp": _rng(_c_to_f(start.get("surface_temp_c")), None, " °F"),
            "dew_point": _rng(_c_to_f(start.get("dew_point_c")), None, " °F"),
            "relative_humidity": _rng(start.get("relative_humidity_pct"), None, "%"),
        }
        window = coat_limits.get(role)
        if window:
            dft_spec[coat] = [_um_to_mils(window[0]), _um_to_mils(window[1])]
        measured = f.get("dft_um")
        if measured is not None:
            # later coat stages capture CUMULATIVE DFT (their dft_window is
            # mid_cumulative/primer_top_cumulative/total); the template wants
            # per-coat, so subtract the previous coat's cumulative reading
            per_coat = float(measured)
            if s.get("dft_window") in CUMULATIVE_WINDOWS and prev_cumulative is not None:
                per_coat = float(measured) - prev_cumulative
            prev_cumulative = float(measured)
            # single captured value: reported in both min/max measured columns
            dft_measured[coat] = [_um_to_mils(per_coat), _um_to_mils(per_coat)]

    # ---- cure test / visual inspection ----
    cure_test = {
        "batch_no": str(batch_by_coat["primer"] or NA),
        "accept": _accept(qa),
        "date": _fmt_date((qa or {}).get("submitted_at")),
        "approver": name_of((qa or {}).get("submitted_by")),
    }
    coat_stages = [s for k in STAGE_TO_COAT if (s := _stage(wo, k))]
    visual_ok = bool(coat_stages) and all(s.get("result") == "pass" for s in coat_stages)
    visual_inspection = {
        "accept": "OK" if visual_ok else "NOT OK",
        "date": _fmt_date((last_coat_stage or {}).get("submitted_at")),
        "approver": name_of((last_coat_stage or {}).get("submitted_by")),
    }

    # ---- spec string ----
    sysno = ps.get("system_number")
    shade = (_merged_fields(_stage(wo, "top_coat")).get("ral_shade")
             or _merged_fields(_stage(wo, "top_coat")).get("paint_shade")
             or ps.get("top_coat_paint_shade") or "")
    spec_parts = [f"{wo['paint_product_code']} Rev {wo.get('coating_spec_revision_number') or ''}".strip()]
    if sysno is not None:
        spec_parts.append(f"SYSTEM {float(sysno):g}")
    if shade:
        spec_parts.append(str(shade))
    nov_paint_spec = ", ".join(spec_parts)

    total = coat_limits.get("total")
    return {
        "nov_po": wo["po_number"],
        "equipment_description": wo["part_description"],
        "part_number": wo["part_number"],
        "job_number": wo["work_order_id"],
        "serial_no": serial_no,
        "serial_no_end": serial_end,
        "report_date": today,
        "surface_prep": surface_prep,
        "batch_numbers": {k: str(batch_by_coat[k] or NA) for k in COAT_KEYS},
        "applications": [applications[k] for k in COAT_KEYS],
        "conditions": [conditions[k] for k in COAT_KEYS],
        "cure_test": cure_test,
        "visual_inspection": visual_inspection,
        "nov_paint_spec": nov_paint_spec,
        "dft": {
            "spec": dft_spec,
            "measured": dft_measured,
            "total_min": _um_to_mils(total[0]) if total else NA,
            "total_max": _um_to_mils(total[1]) if total else NA,
        },
        "gauges": [],  # gauge/calibration data is not captured by the app
        "completed_by": completed_by,
        "completed_date": today,
        "approved_by": "",
        "approved_date": "",
    }
