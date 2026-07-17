-- 1. New case type primer_top_coat (skips Intermediate Coat only):
--      Surface Prep -> Primer Coat -> Top Coat -> Curing + QA
--    Stage rows are copied verbatim from primer_intermediate_top (per spec:
--    use the real existing definitions, no re-typing). The top_coat stage's
--    dft_window becomes 'primer_top_cumulative' — following the existing
--    skip-a-stage convention (primer_intermediate validates its final coat
--    against mid_cumulative = sum of the applied coats' windows).
-- 2. All case types: "Paint Batch Number" (text) + "Expiry Date" (date_dmy,
--    DD/MM/YYYY) are captured at the START of every coat stage, inserted
--    after the paint product/details fields (before Operator Name).
-- 3. All case types: the old per-coat batch_number_*/expiry_date_* fields are
--    REMOVED from Curing + QA (moved to the coat stages; confirmed with user).
--    Completed stages keep their submitted data; the report generators fall
--    back to the legacy curing_qa values for them.
-- 4. Open (pending/in_progress) work-order stages are re-snapshotted.

-- ---- 1. allow the new case type on work orders ----
alter table work_orders drop constraint work_orders_case_type_check;
alter table work_orders
    add constraint work_orders_case_type_check
    check (case_type in ('only_primer','primer_intermediate','primer_intermediate_top',
                         'top_coat_only','primer_top_coat'));

-- ---- 1b. template rows, copied from primer_intermediate_top ----
insert into case_type_stage_templates
    (case_type, stage_key, stage_order, name, description, requires_coat_readings, params, dft_window, fields)
select 'primer_top_coat',
       stage_key,
       case stage_key when 'surface_prep' then 1 when 'primer_coat' then 2
                      when 'top_coat' then 3 when 'curing_qa' then 4 end,
       name, description, requires_coat_readings, params,
       case when stage_key = 'top_coat' then 'primer_top_cumulative' else dft_window end,
       fields
from case_type_stage_templates
where case_type = 'primer_intermediate_top'
  and stage_key in ('surface_prep', 'primer_coat', 'top_coat', 'curing_qa');

-- ---- 2. batch number + expiry date at the start of every coat stage ----
-- inserted immediately before operator_name (i.e. after paint product/details)
update case_type_stage_templates
set fields = (
    select (select coalesce(jsonb_agg(o.elem order by o.ord), '[]'::jsonb)
            from jsonb_array_elements(fields) with ordinality o(elem, ord)
            where o.ord < p.pos)
        || '[{"key":"batch_number","label":"Paint Batch Number","type":"text","phase":"start","required":true},
             {"key":"expiry_date","label":"Expiry Date","type":"date_dmy","phase":"start","required":true}]'::jsonb
        || (select coalesce(jsonb_agg(o.elem order by o.ord), '[]'::jsonb)
            from jsonb_array_elements(fields) with ordinality o(elem, ord)
            where o.ord >= p.pos)
    from (select min(o.ord) as pos
          from jsonb_array_elements(fields) with ordinality o(elem, ord)
          where o.elem->>'key' = 'operator_name') p
)
where stage_key in ('primer_coat', 'intermediate_coat', 'top_coat')
  and not exists (select 1 from jsonb_array_elements(fields) e
                  where e->>'key' = 'batch_number');

-- ---- 3. strip the old batch/expiry fields from Curing + QA ----
update case_type_stage_templates
set fields = (
    select coalesce(jsonb_agg(elem), '[]'::jsonb)
    from jsonb_array_elements(fields) elem
    where elem->>'key' not like 'batch\_number\_%'
      and elem->>'key' not like 'expiry\_date\_%'
)
where stage_key = 'curing_qa';

-- ---- 4. re-snapshot open work-order stages onto the updated templates ----
update work_order_stages s
set fields = t.fields
from case_type_stage_templates t, work_orders w
where w.id = s.work_order_id
  and t.case_type = w.case_type
  and t.stage_key = s.stage_key
  and s.status in ('pending', 'in_progress');
