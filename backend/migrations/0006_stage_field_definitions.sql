-- Phase 3: per-stage field definitions (typed inputs, dropdowns, batch/expiry).
-- Each template row gets a `fields` jsonb array of descriptors:
--   key, label, type: dropdown|ok_notok|pass_fail|number|decimal|text|date|note
--   unit, required, fail_on (value that fails the stage),
--   range: anchor_profile|dft_window|wft|pct (server-side validation window),
--   hard_block_max (DFT over max blocks submission),
--   options: brands|products.primer|products.intermediate|products.top|colors|shades|ral
--   depends_on: key of the field that filters this dropdown's options.
-- work_order_stages snapshots the array at WO creation, like params/dft_window.

alter table case_type_stage_templates add column if not exists fields jsonb not null default '[]';
alter table work_order_stages         add column if not exists fields jsonb not null default '[]';

-- ---------- Surface Preparation (identical in all 4 cases) ----------
update case_type_stage_templates set fields = '[
  {"key":"oil_water_test","label":"Oil/Water in Compressed Air Test","type":"ok_notok","required":true,"fail_on":"NOT_OK"},
  {"key":"surface_profile_mils","label":"Surface Profile (Blast Cleaned Steel)","type":"number","unit":"mils","range":"anchor_profile","required":true},
  {"key":"anchor_profile_mils","label":"Anchor Profile","type":"number","unit":"mils","range":"anchor_profile","required":true}
]'::jsonb
where stage_key = 'surface_prep';

-- ---------- Primer Coat (only_primer, primer_intermediate, primer_intermediate_top) ----------
update case_type_stage_templates set fields = '[
  {"key":"brand","label":"Primer Paint Brand","type":"dropdown","options":"brands","required":true},
  {"key":"product","label":"Primer Paint Product","type":"dropdown","options":"products.primer","depends_on":"brand","required":true},
  {"key":"color","label":"Primer Coat Color","type":"dropdown","options":"colors","required":true},
  {"key":"volume_pct_solids","label":"Primer Volume % Solids","type":"decimal","unit":"%","range":"pct","required":true},
  {"key":"wt_pct_zinc","label":"Primer wt % Zinc in DFT","type":"decimal","unit":"%","range":"pct","required":true},
  {"key":"wft_um","label":"Measurement of WFT","type":"number","unit":"µm","range":"wft","required":true},
  {"key":"visual_inspection","label":"Visual Inspection","type":"ok_notok","required":true,"fail_on":"NOT_OK"},
  {"key":"dft_um","label":"Primer DFT","type":"number","unit":"µm","range":"dft_window","hard_block_max":true,"required":true},
  {"key":"operator_name","label":"Operator Name","type":"text","required":true},
  {"key":"operator_designation","label":"Operator Designation","type":"text","required":true}
]'::jsonb
where stage_key = 'primer_coat';

-- ---------- Intermediate Coat (primer_intermediate, primer_intermediate_top) ----------
update case_type_stage_templates set fields = '[
  {"key":"brand","label":"Intermediate Paint Brand","type":"dropdown","options":"brands","required":true},
  {"key":"product","label":"Intermediate Paint Product","type":"dropdown","options":"products.intermediate","depends_on":"brand","required":true},
  {"key":"color","label":"Intermediate Coat Color","type":"dropdown","options":"colors","required":true},
  {"key":"volume_pct_solids","label":"Intermediate Volume % Solids","type":"decimal","unit":"%","range":"pct","required":true},
  {"key":"wft_um","label":"Measurement of WFT","type":"number","unit":"µm","range":"wft","required":true},
  {"key":"visual_inspection","label":"Visual Inspection","type":"note","required":false},
  {"key":"dft_um","label":"Intermediate DFT (cumulative)","type":"number","unit":"µm","range":"dft_window","hard_block_max":true,"required":true},
  {"key":"operator_name","label":"Operator Name","type":"text","required":true},
  {"key":"operator_designation","label":"Operator Designation","type":"text","required":true}
]'::jsonb
where stage_key = 'intermediate_coat';

