-- "Shift" (First Shift / Second Shift) captured at the START of every stage,
-- per stage (confirmed with user: stage level, not work-order level).
-- Inserted as the first field of every stage template; options served by
-- /paint-options under the "shifts" key.

update case_type_stage_templates
set fields = '[{"key":"shift","label":"Shift","type":"dropdown","options":"shifts","phase":"start","required":true}]'::jsonb
             || fields
where not exists (select 1 from jsonb_array_elements(fields) e
                  where e->>'key' = 'shift');

-- re-snapshot open work-order stages onto the updated templates
update work_order_stages s
set fields = t.fields
from case_type_stage_templates t, work_orders w
where w.id = s.work_order_id
  and t.case_type = w.case_type
  and t.stage_key = s.stage_key
  and s.status in ('pending', 'in_progress');
