-- Phase 2 (field timing) + report infrastructure.
-- Field defs gain "phase": start | end — start-phase fields are captured when
-- the stage is started (paint identification / operator attribution), end-phase
-- at final submission (results). Batch+Expiry stay on curing_qa but move to its
-- start phase (per clarified spec). Operator name/designation become dropdowns
-- backed by the operators table. Optional process start/end time fields added.

alter table work_order_stages
    add column if not exists start_fields jsonb not null default '{}',
    add column if not exists start_photos jsonb not null default '[]';

-- Saved recipients for report distribution
create table report_recipients (
    id uuid primary key default gen_random_uuid(),
    name text not null,
    email text not null unique,
    created_at timestamptz not null default now()
);

-- Generated report copies (cloud-backed record-keeping: rows live in the
-- Supabase Postgres cloud; content stored inline for prototype scale)
create table generated_reports (
    id uuid primary key default gen_random_uuid(),
    work_order_id text not null,
    format text not null check (format in ('pdf', 'xlsx')),
    filename text not null,
    content bytea not null,
    created_by text,
    created_at timestamptz not null default now()
);
create index idx_generated_reports_wo on generated_reports (work_order_id);

-- ---------- template field definitions, now with phases ----------

-- Surface Preparation (all cases): results are end-phase; optional times
update case_type_stage_templates set fields = '[
  {"key":"process_start_time","label":"Process Start Time","type":"time","phase":"start","required":false},
  {"key":"oil_water_test","label":"Oil/Water in Compressed Air Test","type":"ok_notok","phase":"end","required":true,"fail_on":"NOT_OK"},
  {"key":"surface_profile_mils","label":"Surface Profile (Blast Cleaned Steel)","type":"number","unit":"mils","range":"anchor_profile","phase":"end","required":true},
  {"key":"anchor_profile_mils","label":"Anchor Profile","type":"number","unit":"mils","range":"anchor_profile","phase":"end","required":true},
  {"key":"process_end_time","label":"Process End Time","type":"time","phase":"end","required":false}
]'::jsonb
where stage_key = 'surface_prep';

-- Primer Coat: identification + operator at start; results at end
update case_type_stage_templates set fields = '[
  {"key":"brand","label":"Primer Paint Brand","type":"dropdown","options":"brands","phase":"start","required":true},
  {"key":"product","label":"Primer Paint Product","type":"dropdown","options":"products.primer","depends_on":"brand","phase":"start","required":true},
  {"key":"color","label":"Primer Coat Color","type":"dropdown","options":"colors","phase":"start","required":true},
  {"key":"volume_pct_solids","label":"Primer Volume % Solids","type":"decimal","unit":"%","range":"pct","phase":"start","required":true},
  {"key":"wt_pct_zinc","label":"Primer wt % Zinc in DFT","type":"decimal","unit":"%","range":"pct","phase":"start","required":true},
  {"key":"operator_name","label":"Operator Name","type":"dropdown","options":"operators","phase":"start","required":true},
  {"key":"operator_designation","label":"Operator Designation","type":"dropdown","options":"operator_designations","phase":"start","required":true},
  {"key":"process_start_time","label":"Process Start Time","type":"time","phase":"start","required":false},
  {"key":"wft_um","label":"Measurement of WFT","type":"number","unit":"µm","range":"wft","phase":"end","required":true},
  {"key":"visual_inspection","label":"Visual Inspection","type":"ok_notok","phase":"end","required":true,"fail_on":"NOT_OK"},
  {"key":"dft_um","label":"Primer DFT","type":"number","unit":"µm","range":"dft_window","hard_block_max":true,"phase":"end","required":true},
  {"key":"process_end_time","label":"Process End Time","type":"time","phase":"end","required":false}
]'::jsonb
where stage_key = 'primer_coat';

