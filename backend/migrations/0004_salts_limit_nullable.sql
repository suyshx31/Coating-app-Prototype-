-- Paint-system specs imported from the customer sheet define no soluble-salts
-- limit; NULL means "no limit in spec" and the salts check is skipped.
alter table work_orders alter column soluble_salts_max_mg_m2 drop not null;
