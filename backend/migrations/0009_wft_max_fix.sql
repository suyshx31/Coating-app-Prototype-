-- WFT calculation fix (replaces the solids%-based min/max range with a
-- single max-only constraint per the corrected spec):
--   WFT_max = DFT_max x mixing_ratio
-- where mixing_ratio is the numeric "Ratio WFT to DFT" from
-- migrations/seed/mixing_ratio_paint.csv, per paint product.
--
-- 1. paint_products gains mixing_ratio (display-only "4:01" string) and
--    wft_to_dft_ratio (the numeric ratio actually used in the formula).
-- 2. volume_pct_solids is removed from every coat-stage field definition
--    (it was captured only to feed the old, incorrect formula).
-- Does not touch paint_system_specifications, approved_paint_suppliers, or
-- any submitted work-order data.

alter table paint_products
    add column if not exists mixing_ratio text,
    add column if not exists wft_to_dft_ratio numeric;

update paint_products set mixing_ratio = '3:01', wft_to_dft_ratio = 1.56 where brand = 'CARBOLINE' and product_name = 'CARBOZINC 11';
update paint_products set mixing_ratio = '4:01', wft_to_dft_ratio = 1.45 where brand = 'CARBOLINE' and product_name = 'CARBOZINC 858';
update paint_products set mixing_ratio = '1:01', wft_to_dft_ratio = 1.25 where brand = 'CARBOLINE' and product_name = 'CARBOGUARD 890 MIO';
update paint_products set mixing_ratio = '4:01', wft_to_dft_ratio = 1.49 where brand = 'CARBOLINE' and product_name = 'CARBOTHANE 134 HG';
update paint_products set mixing_ratio = '4:01', wft_to_dft_ratio = 1.35 where brand = 'JOTUN' and product_name = 'RESIST 86';
update paint_products set mixing_ratio = '4:01', wft_to_dft_ratio = 1.25 where brand = 'JOTUN' and product_name = 'BARRIER 90X';
update paint_products set mixing_ratio = '4:01', wft_to_dft_ratio = 1.49 where brand = 'JOTUN' and product_name = 'PENGUARD MIDCOAT MIO';
update paint_products set mixing_ratio = '4:01', wft_to_dft_ratio = 1.25 where brand = 'JOTUN' and product_name = 'JOTACOTE UNIVERSAL N10 MIO';
update paint_products set mixing_ratio = '4:01', wft_to_dft_ratio = 1.25 where brand = 'JOTUN' and product_name = 'JOTAMASTIC 90';
update paint_products set mixing_ratio = '4:01', wft_to_dft_ratio = 1.59 where brand = 'JOTUN' and product_name = 'HARDTOP XP';
-- No ratio data provided for CARBOLINE/CARBOGUARD 890 (non-MIO) or
-- JOTUN/JOTACOTE UNIVERSAL N10 (non-MIO) — left NULL; WFT check is skipped
-- for these products until ratio data is provided.

-- Strip volume_pct_solids from every stage's field definitions
update case_type_stage_templates
set fields = (
    select coalesce(jsonb_agg(elem), '[]'::jsonb)
    from jsonb_array_elements(fields) elem
    where elem->>'key' <> 'volume_pct_solids'
);

-- Re-snapshot open (not yet completed) work-order stages onto the corrected templates
update work_order_stages s
set fields = t.fields
from case_type_stage_templates t, work_orders w
where w.id = s.work_order_id
  and t.case_type = w.case_type
  and t.stage_key = s.stage_key
  and s.status in ('pending', 'in_progress');