-- Intermediate Coat: as primer minus zinc; visual is a note
update case_type_stage_templates set fields = '[
  {"key":"brand","label":"Intermediate Paint Brand","type":"dropdown","options":"brands","phase":"start","required":true},
  {"key":"product","label":"Intermediate Paint Product","type":"dropdown","options":"products.intermediate","depends_on":"brand","phase":"start","required":true},
  {"key":"color","label":"Intermediate Coat Color","type":"dropdown","options":"colors","phase":"start","required":true},
  {"key":"volume_pct_solids","label":"Intermediate Volume % Solids","type":"decimal","unit":"%","range":"pct","phase":"start","required":true},
  {"key":"operator_name","label":"Operator Name","type":"dropdown","options":"operators","phase":"start","required":true},
  {"key":"operator_designation","label":"Operator Designation","type":"dropdown","options":"operator_designations","phase":"start","required":true},
  {"key":"process_start_time","label":"Process Start Time","type":"time","phase":"start","required":false},
  {"key":"wft_um","label":"Measurement of WFT","type":"number","unit":"µm","range":"wft","phase":"end","required":true},
  {"key":"visual_inspection","label":"Visual Inspection","type":"note","phase":"end","required":false},
  {"key":"dft_um","label":"Intermediate DFT (cumulative)","type":"number","unit":"µm","range":"dft_window","hard_block_max":true,"phase":"end","required":true},
  {"key":"process_end_time","label":"Process End Time","type":"time","phase":"end","required":false}
]'::jsonb
where stage_key = 'intermediate_coat';

-- Top Coat: shade + RAL at start (identification); results at end
update case_type_stage_templates set fields = '[
  {"key":"brand","label":"Top Coat Paint Brand","type":"dropdown","options":"brands","phase":"start","required":true},
  {"key":"product","label":"Top Coat Paint Product","type":"dropdown","options":"products.top","depends_on":"brand","phase":"start","required":true},
  {"key":"paint_shade","label":"Paint Shade","type":"dropdown","options":"shades","depends_on":"product","phase":"start","required":false},
  {"key":"ral_shade","label":"RAL Shade","type":"dropdown","options":"ral","phase":"start","required":false},
  {"key":"volume_pct_solids","label":"Top Coat Volume % Solids","type":"decimal","unit":"%","range":"pct","phase":"start","required":true},
  {"key":"operator_name","label":"Operator Name","type":"dropdown","options":"operators","phase":"start","required":true},
  {"key":"operator_designation","label":"Operator Designation","type":"dropdown","options":"operator_designations","phase":"start","required":true},
  {"key":"process_start_time","label":"Process Start Time","type":"time","phase":"start","required":false},
  {"key":"wft_um","label":"Measurement of WFT","type":"number","unit":"µm","range":"wft","phase":"end","required":true},
  {"key":"visual_inspection","label":"Visual Inspection","type":"ok_notok","phase":"end","required":true,"fail_on":"NOT_OK"},
  {"key":"dft_um","label":"Top Coat DFT","type":"number","unit":"µm","range":"dft_window","hard_block_max":true,"phase":"end","required":true},
  {"key":"process_end_time","label":"Process End Time","type":"time","phase":"end","required":false}
]'::jsonb
where stage_key = 'top_coat';

-- Curing + QA: batch/expiry per coat move to START of this stage (per
-- clarified spec — they stay on curing_qa, just captured up front)
update case_type_stage_templates set fields = '[
  {"key":"batch_number_primer","label":"Primer Batch Number","type":"text","phase":"start","required":true},
  {"key":"expiry_date_primer","label":"Primer Expiry Date","type":"date","phase":"start","required":true},
  {"key":"process_start_time","label":"Process Start Time","type":"time","phase":"start","required":false},
  {"key":"mek_test","label":"MEK Resistance Test","type":"pass_fail","phase":"end","required":true,"fail_on":"FAIL"},
  {"key":"curing_room_temp","label":"Curing at Room Temp","type":"ok_notok","phase":"end","required":true,"fail_on":"NOT_OK"},
  {"key":"adhesion_tape","label":"Adhesion Tape Inspection","type":"note","phase":"end","required":false},
  {"key":"process_end_time","label":"Process End Time","type":"time","phase":"end","required":false}
]'::jsonb
where stage_key = 'curing_qa' and case_type = 'only_primer';

