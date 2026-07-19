# PROJECT HANDOFF — Coating App Prototype

**Written:** 2026-07-15 by Claude Fable 5, for continuation by Claude Opus 4.8 (Fable expected back ~2026-07-17).
**Purpose:** zero-loss context transfer. Everything below was verified against the working tree / live DB at handoff time; anything that could NOT be re-verified is flagged in §9.

---

## 1. What this project is

A coating-inspection portal for a paint shop:

- **Backend:** FastAPI + asyncpg on **Supabase Postgres 17**. Single main module [backend/server.py](backend/server.py). `DATABASE_URL` lives in `backend/.env` and **the value is quoted** — extract it with `python -c "from dotenv import dotenv_values; print(dotenv_values('.env')['DATABASE_URL'])"`, never with naive `grep|cut` (a past `grep|cut` kept the quotes, pg_dump fell back to a local socket, and shell redirection truncated two fixture files to 0 bytes before failing).
- **Frontend:** Expo / React Native (expo-router), TypeScript, in [frontend/](frontend/). API client: [frontend/src/api.ts](frontend/src/api.ts).
- **Deployment:** Railway (backend). Secrets that exist **only on Railway**, not locally: `CLOUDCONVERT_API_KEY`, `GMAIL_USER`, `GMAIL_APP_PASSWORD`.
- **Test login:** `j.thompson@aerospace-precision.com` / `Inspector@123` (employee QC-7742).

### Core domain model

- `work_orders` has a `case_type` column (CHECK constraint `work_orders_case_type_check`). Five case types now exist:
  `only_primer`, `primer_intermediate`, `primer_intermediate_top`, `top_coat_only`, **`primer_top_coat`** (new).
- `case_type_stage_templates` (unique on `(case_type, stage_key)`) defines each case type's stage sequence, params, `dft_window`, and a JSONB `fields` array of typed field definitions. At work-order creation these are **snapshotted** onto `work_order_stages`; migrations re-snapshot only open (pending/in_progress) stages.
- Stage fields have a `phase` (`start` = captured when stage starts, e.g. paint identification; `end`/missing = captured at submission).
- Field types include `dropdown, ok_notok, pass_fail, number, decimal, text, date, note, time` and the new **`date_dmy`** (strict DD/MM/YYYY, see §3).
- `requires_coat_readings` (bool per stage) is **false only for `curing_qa`**; it gates environmental/surface-temp capture in both backend gating and frontend UI.

### DFT-window convention (important for report accuracy)

Coat stages capture **cumulative** DFT when their `dft_window` is one of `mid_cumulative`, `primer_top_cumulative`, `total`; the report generator differences consecutive readings to get per-coat values. Convention for case types that skip a stage: the final coat validates against the **sum of the applied coats' windows**:

