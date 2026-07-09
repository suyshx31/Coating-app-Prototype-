-- Adds paint-system linkage + two-step stage flow fields.
-- (0001 = core tables, 0002 = paint_system_specifications import; both were
-- applied directly to Supabase before migrations were tracked in-repo.)

alter table work_orders
    add column if not exists paint_system_id uuid references paint_system_specifications(id),
    add column if not exists coat_limits jsonb;

alter table work_order_stages
    add column if not exists started_at timestamptz,
    add column if not exists started_by text references inspectors(employee_id),
    add column if not exists start_readings jsonb;

create index if not exists idx_work_orders_dup_guard
    on work_orders (po_number, po_line_item_number, part_number, part_revision_number);
create index if not exists idx_audit_log_work_order on audit_log (work_order_id);
create index if not exists idx_stages_work_order on work_order_stages (work_order_id);