update case_type_stage_templates set fields = '[
  {"key":"batch_number_primer","label":"Primer Batch Number","type":"text","phase":"start","required":true},
  {"key":"expiry_date_primer","label":"Primer Expiry Date","type":"date","phase":"start","required":true},
  {"key":"batch_number_intermediate","label":"Intermediate Batch Number","type":"text","phase":"start","required":true},
  {"key":"expiry_date_intermediate","label":"Intermediate Expiry Date","type":"date","phase":"start","required":true},
  {"key":"process_start_time","label":"Process Start Time","type":"time","phase":"start","required":false},
  {"key":"mek_test","label":"MEK Resistance Test","type":"pass_fail","phase":"end","required":true,"fail_on":"FAIL"},
  {"key":"curing_room_temp","label":"Curing at Room Temp","type":"ok_notok","phase":"end","required":true,"fail_on":"NOT_OK"},
  {"key":"adhesion_tape","label":"Adhesion Tape Inspection","type":"note","phase":"end","required":false},
  {"key":"process_end_time","label":"Process End Time","type":"time","phase":"end","required":false}
]'::jsonb
where stage_key = 'curing_qa' and case_type = 'primer_intermediate';

update case_type_stage_templates set fields = '[
  {"key":"batch_number_primer","label":"Primer Batch Number","type":"text","phase":"start","required":true},
  {"key":"expiry_date_primer","label":"Primer Expiry Date","type":"date","phase":"start","required":true},
  {"key":"batch_number_intermediate","label":"Intermediate Batch Number","type":"text","phase":"start","required":true},
  {"key":"expiry_date_intermediate","label":"Intermediate Expiry Date","type":"date","phase":"start","required":true},
  {"key":"batch_number_top","label":"Top Coat Batch Number","type":"text","phase":"start","required":true},
  {"key":"expiry_date_top","label":"Top Coat Expiry Date","type":"date","phase":"start","required":true},
  {"key":"process_start_time","label":"Process Start Time","type":"time","phase":"start","required":false},
  {"key":"mek_test","label":"MEK Resistance Test","type":"pass_fail","phase":"end","required":true,"fail_on":"FAIL"},
  {"key":"curing_room_temp","label":"Curing at Room Temp","type":"ok_notok","phase":"end","required":true,"fail_on":"NOT_OK"},
  {"key":"adhesion_tape","label":"Adhesion Tape Inspection","type":"note","phase":"end","required":false},
  {"key":"process_end_time","label":"Process End Time","type":"time","phase":"end","required":false}
]'::jsonb
where stage_key = 'curing_qa' and case_type = 'primer_intermediate_top';

update case_type_stage_templates set fields = '[
  {"key":"batch_number_top","label":"Top Coat Batch Number","type":"text","phase":"start","required":true},
  {"key":"expiry_date_top","label":"Top Coat Expiry Date","type":"date","phase":"start","required":true},
  {"key":"process_start_time","label":"Process Start Time","type":"time","phase":"start","required":false},
  {"key":"mek_test","label":"MEK Resistance Test","type":"pass_fail","phase":"end","required":true,"fail_on":"FAIL"},
  {"key":"curing_room_temp","label":"Curing at Room Temp","type":"ok_notok","phase":"end","required":true,"fail_on":"NOT_OK"},
  {"key":"adhesion_tape","label":"Adhesion Tape Inspection","type":"note","phase":"end","required":false},
  {"key":"process_end_time","label":"Process End Time","type":"time","phase":"end","required":false}
]'::jsonb
where stage_key = 'curing_qa' and case_type = 'top_coat_only';

-- Live stage snapshots on open (pending/in-progress) work orders pick up the
-- new definitions so the restructure applies to WOs already created; completed
-- stages keep the definitions they were submitted under.
update work_order_stages s
set fields = t.fields
from case_type_stage_templates t, work_orders w
where w.id = s.work_order_id
  and t.case_type = w.case_type
  and t.stage_key = s.stage_key
  and s.status in ('pending', 'in_progress');