- `primer_intermediate` → `mid_cumulative` = primer + intermediate
- `primer_top_coat` (new) → `primer_top_cumulative` = primer + top (computed in `_coat_limits_from_paint_system_row`, [backend/server.py:345-353](backend/server.py#L345-L353))
- `top` = standalone top-coat window (used by `top_coat_only`), `total` = full system.

---

## 2. Current state at handoff (git)

Branch `main`, in sync with origin up to commit `c431b36` ("Trigger fresh Railway build"). Recent commits:

```
c431b36 Trigger fresh Railway build
b615c2e Convert report xlsx to PDF via CloudConvert instead of local LibreOffice
1eca008 Add Final Report card with recipient autocomplete to work-order screen
b6f0fd7 Add NOV-template report generation endpoint with PDF + email
2908f23 Add WFT max-fix migration and mixing-ratio seed data
```

**UNCOMMITTED work (the just-finished `primer_top_coat` task — complete and tested, but NOT yet committed/pushed; the user explicitly asks before committing, so wait for their instruction):**

Modified:
- `backend/server.py` — `CaseType` Literal += `primer_top_coat` (line ~71); `primer_top_cumulative` in `_coat_limits_from_paint_system_row`; `date_dmy` validation branch in `_validate_stage_fields` ([server.py:476-485](backend/server.py#L476-L485)); `import re` added.
- `backend/report_generation/nov_payload.py` — per-case-type coat-column mapping (see §4).
- `backend/reports.py` — batch/expiry read from coat-stage fields with legacy curing_qa fallback (lines 93-94).
- `backend/tests/test_coating_portal.py` — new/updated tests (see §6).
- `backend/tests/fixtures/schema_baseline.sql` + `reference_data.sql` — regenerated from live DB **after** migration 0010.
- `frontend/src/api.ts` — `DftWindow` += `primer_top_cumulative`; `FieldDef.type` += `date_dmy`; `CoatLimits.primer_top_cumulative`.
- `frontend/app/work-order/new.tsx` — `CASE_TYPE_LABELS.primer_top_coat = "Primer + Top Coat"` (line 57; the picker itself is driven by `/case-types`, so the new type appears automatically).
- `frontend/app/work-order/[id]/stage/[stage].tsx` — `maskDmy`/`dmyIssue` helpers, `date_dmy` masked input, `needsReadings` gating (see §5).

Untracked:
- `backend/migrations/0010_primer_top_coat_and_batch_fields.sql` — **already APPLIED to the live Supabase DB** (in a transaction, with in-flight assertions, all passed). The file must be committed for record-keeping only; do NOT re-run it (it is idempotency-guarded anyway: the batch-field injection checks `not exists ... key='batch_number'`, and re-running the CHECK-constraint alter is harmless, but the template `INSERT` is NOT guarded — a blind re-run would violate the unique(case_type, stage_key) constraint and roll back, which is safe but noisy).

---

## 3. The just-completed task (primer_top_coat) — what was built

User's spec (paraphrased; treat as authoritative constraints):

1. New case type `primer_top_coat` ("Primer + Top Coat"), stage sequence Surface Preparation → Primer → Top Coat → Curing + QA. Field definitions **copied verbatim from `primer_intermediate_top` rows in the DB** (never re-typed) — done via `INSERT ... SELECT` in migration 0010.
2. Top Coat is the **"2nd" coat** in sequence (intermediate skipped); DFT window follows the existing skip-a-stage convention → new `primer_top_cumulative` window.
3. Across **all** case types: environmental data / Surface Temperature must NOT appear in Curing + QA (handled by `requires_coat_readings=false` gating everywhere), and every coat stage (`primer_coat`, `intermediate_coat`, `top_coat`) captures at **start**, inserted immediately before `operator_name` (i.e. after paint product/details):
   - `batch_number` — "Paint Batch Number", type `text`, required
   - `expiry_date` — "Expiry Date", type `date_dmy`, required
   These must NOT exist on `surface_prep` or `curing_qa`. The old `batch_number_*` / `expiry_date_*` fields were **removed from Curing + QA** (user explicitly chose "Move to coat stages" via a question I asked). Completed stages keep their submitted legacy data; both report generators fall back to it.
4. `date_dmy` server validation: `re.fullmatch(r"\d{2}/\d{2}/\d{4}")` then `datetime.strptime(sval, "%d/%m/%Y")` — errors: `"...: invalid date, expected DD/MM/YYYY"` and `"...: '<val>' is not a valid calendar date (DD/MM/YYYY)"`.

### Migration 0010 (applied live)

[backend/migrations/0010_primer_top_coat_and_batch_fields.sql](backend/migrations/0010_primer_top_coat_and_batch_fields.sql): alters the case-type CHECK; inserts the 4 template rows copied from `primer_intermediate_top` (stage_order remapped 1-4, top_coat `dft_window` → `primer_top_cumulative`); injects batch/expiry into all coat-stage templates via `jsonb_array_elements ... WITH ORDINALITY` slicing before `operator_name`; strips `batch_number_%`/`expiry_date_%` from all `curing_qa` templates; re-snapshots open `work_order_stages`.

---

## 4. Report generation (NOV template) — how it works now

Two generators exist:

- **[backend/report_generation/nov_payload.py](backend/report_generation/nov_payload.py)** builds the payload for `fill_nov_report.py` (openpyxl xlsx filler — **user forbade rewriting that module**; keep it byte-identical in behavior). Key structures (lines ~16-27):

  ```python
  CASE_COAT_COLUMNS = {
      "only_primer":             {"primer_coat": "primer"},
      "primer_intermediate":     {"primer_coat": "primer", "intermediate_coat": "second"},
      "primer_intermediate_top": {"primer_coat": "primer", "intermediate_coat": "second", "top_coat": "third"},
      "primer_top_coat":         {"primer_coat": "primer", "top_coat": "second"},
      "top_coat_only":           {"top_coat": "third"},
  }
  STAGE_ROLE = {"primer_coat": "primer", "intermediate_coat": "intermediate", "top_coat": "top"}
  CUMULATIVE_WINDOWS = ("mid_cumulative", "primer_top_cumulative", "total")
  ```

  Per coat stage: batch = `fields.get("batch_number")` falling back to legacy `curing_qa` `batch_number_{role}`; spec window from `coat_limits[role]`; measured DFT differenced from the previous cumulative reading when `dft_window ∈ CUMULATIVE_WINDOWS`. `cure_test.batch_no` is still the **primer** batch.

- **[backend/reports.py](backend/reports.py)** (older/simpler report) — same batch/expiry fallback pattern at lines 93-94.

### Report endpoint + email pipeline (committed earlier, working)

`POST /api/work-orders/{id}/generate-report` ([server.py:1355](backend/server.py#L1355)): builds payload → `fill_nov_report.py` → xlsx → **CloudConvert v2** xlsx→pdf → emails via Gmail SMTP → returns `download_url`/`xlsx_download_url` (served by `GET /reports/{report_id}` accepting Bearer or `?token=`). Recipients: `report_recipients` table, autocomplete via `GET /api/report-recipients`; new emails upserted on first use.

**CloudConvert flow** ([server.py:1218-1283](backend/server.py#L1218)): POST `/v2/jobs` (import/upload → convert → export/url) → multipart upload to `result.form` (file field literally named `file` and must be **last** — `requests`' data-before-files ordering satisfies this) → poll `GET /jobs/{id}` → download `export` task's `result.files[0].url`. 180 s cap. Raises if `CLOUDCONVERT_API_KEY` unset — **expected locally**; conversion + email are only fully verifiable on Railway.

---

## 5. Frontend stage-capture screen

[frontend/app/work-order/[id]/stage/[stage].tsx](frontend/app/work-order/[id]/stage/[stage].tsx):

- `maskDmy(v)` (line ~45): digits only, auto-inserts "/" after DD and MM, max 8 digits. `dmyIssue(v)` (line ~53): regex + day 01-31 / month 01-12 range + `Date` round-trip calendar check; returns a message or null.
- `date_dmy` renders a masked `TextInput` (number-pad, maxLength 10, placeholder "DD/MM/YYYY") with an inline warning from `dmyIssue` (line ~380).
- `needsReadings = !!stageMeta?.requires_coat_readings` (line ~225) hides the Environmental/Weather and Surface Temperature cards for Curing + QA and drops them from `canStart` / `canSubmit` / pass-fail computation (lines 227-228, 287). A typed-but-invalid DMY date blocks both start and submit (`dmyOk`, line ~221).

`npx tsc --noEmit` was clean after the last frontend edit (re-verify cheaply if anything changed since).

---

## 6. Tests

Stack: throwaway **Docker Postgres 17 per pytest session** (`backend/tests/conftest.py`), API under test on **port 8002**. Fixtures in `backend/tests/fixtures/`:

- `schema_baseline.sql` — schema-only pg_dump of the live DB. **pg_dump 17 emits `CREATE SCHEMA public;` which must be stripped** (`sed -i '/^CREATE SCHEMA public;$/d' ...`) or the docker DB errors "schema public already exists". Both fixtures were regenerated post-0010 via `docker run --rm --network host postgres:17 pg_dump "$DBURL"`.
- `reference_data.sql` — `--data-only --column-inserts` of 6 tables: `approved_paint_suppliers, case_type_stage_templates, operators, paint_products, paint_system_specifications, ral_shades`.

Last full run: **45 passed, 1 skipped** (the skip is the CloudConvert test — no key locally). Run with `cd backend && venv/bin/python -m pytest tests/ -q`. Note: port 8002 must be free (a stray uvicorn there breaks conftest; also never `pkill -f uvicorn.*8002` from inside a Bash tool call — the pattern once matched the wrapping shell itself).

Notable tests in [backend/tests/test_coating_portal.py](backend/tests/test_coating_portal.py):
- `CASE_SEQUENCES` includes `primer_top_coat: [surface_prep, primer_coat, top_coat, curing_qa]` (line 25); `_valid_fields` fills `date_dmy` with `"01/03/2027"`.
- `test_batch_expiry_at_coat_stage_start_not_curing_qa` — batch/expiry present at coat start before `operator_name`, absent from curing_qa/surface_prep, missing batch → 400 on `/start`.
- `test_bad_expiry_date_blocked_at_coat_start` — parametrized: `2027-03-15`, `15-03-2027` → "expected DD/MM/YYYY"; `31/02/2027`, `15/13/2027` → "not a valid calendar date".
- `test_primer_top_coat_uses_primer_top_cumulative_window` — window = primer+top sums; over-window hard-blocks 422.
- `test_wft_check_currently_skipped` — see §8 (documents intentionally-missing WFT validation).

### E2E verification already performed (live DB, local server on port 8003)

- **WO-2026-0039** (primer_top_coat, paint_system spec id `007dd88e-7631-478f-936a-11948a30e2c7`): all 4 stages completed via the two-step start/submit API; bad expiry dates rejected 422 with the exact messages; curing_qa started AND submitted with all-null readings. Report built through the real `build_nov_payload` + `fill_report` path; PDF (rendered locally with LibreOffice just for viewing) visually verified: Primer column = batch PB-PRIMER-1234 / CARBOZINC 11, **2nd** column = batch PB-TOP-5678 / CARBOTHANE 134 HG (RAL 3001); DFT spec Primer 3–5 mils, 2nd 2–3 mils (per-coat); measured 3.94 / 3.15 mils (cumulative 180 µm − 100 µm differenced correctly); cure-test batch = PB-PRIMER-1234. The endpoint's own run stopped only at CloudConvert (500 "CLOUDCONVERT_API_KEY not set" — expected locally).
- **WO-2026-0038** (existing only_primer WO, re-snapshotted by 0010) spot-check passed: primer_coat has `batch_number` + `expiry_date` (type `date_dmy`, phase `start`, before operator fields); curing_qa fields are `[process_start_time, mek_test, curing_room_temp, adhesion_tape, process_end_time]` — no batch/expiry — and `requires_coat_readings=false`.

---

## 7. Immediate next actions (in order)

1. **Commit + push** the uncommitted work in logical chunks **only when the user asks** (their established pattern). Suggested split: (a) migration 0010 + backend server/report changes, (b) tests + regenerated fixtures, (c) frontend changes.
2. Nothing else from the primer_top_coat task is outstanding — it is functionally complete and verified.

## 8. Known pending items (user-acknowledged, NOT in current scope — do not "fix" unprompted)

- **WFT validation is currently skipped everywhere.** Migration 0009 removed `volume_pct_solids`; the replacement ratio-based formula `WFT_max = DFT_max × wft_to_dft_ratio` is NOT yet implemented in code. `test_wft_check_currently_skipped` documents this (wft_um=9999 passes) with a TODO. The DB side (0009 + mixing-ratio seed data) is done — user applied 0009 manually via the Supabase SQL editor; never re-run it.
- **Email send** has never been verified anywhere (Gmail creds Railway-only). **CloudConvert conversion** likewise only verifiable on Railway (or by adding the key to backend/.env). After the next deploy, a production smoke test of `generate-report` would close both.
- `work_orders.dft_window`… correction: the `dft_window` **column on stage templates/stages has no CHECK constraint**, so `primer_top_cumulative` needed no DDL there.

## 9. Statements NOT re-verifiable at handoff time

**All resolved on 2026-07-17 — nothing in this document rests on chat history alone:**

- Live DB re-queried directly: `primer_top_coat` stages `[(surface_prep,1,None),(primer_coat,2,'primer'),(top_coat,3,'primer_top_cumulative'),(curing_qa,4,None)]`; CHECK constraint includes all 5 case types; every coat-stage template across all case types has `batch_number` + `date_dmy` `expiry_date`, and no `surface_prep`/`curing_qa` template carries any batch/expiry key; no `curing_qa` has `requires_coat_readings=true`; exactly 1 `primer_top_coat` work order exists (WO-2026-0039).
- Fresh test run: **45 passed, 1 skipped in 10.66s**. Fresh `npx tsc --noEmit`: clean.
- The background dev server on port 8003 (task `bal448csr`) has been stopped.

The only things still unverifiable from this environment: CloudConvert conversion and Gmail send in production (Railway-only secrets) — see §15.

## 10. Operational gotchas (hard-won, don't relearn)

- `backend/.env` values are quoted → use `dotenv_values`, never `grep|cut`, especially before shell redirections that truncate files.
- Strip `CREATE SCHEMA public;` from any freshly regenerated `schema_baseline.sql`.
- asyncpg against Supabase's pooler needs `statement_cache_size=0` for ad-hoc scripts.
- The Bash tool's persistent shell cwd can silently reset to the repo root — use absolute paths or re-`cd` per command (a spot-check once failed with exit 127 on `venv/bin/python` for exactly this reason).
- Migrations 0009 and 0010 are **already applied** to the live DB. Only future migrations (0011+) need applying.

---

# 11. INTERRUPTED CONTEXT

At session end I was in the **final verification pass for this handoff document** — not implementation. Specifically:

- Last active task: re-running (a) a direct SQL check of the live Supabase DB confirming migration 0010's effects (primer_top_coat template rows, CHECK constraint text, batch/expiry field placement across all 5 case types), and (b) the full pytest suite, so that §9 could be emptied.
- Why: the user asked that every statement in this document be verified against the current repository, not chat history.
- Type: **verification/documentation only**. All underlying implementation was already complete and verified earlier in the session.
- Required? **Optional.** Both checks passed earlier in the session against an identical tree; the re-run was belt-and-braces. A transient tool-permission outage ("claude-opus-4-8 temporarily unavailable" classifier errors) blocked Bash/MCP intermittently, which is the only reason they didn't complete.
- The background dev server (uvicorn on port 8003 against the live DB, task `bal448csr`) **has been stopped** — no stray server remains from this session. Port 8002 should also be free for pytest.

---

# 12. REMAINING TASK QUEUE

1. **Commit + push the primer_top_coat work in logical chunks** — Priority: **Critical** — 0% done — Files: all 9 modified files + migration 0010 (see §2) — Depends on: nothing (user has now explicitly requested commit-as-you-confirm) — MUST be completed. Suggested chunks: (a) migration 0010 + backend, (b) tests + fixtures, (c) frontend.
2. **Re-run full pytest suite before committing** — High — previously 45 passed / 1 skipped on the identical tree — Files: none (verification) — MUST (cheap insurance): `cd backend && venv/bin/python -m pytest tests/ -q`.
3. **Direct SQL re-verification of live DB 0010 state** — Medium — verified twice indirectly (in-transaction at apply time; via API spot-check of WO-2026-0038) — a ready-made script is described in §9 — optional but quick.
4. **Railway production smoke test of `generate-report`** — High — 0% verifiable locally — verifies both CloudConvert conversion AND Gmail email send, neither of which has EVER been confirmed in production (keys are Railway-only). Needs a deployed backend; check recent Railway deploy status of commit `c431b36`+ or ask the user — I have no Railway visibility.
5. **24-hour time format for all stage timestamps** — Medium (user: "if time/budget permits") — 0% — likely files: frontend stage screen + any `_fmt_time` in `backend/report_generation/nov_payload.py` / `reports.py` — not started; scope not yet clarified (display only vs. stored values).
6. **"Shift" field (First Shift / Second Shift)** — Medium (same "if time permits") — 0% — user left level ambiguous ("work-order or stage level") and explicitly said to ask rather than guess → **ask the user which level** before implementing. Touches: migration 0011, server.py models, new.tsx or stage screen, possibly reports.
7. **WFT ratio-based validation** (`WFT_max = DFT_max × wft_to_dft_ratio`) — Low/deferred — user-acknowledged pending item, NOT in current scope; DB side (0009 + ratio seed data) done. `test_wft_check_currently_skipped` carries the TODO.
8. Decide whether `PROJECT_HANDOFF_OPUS48.md` itself gets committed (user never said; it's untracked).

---

# 13. PREVIOUS PROMPTS STILL NOT FULLY SATISFIED

1. **NOV report endpoint + email + recipient autocomplete** — ✅ Completed and committed (`b6f0fd7`, `1eca008`). Caveat: email send never verified anywhere (Gmail creds Railway-only).
2. **"Commit all changes in logical chunks and push; 0009 is applied, commit for record-keeping"** — ✅ Completed for that batch.
3. **CloudConvert xlsx→PDF replacing LibreOffice** — ✅ Code completed and committed (`b615c2e`, plus `c431b36` to trigger a rebuild). ❗ Partially unverified: whether the Railway deployment succeeded and conversion works in production was never confirmed (no Railway visibility from this environment). This is the user's item A.
4. **primer_top_coat + batch/expiry + Curing+QA cleanup (items B, C, D)** — ✅ Functionally complete, migration applied to live DB, 45/46 tests green, E2E verified on WO-2026-0039 + spot-check WO-2026-0038. ❗ Not yet committed/pushed (was awaiting user request — that request has now arrived).
5. **This handoff document** — ✅ Written; ❗ the final independent re-verification of the live-DB state and a fresh pytest run were interrupted (see §11).
6. **New (final message): audit A-D, then 24h time + Shift field if time permits, commit as confirmed** — audit satisfied by this document + §18; items 5-6 of §12 not started; Shift-field level needs a user answer.

---

# 14. UNWRITTEN IMPLEMENTATION

- **24-hour time format** — no code written. Intended approach (not yet designed in detail): normalize time display in the frontend stage screen and report formatters (`_fmt_time` in nov_payload.py already produces %H:%M from timestamps — the visible gap, if any, is likelier in frontend display and in `process_start_time`/`process_end_time` free-text `time` fields, which are already validated as HH:MM by `dt_time.fromisoformat` server-side). Reason not implemented: request arrived at session end.
- **Shift field** — no code written; blocked on the work-order-level vs stage-level question. Reason: user said ask, don't guess.
- **WFT ratio formula** — deliberately unwritten (out of scope per user).
- Otherwise: **None** — everything else described in this document exists in the working tree.

---

# 15. UNVERIFIED ASSUMPTIONS

**High confidence (verified earlier this session, not re-verified at the very end):**
- Migration 0010's full effect on the live DB (asserted in-transaction at apply time; independently corroborated by API responses for WO-2026-0038/0039 that could not look as they do otherwise).
- Test suite passes on the current tree (45 passed / 1 CloudConvert skip; zero code changes since that run).
- `npx tsc --noEmit` clean (ran clean after the last frontend edit).

**Medium confidence:**
- CloudConvert conversion works end-to-end in production (code follows the documented v2 job flow and was exercised up to the API-key check locally; never run with a real key).
- ~~Railway deployment of `c431b36` built and started successfully~~ **DISPROVEN 2026-07-17:** production (`https://coating-app-prototype-production.up.railway.app`) still returns the pre-CloudConvert "LibreOffice not found" error from `generate-report`, 15+ minutes after fresh pushes. The running build predates commit `b615c2e` — Railway has not deployed anything from at least the last ~7 commits. The deploy pipeline is broken or auto-deploy is disconnected; only the Railway dashboard (build logs / service settings) can show why. This blocks verifying CloudConvert AND email, and means none of today's features are live yet.

**Low confidence:**
- Gmail email delivery works with the Railway `GMAIL_USER`/`GMAIL_APP_PASSWORD` (never exercised anywhere; SMTP code path is standard but credentials/app-password validity is unproven).

---

# 16. ENGINEER'S MEMORY DUMP

- **Never modify `backend/report_generation/fill_nov_report.py`** — user explicitly forbade rewriting it; all report changes go through the payload builder (`nov_payload.py`).
- `top_coat_only` maps its single coat to the **"third"** column (historical behavior, deliberately preserved in `CASE_COAT_COLUMNS`); do not "fix" it to first/second.
- `cure_test.batch_no` on the NOV report is deliberately the **primer** batch.
- RAL colors like "RAL 3001 · Signal red" overflow the template's COLOR column — `nov_payload.py` splits on "·" and keeps only the code. Keep that.
- Per-coat DFT on the report = current cumulative reading − previous stage's cumulative reading, only when the stage's `dft_window ∈ CUMULATIVE_WINDOWS`; a single measured value is written to both min and max measured cells.
- Curing + QA can start AND submit with all-null environmental readings (that's the point of `requires_coat_readings=false`); the frontend result computation must not require `gate.ok` there (`(!needsReadings || gate.ok)`).
- Field validation: `hard_block_max` ranges reject with **422** at submit; ordinary failures mark result "fail" but submit succeeds — tests rely on this distinction.
- `_validate_stage_fields` checks `phase: "start"` fields at `/start` (missing required start field → **400**).
- Migration re-snapshots touch **only pending/in_progress** stages — completed stages keep their historical field snapshots, which is why both report generators need the legacy `batch_number_{role}`/`expiry_date_{role}` curing_qa fallbacks forever (old completed WOs).
- The templates' `INSERT` in 0010 is not idempotent (unique constraint would reject a re-run); the field-injection UPDATE is guarded. Never blind-re-run migrations against the live DB.
- Supabase pooler: asyncpg needs `statement_cache_size=0`.
- pg_dump for fixtures must run in docker (`postgres:17` image, `--network host`) to match server version; strip `CREATE SCHEMA public;`; reference_data is `--data-only --column-inserts` of exactly the 6 tables listed in §6.
- conftest.py owns port **8002**; the throwaway docker Postgres is created per pytest session — first run pulls the image (slow once).
- `frontend` picker for case types is server-driven (`/case-types`); only the human label lives in `CASE_TYPE_LABELS` in new.tsx.
- `maskDmy` keeps only digits and re-inserts slashes — pasting "31/02/2027" is representable, so `dmyIssue`'s Date round-trip check is what actually blocks impossible dates client-side; the server re-validates regardless.
- The `GET /reports/{report_id}` download route accepts `?token=` as an alternative to the Bearer header so PDFs can open in a plain browser tab.
- CloudConvert upload: the multipart `file` field must be LAST in the form; python-requests' behavior of sending `data` before `files` satisfies this naturally — don't reorder.
- Dead end to avoid: don't try to verify email/CloudConvert locally; the env vars intentionally exist only on Railway.
- Live test WOs created this session: **WO-2026-0039** (primer_top_coat, fully completed, good demo order) and WO-2026-0038 (only_primer, used for the re-snapshot spot-check).

---

# 17. IF YOU HAD ONE MORE HOUR

1. Re-run the pytest suite (~1 min incl. docker) — guard against anything having drifted (why: about to commit).
2. Commit + push in three chunks: backend+migration, tests+fixtures, frontend (why: user explicitly requested commit-as-confirmed; everything A-D is confirmed).
3. Run the 30-second live-DB SQL re-check from §9 and empty §9 (why: closes the last verification gap in this document).
4. Check/ask about the Railway deploy of `c431b36`, then hit `POST /api/work-orders/WO-2026-0039/generate-report` against production with a real recipient (why: single test that proves CloudConvert AND email — the only two never-verified pieces of A).
5. Ask the user one question — Shift field at work-order level or per-stage? — then implement 24-hour time + Shift (migration 0011, models, UI, report), testing on a fresh WO (why: their item 4, and the only genuinely new code left).

---

# 18. FINAL CONFIDENCE

**Is the "Primer + Top Coat" implementation fully complete? YES.**

Remaining verification/deployment work only:
1. Commit + push the working tree (chunks per §12.1).
2. Fresh pytest run immediately before committing (paranoia-level, tree unchanged since the green run).
3. Optional direct SQL re-check of live-DB 0010 state (§9 script).
4. Production smoke test on Railway: one `generate-report` call proving CloudConvert xlsx→pdf and Gmail delivery (the only parts of the whole session's work never executed with real credentials).
