# Coating Portal — PRD (v1)

## What is it
Mobile-first industrial coating QC and traceability app for an oilfield equipment plant.
Replaces a 15-sheet Excel/paper workflow used by inspectors to log coating quality
checks. Each inspector picks a work order (one per purchase-order line item), runs it
through a 6-stage inspection pipeline, and the system enforces validation gates and
keeps a full audit trail (ISO 9001 context).

## v1 scope (built)

### Backend — FastAPI + MongoDB
- JWT email/password auth with seeded inspector accounts (Microsoft Entra ID deferred to the real Spring Boot backend).
- Domain model: inspector / work order (purchase-order-line, fixed `WO-YYYY-NNNN`) / paint spec / 6-stage workflow / weather & surface-temp readings (start+end pairs) / measured parameters / audit log.
- Endpoints (all under `/api`):
  - `POST /auth/login`, `GET /auth/me`
  - `GET /work-orders?q=&filter=all|priority|pending`, `GET /work-orders/{id}`
  - `POST /work-orders/{id}/stages/{stage_key}/submit` — server-side spec validation
  - `GET /work-orders/{id}/audit-log`, `GET /inspections/history`
  - `GET /weather` (mocked realistic Magnus-formula dew point; OpenWeather key wires in later)
  - `GET /dashboard` (quota, shift, current assignment)
- Seed data: 4 work orders across 4 customers and 4 paint specs, 2 inspectors, daily quota.

### Frontend — Expo Router (React Native)
- Bottom tabs: Orders / Inspect / History / Profile
- Login → splash gate → tabs
- Orders dashboard: search, filter chips (All / Priority / Pending), current assignment card, daily quota, system status, active shift, work order cards with priority flame icon.
- Work Order detail: PO/quantity/serial range, paint spec breakdown (Surface Profile range, DFT min–max, Soluble Salts max), 6-stage pipeline with status pills, View Audit Log, sticky Update Selected Stage CTA.
- Stage inspection form (the heart of the app):
  - START / END phase toggle (segmented control)
  - Environmental block (auto Weather: Air Temp / RH / Dew Point — with FETCH button)
  - Surface Temperature block (manual Elcometer 319) — separate from Weather, captured per phase
  - Gate check pill: `Surface Temp > Dew Point + 3°C` (PASS / FAIL)
  - Measured Parameters:
    - Surface Profile in **µm** with spec range hint
    - Dry Film Thickness in µm with **min + max**, **hard-block** on max exceedance
    - Soluble Salts in mg/m²
  - Up to 5 evidence photos (procedural SVG placeholders in lieu of camera)
  - Inspection Notes textarea
  - Submit Inspection sticky CTA (disabled when DFT hard-block is tripped)
- Inspection submitted success screen (PASS / FAIL summary, Return to Orders / View Audit Log).
- Audit Log screen: timeline view of all actions on the work order.
- History tab: chronological list of submitted stages with PASS / FAIL pills.
- Profile tab: avatar, name, role, Employee ID, shift, department, email, sign out.

### Design corrections vs Stitch mockups (all applied)
1. Work Order ID is consistently `WO-YYYY-NNNN` everywhere — never `Order #12345` or `QC-2023-8842`.
2. Surface Profile labeled in **µm** (not MM).
3. Weather and Surface Temperature live in separate UI blocks, each captured as a **start + end pair** per coat-applying stage.
4. DFT enforces **min and max** with hard-block on max exceedance (server and client side).

## Tech notes
- Backend stays on Python/FastAPI per platform constraints; spec called for Spring Boot.
- Auth uses JWT for v1 (Entra ID OAuth2 + PKCE deferred).
- Weather endpoint mocks realistic plant-floor conditions; plug OpenWeather key into `/api/weather` later.
- Camera capture uses SVG placeholders (real `expo-camera` integration would require permissions + native build for full validation).

## Out of scope for v1
- Offline queueing (online-only per spec)
- Microsoft Entra ID OAuth2 + PKCE
- Real OpenWeather API (mock in place; trivial to swap)
- Real camera integration (placeholders in place)
- Multi-user collaboration / live presence
