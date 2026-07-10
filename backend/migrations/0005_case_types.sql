-- Case-type-driven conditional workflows (4 case types, per spec):
--   only_primer             : Surface Prep -> Primer -> Curing+QA
--   primer_intermediate     : Surface Prep -> Primer -> Intermediate Coat -> Curing+QA
--   primer_intermediate_top : Surface Prep -> Primer -> Intermediate Coat -> Top Coat -> Curing+QA
--   top_coat_only           : Surface Prep -> Top Coat -> Curing+QA
--
-- Templates define each case type's stage sequence + per-stage field set;
-- work_order_stages rows are copied from them at WO creation (snapshot).
-- work_orders/work_order_stages are empty at time of migration (seed data
-- was purged), so case_type is NOT NULL with no default: every new WO must
-- state its case type explicitly.
--
-- Touches: case_type_stage_templates (new), work_orders (+1 col +check),
-- work_order_stages (+2 cols). Does NOT reference paint_system_specifications,
-- approved_paint_suppliers, inspectors, audit_log, quota, or wo_counters.

create table case_type_stage_templates (
    id uuid primary key default gen_random_uuid(),
    case_type text not null,
    stage_key text not null,
    stage_order int not null,
    name text not null,
    description text not null,
    requires_coat_readings boolean not null default false,
    -- measured parameters this stage takes, e.g. ["dft_um"]
    params jsonb not null default '[]',
    -- which coat_limits window validates dft_um: primer | mid_cumulative | top | total
    dft_window text,
    unique (case_type, stage_key),
    unique (case_type, stage_order)
);

alter table work_orders
    add column case_type text not null;
alter table work_orders
    add constraint work_orders_case_type_check
    check (case_type in ('only_primer','primer_intermediate','primer_intermediate_top','top_coat_only'));

alter table work_order_stages
    add column params jsonb not null default '[]',
    add column dft_window text;

insert into case_type_stage_templates
    (case_type, stage_key, stage_order, name, description, requires_coat_readings, params, dft_window)
values
-- only_primer
('only_primer', 'surface_prep',      1, 'Surface Prep',      'Degreasing and mechanical abrasion', true,  '["surface_profile_um","soluble_salts_mg_m2"]', null),
('only_primer', 'primer_coat',       2, 'Primer Coat',       'Primer application',                 true,  '["dft_um"]', 'primer'),
('only_primer', 'curing_qa',         3, 'Curing + QA',       'Cure cycle, visual and adherence testing', false, '[]', null),
-- primer_intermediate
('primer_intermediate', 'surface_prep',      1, 'Surface Prep',      'Degreasing and mechanical abrasion', true,  '["surface_profile_um","soluble_salts_mg_m2"]', null),
('primer_intermediate', 'primer_coat',       2, 'Primer Coat',       'Primer application',                 true,  '["dft_um"]', 'primer'),
('primer_intermediate', 'intermediate_coat', 3, 'Intermediate Coat', 'Intermediate coat application',      true,  '["dft_um"]', 'mid_cumulative'),
('primer_intermediate', 'curing_qa',         4, 'Curing + QA',       'Cure cycle, visual and adherence testing', false, '[]', null),
-- primer_intermediate_top
('primer_intermediate_top', 'surface_prep',      1, 'Surface Prep',      'Degreasing and mechanical abrasion', true,  '["surface_profile_um","soluble_salts_mg_m2"]', null),
('primer_intermediate_top', 'primer_coat',       2, 'Primer Coat',       'Primer application',                 true,  '["dft_um"]', 'primer'),
('primer_intermediate_top', 'intermediate_coat', 3, 'Intermediate Coat', 'Intermediate coat application',      true,  '["dft_um"]', 'mid_cumulative'),
('primer_intermediate_top', 'top_coat',          4, 'Top Coat',          'Finish layer application',          true,  '["dft_um"]', 'total'),
('primer_intermediate_top', 'curing_qa',         5, 'Curing + QA',       'Cure cycle, visual and adherence testing', false, '[]', null),
-- top_coat_only
('top_coat_only', 'surface_prep', 1, 'Surface Prep', 'Degreasing and mechanical abrasion', true,  '["surface_profile_um","soluble_salts_mg_m2"]', null),
('top_coat_only', 'top_coat',     2, 'Top Coat',     'Finish layer application',          true,  '["dft_um"]', 'top'),
('top_coat_only', 'curing_qa',    3, 'Curing + QA',  'Cure cycle, visual and adherence testing', false, '[]', null);