-- ---------- Top Coat (primer_intermediate_top, top_coat_only) ----------
update case_type_stage_templates set fields = '[
  {"key":"brand","label":"Top Coat Paint Brand","type":"dropdown","options":"brands","required":true},
  {"key":"product","label":"Top Coat Paint Product","type":"dropdown","options":"products.top","depends_on":"brand","required":true},
  {"key":"paint_shade","label":"Paint Shade","type":"dropdown","options":"shades","depends_on":"product","required":false},
  {"key":"ral_shade","label":"RAL Shade","type":"dropdown","options":"ral","required":false},
  {"key":"volume_pct_solids","label":"Top Coat Volume % Solids","type":"decimal","unit":"%","range":"pct","required":true},
  {"key":"wft_um","label":"Measurement of WFT","type":"number","unit":"µm","range":"wft","required":true},
  {"key":"visual_inspection","label":"Visual Inspection","type":"ok_notok","required":true,"fail_on":"NOT_OK"},
  {"key":"dft_um","label":"Top Coat DFT","type":"number","unit":"µm","range":"dft_window","hard_block_max":true,"required":true},
  {"key":"operator_name","label":"Operator Name","type":"text","required":true},
  {"key":"operator_designation","label":"Operator Designation","type":"text","required":true}
]'::jsonb
where stage_key = 'top_coat';

-- ---------- Curing + QA: base checks + Batch & Expiry per coat used in the case ----------
update case_type_stage_templates set fields = '[
  {"key":"mek_test","label":"MEK Resistance Test","type":"pass_fail","required":true,"fail_on":"FAIL"},
  {"key":"curing_room_temp","label":"Curing at Room Temp","type":"ok_notok","required":true,"fail_on":"NOT_OK"},
  {"key":"adhesion_tape","label":"Adhesion Tape Inspection","type":"note","required":false},
  {"key":"batch_number_primer","label":"Primer Batch Number","type":"text","required":true},
  {"key":"expiry_date_primer","label":"Primer Expiry Date","type":"date","required":true}
]'::jsonb
where stage_key = 'curing_qa' and case_type = 'only_primer';

update case_type_stage_templates set fields = '[
  {"key":"mek_test","label":"MEK Resistance Test","type":"pass_fail","required":true,"fail_on":"FAIL"},
  {"key":"curing_room_temp","label":"Curing at Room Temp","type":"ok_notok","required":true,"fail_on":"NOT_OK"},
  {"key":"adhesion_tape","label":"Adhesion Tape Inspection","type":"note","required":false},
  {"key":"batch_number_primer","label":"Primer Batch Number","type":"text","required":true},
  {"key":"expiry_date_primer","label":"Primer Expiry Date","type":"date","required":true},
  {"key":"batch_number_intermediate","label":"Intermediate Batch Number","type":"text","required":true},
  {"key":"expiry_date_intermediate","label":"Intermediate Expiry Date","type":"date","required":true}
]'::jsonb
where stage_key = 'curing_qa' and case_type = 'primer_intermediate';

update case_type_stage_templates set fields = '[
  {"key":"mek_test","label":"MEK Resistance Test","type":"pass_fail","required":true,"fail_on":"FAIL"},
  {"key":"curing_room_temp","label":"Curing at Room Temp","type":"ok_notok","required":true,"fail_on":"NOT_OK"},
  {"key":"adhesion_tape","label":"Adhesion Tape Inspection","type":"note","required":false},
  {"key":"batch_number_primer","label":"Primer Batch Number","type":"text","required":true},
  {"key":"expiry_date_primer","label":"Primer Expiry Date","type":"date","required":true},
  {"key":"batch_number_intermediate","label":"Intermediate Batch Number","type":"text","required":true},
  {"key":"expiry_date_intermediate","label":"Intermediate Expiry Date","type":"date","required":true},
  {"key":"batch_number_top","label":"Top Coat Batch Number","type":"text","required":true},
  {"key":"expiry_date_top","label":"Top Coat Expiry Date","type":"date","required":true}
]'::jsonb
where stage_key = 'curing_qa' and case_type = 'primer_intermediate_top';

update case_type_stage_templates set fields = '[
  {"key":"mek_test","label":"MEK Resistance Test","type":"pass_fail","required":true,"fail_on":"FAIL"},
  {"key":"curing_room_temp","label":"Curing at Room Temp","type":"ok_notok","required":true,"fail_on":"NOT_OK"},
  {"key":"adhesion_tape","label":"Adhesion Tape Inspection","type":"note","required":false},
  {"key":"batch_number_top","label":"Top Coat Batch Number","type":"text","required":true},
  {"key":"expiry_date_top","label":"Top Coat Expiry Date","type":"date","required":true}
]'::jsonb
where stage_key = 'curing_qa' and case_type = 'top_coat_only';
