/**
 * Thin axios-free API client built on fetch. Attaches JWT Bearer automatically.
 * All endpoints live behind the /api prefix (Kubernetes ingress rule).
 */
import { storage } from "@/src/utils/storage";

const BASE = process.env.EXPO_PUBLIC_BACKEND_URL!;

export const TOKEN_KEY = "cp.jwt";
export const USER_KEY = "cp.user";

export type Inspector = {
  id: string;
  employee_id: string;
  name: string;
  email: string;
  role: string;
  shift: string;
  department: string;
  avatar_url?: string;
};

async function authHeader(): Promise<Record<string, string>> {
  const token = await storage.getItem<string>(TOKEN_KEY, "");
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(await authHeader()),
    ...((init.headers as Record<string, string>) || {}),
  };
  const res = await fetch(`${BASE}/api${path}`, { ...init, headers });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const err: any = new Error(data?.detail?.errors?.join?.("; ") || data?.detail || `HTTP ${res.status}`);
    err.status = res.status;
    err.body = data;
    throw err;
  }
  return data as T;
}

export const api = {
  login: (email: string, password: string) =>
    request<{ access_token: string; user: Inspector }>("/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    }),
  me: () => request<Inspector>("/auth/me"),
  workOrders: (params: { q?: string; filter?: string } = {}) => {
    const qs = new URLSearchParams();
    if (params.q) qs.set("q", params.q);
    if (params.filter) qs.set("filter", params.filter);
    return request<WorkOrderSummary[]>(`/work-orders${qs.toString() ? `?${qs}` : ""}`);
  },
  workOrder: (id: string) => request<WorkOrderDetail>(`/work-orders/${id}`),
  startStage: (woId: string, stageKey: string, readings: any) =>
    request<{ ok: boolean; started_at: string }>(`/work-orders/${woId}/stages/${stageKey}/start`, {
      method: "POST",
      body: JSON.stringify({ readings }),
    }),
  submitStage: (woId: string, stageKey: string, body: any) =>
    request<any>(`/work-orders/${woId}/stages/${stageKey}/submit`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  auditLog: (id: string) => request<AuditEntry[]>(`/work-orders/${id}/audit-log`),
  history: () => request<HistoryItem[]>(`/inspections/history`),
  weather: () => request<Weather>(`/weather`),
  dashboard: () => request<Dashboard>(`/dashboard`),
  coatingSpecs: () => request<CoatingSpec[]>(`/coating-specifications`),
  createWorkOrder: (body: CreateWorkOrderBody) =>
    request<WorkOrderSummary>(`/work-orders`, { method: "POST", body: JSON.stringify(body) }),
};

// Row from Supabase paint_system_specifications (imported spec sheet).
// One specification code can appear in several rows (per system/brand),
// so `id` is the unique handle.
export type CoatingSpec = {
  id: string;
  specification: string;
  spec_rev: string | null;
  surface_preparation: string | null;
  section: string | null;
  system_number: number | null;
  application_service_category: string | null;
  anchor_profile_mils: string | null;
  paint_brand: string | null;
  top_coat_ral_shade: number | null;
  primer_paint_product: string | null;
  primer_coat_dft_low_mils: number | null;
  primer_coat_dft_high_mils: number | null;
  intermediate_coat_product: string | null;
  intermediate_coat_dft_low_mils: number | null;
  intermediate_coat_dft_high_mils: number | null;
  top_coat_product: string | null;
  top_coat_dft_low_mils: number | null;
  top_coat_dft_high_mils: number | null;
  bottom_total_dft_system: number | null;
  top_total_dft_system: number | null;
};

export type CreateWorkOrderBody = {
  customer_name: string;
  customer_address?: string;
  po_number: string;
  po_line_item_number: number;
  part_number: string;
  part_revision_number: string;
  coating_spec_code: string;
  coating_spec_revision_number: string;
  paint_system_id?: string;
  quantity: number;
  confirm_duplicate?: boolean;
};

export type DuplicateExistingWO = {
  work_order_id: string;
  customer_name: string;
  paint_product_code: string;
  quantity: number;
  created_at: string;
  created_by: string;
  overall_status: string;
  progress: number;
};

export type WorkOrderSummary = {
  work_order_id: string;
  customer_name: string;
  paint_product_code: string;
  paint_product_name: string;
  part_description: string;
  quantity: number;
  serial_range: string;
  priority: boolean;
  progress: number;
  total_stages: number;
  overall_status: "pending" | "in_progress" | "done" | "fail";
};

export type PaintSpec = {
  surface_profile_min_um: number;
  surface_profile_max_um: number;
  dft_min_um: number;
  dft_max_um: number;
  // null = spec defines no soluble-salts limit (paint-system imports); check skipped
  soluble_salts_max_mg_m2: number | null;
};

export type StageReadings = {
  ambient_temp_c: number | null;
  relative_humidity_pct: number | null;
  dew_point_c: number | null;
  surface_temp_c: number | null;
};

export type Stage = {
  key: string;
  name: string;
  description: string;
  requires_coat_readings: boolean;
  status: "pending" | "in_progress" | "done" | "fail";
  result: "pass" | "fail" | null;
  submission: any | null;
  submitted_at: string | null;
  submitted_by: string | null;
  started_at: string | null;
  started_by: string | null;
  start_readings: StageReadings | null;
};

// Cumulative DFT windows (µm) per coat stage, from the paint-system spec.
export type CoatLimits = {
  primer: [number, number] | null;
  intermediate: [number, number] | null;
  mid_cumulative: [number, number] | null;
  total: [number, number] | null;
};

export type WorkOrderDetail = WorkOrderSummary & {
  po_number: string;
  spec: PaintSpec;
  coat_limits: CoatLimits | null;
  stages: Stage[];
};

export type Weather = {
  ambient_temp_c: number;
  relative_humidity_pct: number;
  dew_point_c: number;
  source: string;
  fetched_at: string;
};

export type AuditEntry = {
  id: string;
  work_order_id: string;
  stage_key: string | null;
  actor_employee_id: string;
  actor_name: string;
  action: string;
  detail: string;
  timestamp: string;
};

export type HistoryItem = {
  work_order_id: string;
  customer_name: string;
  stage_key: string;
  stage_name: string;
  result: string;
  timestamp: string;
  inspector_name: string;
};

export type Dashboard = {
  quota: { date: string; completed: number; target: number };
  shift: { code: string; lead: string };
  system_status: string;
  last_sync: string;
  current_assignment: {
    work_order_id: string;
    customer_name: string;
    part_description: string;
    paint_product_code: string;
    priority: boolean;
    progress: number;
    overall_status: string;
    stages: Stage[];
  } | null;
};
