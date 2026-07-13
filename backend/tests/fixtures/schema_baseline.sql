--
-- PostgreSQL database dump
--

\restrict dD35Z7YjS4RFNB6ONhoNME9maFXKhyaIiv1dalo7Px2XzZbfri28URRIe0jf1f2

-- Dumped from database version 17.6
-- Dumped by pg_dump version 17.10 (Debian 17.10-1.pgdg13+1)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: public; Type: SCHEMA; Schema: -; Owner: -
--

-- CREATE SCHEMA public; (exists on vanilla postgres)


--
-- Name: SCHEMA public; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON SCHEMA public IS 'standard public schema';


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: approved_paint_suppliers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.approved_paint_suppliers (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    supplier_name text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: audit_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.audit_log (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    work_order_id text NOT NULL,
    stage_key text,
    actor_employee_id text NOT NULL,
    actor_name text NOT NULL,
    action text NOT NULL,
    detail text,
    "timestamp" timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: case_type_stage_templates; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.case_type_stage_templates (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    case_type text NOT NULL,
    stage_key text NOT NULL,
    stage_order integer NOT NULL,
    name text NOT NULL,
    description text NOT NULL,
    requires_coat_readings boolean DEFAULT false NOT NULL,
    params jsonb DEFAULT '[]'::jsonb NOT NULL,
    dft_window text,
    fields jsonb DEFAULT '[]'::jsonb NOT NULL
);


--
-- Name: generated_reports; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.generated_reports (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    work_order_id text NOT NULL,
    format text NOT NULL,
    filename text NOT NULL,
    content bytea NOT NULL,
    created_by text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT generated_reports_format_check CHECK ((format = ANY (ARRAY['pdf'::text, 'xlsx'::text])))
);


--
-- Name: inspectors; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.inspectors (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    employee_id text NOT NULL,
    name text NOT NULL,
    email text NOT NULL,
    password_hash text NOT NULL,
    role text NOT NULL,
    shift text NOT NULL,
    department text NOT NULL,
    avatar_url text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    shift_label text,
    shift_start time without time zone,
    shift_end time without time zone
);


--
-- Name: operators; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.operators (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    designation text NOT NULL,
    employee_code text,
    active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: paint_products; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.paint_products (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    brand text NOT NULL,
    product_name text NOT NULL,
    coat_roles text[] DEFAULT '{}'::text[] NOT NULL
);


--
-- Name: paint_shades; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.paint_shades (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    product_id uuid NOT NULL,
    shade_name text NOT NULL
);


--
-- Name: paint_system_specifications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.paint_system_specifications (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    specification text NOT NULL,
    spec_rev text,
    surface_preparation text,
    curing_test_method text,
    adhesion_tape_inspection_method text,
    wft_measurement_method text,
    oil_water_test_method text,
    surface_profile_test_method text,
    dft_test_method text,
    mek_resistance_test_method text,
    section text,
    system_number numeric,
    application_service_category text,
    anchor_profile_mils text,
    paint_brand text,
    top_coat_ral_shade numeric,
    primer_paint_product text,
    primer_coat_dft_low_mils numeric,
    primer_coat_dft_high_mils numeric,
    primer_coat_color text,
    primer_volume_pct_solids numeric,
    primer_wt_pct_zinc_dft numeric,
    intermediate_coat_product text,
    intermediate_coat_dft_low_mils numeric,
    intermediate_coat_dft_high_mils numeric,
    intermediate_coat_color text,
    intermediate_coat_volume_pct_solids numeric,
    top_coat_product text,
    top_coat_dft_low_mils numeric,
    top_coat_dft_high_mils numeric,
    top_coat_volume_pct_solids text,
    bottom_total_dft_system numeric,
    top_total_dft_system numeric,
    top_coat_paint_shade text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: quota; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.quota (
    date date NOT NULL,
    completed integer DEFAULT 0 NOT NULL,
    target integer DEFAULT 25 NOT NULL
);


--
-- Name: ral_shades; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ral_shades (
    ral_number text NOT NULL,
    colour_name text NOT NULL,
    colour_family text NOT NULL
);


--
-- Name: report_recipients; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.report_recipients (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    email text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: spec_company_logos; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.spec_company_logos (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    specification text NOT NULL,
    company_name text NOT NULL,
    logo_url text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: wo_counters; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.wo_counters (
    year integer NOT NULL,
    seq integer DEFAULT 0 NOT NULL
);


--
-- Name: work_order_stages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.work_order_stages (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    work_order_id uuid NOT NULL,
    stage_key text NOT NULL,
    stage_order integer NOT NULL,
    name text NOT NULL,
    description text NOT NULL,
    requires_coat_readings boolean NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    result text,
    submission jsonb,
    submitted_at timestamp with time zone,
    submitted_by text,
    started_at timestamp with time zone,
    started_by text,
    start_readings jsonb,
    params jsonb DEFAULT '[]'::jsonb NOT NULL,
    dft_window text,
    fields jsonb DEFAULT '[]'::jsonb NOT NULL,
    start_fields jsonb DEFAULT '{}'::jsonb NOT NULL,
    start_photos jsonb DEFAULT '[]'::jsonb NOT NULL
);


--
-- Name: work_orders; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.work_orders (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    work_order_id text NOT NULL,
    po_number text NOT NULL,
    po_line_item_number integer,
    customer_name text NOT NULL,
    customer_address text DEFAULT ''::text,
    part_number text,
    part_revision_number text,
    part_description text NOT NULL,
    paint_product_code text NOT NULL,
    paint_product_name text NOT NULL,
    coating_spec_revision_number text,
    quantity integer NOT NULL,
    serial_range text,
    priority boolean DEFAULT false NOT NULL,
    surface_profile_min_um numeric NOT NULL,
    surface_profile_max_um numeric NOT NULL,
    dft_min_um numeric NOT NULL,
    dft_max_um numeric NOT NULL,
    soluble_salts_max_mg_m2 numeric,
    created_by text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    paint_system_id uuid,
    coat_limits jsonb,
    case_type text NOT NULL,
    CONSTRAINT work_orders_case_type_check CHECK ((case_type = ANY (ARRAY['only_primer'::text, 'primer_intermediate'::text, 'primer_intermediate_top'::text, 'top_coat_only'::text])))
);


--
-- Name: approved_paint_suppliers approved_paint_suppliers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.approved_paint_suppliers
    ADD CONSTRAINT approved_paint_suppliers_pkey PRIMARY KEY (id);


--
-- Name: approved_paint_suppliers approved_paint_suppliers_supplier_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.approved_paint_suppliers
    ADD CONSTRAINT approved_paint_suppliers_supplier_name_key UNIQUE (supplier_name);


--
-- Name: audit_log audit_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_log
    ADD CONSTRAINT audit_log_pkey PRIMARY KEY (id);


--
-- Name: case_type_stage_templates case_type_stage_templates_case_type_stage_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.case_type_stage_templates
    ADD CONSTRAINT case_type_stage_templates_case_type_stage_key_key UNIQUE (case_type, stage_key);


--
-- Name: case_type_stage_templates case_type_stage_templates_case_type_stage_order_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.case_type_stage_templates
    ADD CONSTRAINT case_type_stage_templates_case_type_stage_order_key UNIQUE (case_type, stage_order);


--
-- Name: case_type_stage_templates case_type_stage_templates_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.case_type_stage_templates
    ADD CONSTRAINT case_type_stage_templates_pkey PRIMARY KEY (id);


--
-- Name: generated_reports generated_reports_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.generated_reports
    ADD CONSTRAINT generated_reports_pkey PRIMARY KEY (id);


--
-- Name: inspectors inspectors_email_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inspectors
    ADD CONSTRAINT inspectors_email_key UNIQUE (email);


--
-- Name: inspectors inspectors_employee_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inspectors
    ADD CONSTRAINT inspectors_employee_id_key UNIQUE (employee_id);


--
-- Name: inspectors inspectors_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inspectors
    ADD CONSTRAINT inspectors_pkey PRIMARY KEY (id);


--
-- Name: operators operators_employee_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.operators
    ADD CONSTRAINT operators_employee_code_key UNIQUE (employee_code);


--
-- Name: operators operators_name_designation_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.operators
    ADD CONSTRAINT operators_name_designation_key UNIQUE (name, designation);


--
-- Name: operators operators_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.operators
    ADD CONSTRAINT operators_pkey PRIMARY KEY (id);


--
-- Name: paint_products paint_products_brand_product_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.paint_products
    ADD CONSTRAINT paint_products_brand_product_name_key UNIQUE (brand, product_name);


--
-- Name: paint_products paint_products_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.paint_products
    ADD CONSTRAINT paint_products_pkey PRIMARY KEY (id);


--
-- Name: paint_shades paint_shades_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.paint_shades
    ADD CONSTRAINT paint_shades_pkey PRIMARY KEY (id);


--
-- Name: paint_shades paint_shades_product_id_shade_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.paint_shades
    ADD CONSTRAINT paint_shades_product_id_shade_name_key UNIQUE (product_id, shade_name);


--
-- Name: paint_system_specifications paint_system_specifications_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.paint_system_specifications
    ADD CONSTRAINT paint_system_specifications_pkey PRIMARY KEY (id);


--
-- Name: quota quota_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.quota
    ADD CONSTRAINT quota_pkey PRIMARY KEY (date);


--
-- Name: ral_shades ral_shades_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ral_shades
    ADD CONSTRAINT ral_shades_pkey PRIMARY KEY (ral_number);


--
-- Name: report_recipients report_recipients_email_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.report_recipients
    ADD CONSTRAINT report_recipients_email_key UNIQUE (email);


--
-- Name: report_recipients report_recipients_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.report_recipients
    ADD CONSTRAINT report_recipients_pkey PRIMARY KEY (id);


--
-- Name: spec_company_logos spec_company_logos_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.spec_company_logos
    ADD CONSTRAINT spec_company_logos_pkey PRIMARY KEY (id);


--
-- Name: spec_company_logos spec_company_logos_specification_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.spec_company_logos
    ADD CONSTRAINT spec_company_logos_specification_key UNIQUE (specification);


--
-- Name: wo_counters wo_counters_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wo_counters
    ADD CONSTRAINT wo_counters_pkey PRIMARY KEY (year);


--
-- Name: work_order_stages work_order_stages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.work_order_stages
    ADD CONSTRAINT work_order_stages_pkey PRIMARY KEY (id);


--
-- Name: work_order_stages work_order_stages_work_order_id_stage_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.work_order_stages
    ADD CONSTRAINT work_order_stages_work_order_id_stage_key_key UNIQUE (work_order_id, stage_key);


--
-- Name: work_orders work_orders_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.work_orders
    ADD CONSTRAINT work_orders_pkey PRIMARY KEY (id);


--
-- Name: work_orders work_orders_work_order_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.work_orders
    ADD CONSTRAINT work_orders_work_order_id_key UNIQUE (work_order_id);


--
-- Name: idx_audit_log_work_order; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_audit_log_work_order ON public.audit_log USING btree (work_order_id);


--
-- Name: idx_generated_reports_wo; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_generated_reports_wo ON public.generated_reports USING btree (work_order_id);


--
-- Name: idx_stages_work_order; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_stages_work_order ON public.work_order_stages USING btree (work_order_id);


--
-- Name: idx_work_orders_dup_guard; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_work_orders_dup_guard ON public.work_orders USING btree (po_number, po_line_item_number, part_number, part_revision_number);


--
-- Name: audit_log audit_log_actor_employee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_log
    ADD CONSTRAINT audit_log_actor_employee_id_fkey FOREIGN KEY (actor_employee_id) REFERENCES public.inspectors(employee_id);


--
-- Name: paint_products paint_products_brand_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.paint_products
    ADD CONSTRAINT paint_products_brand_fkey FOREIGN KEY (brand) REFERENCES public.approved_paint_suppliers(supplier_name);


--
-- Name: paint_shades paint_shades_product_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.paint_shades
    ADD CONSTRAINT paint_shades_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.paint_products(id) ON DELETE CASCADE;


--
-- Name: work_order_stages work_order_stages_started_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.work_order_stages
    ADD CONSTRAINT work_order_stages_started_by_fkey FOREIGN KEY (started_by) REFERENCES public.inspectors(employee_id);


--
-- Name: work_order_stages work_order_stages_submitted_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.work_order_stages
    ADD CONSTRAINT work_order_stages_submitted_by_fkey FOREIGN KEY (submitted_by) REFERENCES public.inspectors(employee_id);


--
-- Name: work_order_stages work_order_stages_work_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.work_order_stages
    ADD CONSTRAINT work_order_stages_work_order_id_fkey FOREIGN KEY (work_order_id) REFERENCES public.work_orders(id) ON DELETE CASCADE;


--
-- Name: work_orders work_orders_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.work_orders
    ADD CONSTRAINT work_orders_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.inspectors(employee_id);


--
-- Name: work_orders work_orders_paint_system_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.work_orders
    ADD CONSTRAINT work_orders_paint_system_id_fkey FOREIGN KEY (paint_system_id) REFERENCES public.paint_system_specifications(id);


--
-- PostgreSQL database dump complete
--

\unrestrict dD35Z7YjS4RFNB6ONhoNME9maFXKhyaIiv1dalo7Px2XzZbfri28URRIe0jf1f2

