import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
  Image,
} from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";

import { api, FieldDef, PaintOptions, Stage, WorkOrderDetail, Weather } from "@/src/api";
import { colors, radius, spacing, type } from "@/src/theme";
import { Card, DataId, Label, StatusPill } from "@/src/components/UI";

type Readings = {
  ambient_temp_c: string;
  relative_humidity_pct: string;
  dew_point_c: string;
  surface_temp_c: string;
};

const emptyR: Readings = {
  ambient_temp_c: "",
  relative_humidity_pct: "",
  dew_point_c: "",
  surface_temp_c: "",
};

function n(s: string): number | null {
  if (s === "" || s == null) return null;
  const v = Number(s);
  return Number.isFinite(v) ? v : null;
}

// DD/MM/YYYY input mask: digits only, "/" inserted automatically after DD and MM.
function maskDmy(v: string): string {
  const d = v.replace(/\D/g, "").slice(0, 8);
  if (d.length <= 2) return d;
  if (d.length <= 4) return `${d.slice(0, 2)}/${d.slice(2)}`;
  return `${d.slice(0, 2)}/${d.slice(2, 4)}/${d.slice(4)}`;
}

// null = valid complete DD/MM/YYYY date; otherwise the reason it isn't.
function dmyIssue(v: string): string | null {
  if (!/^\d{2}\/\d{2}\/\d{4}$/.test(v)) return "Enter full date as DD/MM/YYYY";
  const [dd, mm, yyyy] = v.split("/").map(Number);
  if (mm < 1 || mm > 12) return "Month must be 01–12";
  if (dd < 1 || dd > 31) return "Day must be 01–31";
  const dt = new Date(yyyy, mm - 1, dd);
  if (dt.getFullYear() !== yyyy || dt.getMonth() !== mm - 1 || dt.getDate() !== dd) {
    return `${v} is not a valid calendar date`;
  }
  return null;
}

// DFT window for this stage per its dft_window snapshot; falls back to the
// WO's total spec range if the paint system lacks that window.
function dftWindow(wo: WorkOrderDetail, stage: Stage): [number, number] {
  const w = stage.dft_window ? wo.coat_limits?.[stage.dft_window] : null;
  return w ?? [wo.spec.dft_min_um, wo.spec.dft_max_um];
}

// Client-side mirror of the server's range resolution (captions + hard-block hint).
function fieldRange(
  wo: WorkOrderDetail, stage: Stage, def: FieldDef, values: Record<string, string>,
): [number, number] | null {
  switch (def.range) {
    case "pct":
      return [0, 100];
    case "anchor_profile":
      return [
        Math.round((wo.spec.surface_profile_min_um / 25.4) * 100) / 100,
        Math.round((wo.spec.surface_profile_max_um / 25.4) * 100) / 100,
      ];
    case "dft_window":
      return dftWindow(wo, stage);
    case "wft": {
      const solids = n(values["volume_pct_solids"] ?? "");
      if (!solids || solids <= 0) return null;
      const [lo, hi] = dftWindow(wo, stage);
      return [Math.round((lo * 100) / solids * 10) / 10, Math.round((hi * 100) / solids * 10) / 10];
    }
    default:
      return null;
  }
}

function resolveOptions(def: FieldDef, opts: PaintOptions | null, values: Record<string, string>): string[] {
  if (!opts) return [];
  if (def.options === "brands") return opts.brands;
  if (def.options === "colors") return opts.colors;
  if (def.options === "ral") return opts.ral;
  if (def.options === "operators") return opts.operators.map((o) => o.name);
  if (def.options === "operator_designations") return opts.operator_designations;
  if (def.options === "shifts") return opts.shifts;
  if (def.options?.startsWith("products.")) {
    const coat = def.options.split(".")[1] as "primer" | "intermediate" | "top";
    const brand = def.depends_on ? values[def.depends_on] : "";
    return brand ? opts.products[brand]?.[coat] ?? [] : [];
  }
  if (def.options === "shades") {
    const brand = values["brand"];
    const product = values["product"];
    return brand && product ? opts.shades[`${brand}::${product}`] ?? [] : [];
  }
  return [];
}

export default function StageFormScreen() {
  const { id, stage } = useLocalSearchParams<{ id: string; stage: string }>();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [wo, setWo] = useState<WorkOrderDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  const [readings, setReadings] = useState<Readings>(emptyR);
  const [values, setValues] = useState<Record<string, string>>({});
  const [notes, setNotes] = useState("");
  const [photos, setPhotos] = useState<string[]>([]);
  const [paintOpts, setPaintOpts] = useState<PaintOptions | null>(null);
  const [pickerFor, setPickerFor] = useState<FieldDef | null>(null);

  const stageKey = String(stage);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      const r = await api.workOrder(id);
      setWo(r);
    } catch (e: any) {
      if (e?.status === 401) router.replace("/login");
    } finally {
      setLoading(false);
    }
  }, [id, router]);

  useEffect(() => {
    load();
  }, [load]);

  const stageMeta = wo?.stages.find((s) => s.key === stageKey);
  const fieldDefs = useMemo(() => stageMeta?.fields ?? [], [stageMeta]);
  // capture timing: start-phase fields (paint identification / operator /
  // batch+expiry) are filled before work begins; end-phase fields at submission
  const startDefs = useMemo(() => fieldDefs.filter((f) => f.phase === "start"), [fieldDefs]);
  const endDefs = useMemo(() => fieldDefs.filter((f) => (f.phase ?? "end") === "end"), [fieldDefs]);
  const hasDropdowns = fieldDefs.some((f) => f.type === "dropdown");

  useEffect(() => {
    if (!hasDropdowns || paintOpts) return;
    api.paintOptions().then(setPaintOpts).catch(() => {});
  }, [hasDropdowns, paintOpts]);

  // Two-step flow: record start readings first, end readings + fields after.
  const phase: "start" | "end" | "submitted" =
    stageMeta?.status === "done" || stageMeta?.status === "fail" ? "submitted"
    : stageMeta?.started_at ? "end"
    : "start";

  const fetchWeather = useCallback(async () => {
    try {
      const w: Weather = await api.weather();
      setReadings((r) => ({
        ...r,
        ambient_temp_c: String(w.ambient_temp_c),
        relative_humidity_pct: String(w.relative_humidity_pct),
        dew_point_c: String(w.dew_point_c),
      }));
    } catch {
      // ignore
    }
  }, []);

  // Gate: >60°C = too hot (fails regardless); otherwise surface must exceed dew+3°C.
  const gate = useMemo(() => {
    const st = n(readings.surface_temp_c);
    const dp = n(readings.dew_point_c);
    if (st == null || dp == null) return { ok: false, msg: "Enter surface temp & dew point" };
    if (st > 60) return { ok: false, msg: `Too hot for coat — Fail (${st}°C > 60°C)` };
    if (st > dp + 3) return { ok: true, msg: `${st} > ${dp} + 3 °C` };
    return { ok: false, msg: `${st} ≤ ${dp} + 3 °C — too close to dew point` };
  }, [readings]);

  const setValue = (key: string, v: string) => setValues((s) => ({ ...s, [key]: v }));

  // Per-field issue (range check mirror); hard_block_max escalates over-max.
  // Derived ranges may need start-phase values (WFT <- % solids recorded at start).
  const fieldIssue = useCallback(
    (def: FieldDef): { msg: string; hardBlock: boolean } | null => {
      if (!wo || !stageMeta) return null;
      if (def.type !== "number" && def.type !== "decimal") return null;
      const v = n(values[def.key] ?? "");
      if (v == null) return null;
      const ctx = { ...Object.fromEntries(Object.entries(stageMeta.start_fields ?? {}).map(([k, val]) => [k, String(val)])), ...values };
      const range = fieldRange(wo, stageMeta, def, ctx);
      if (!range) return null;
      const [lo, hi] = range;
      if (v > hi) return { msg: `Exceeds max ${hi}${def.unit ? ` ${def.unit}` : ""}`, hardBlock: !!def.hard_block_max };
      if (v < lo) return { msg: `Below min ${lo}${def.unit ? ` ${def.unit}` : ""}`, hardBlock: false };
      return null;
    },
    [wo, stageMeta, values],
  );

  const activeDefs = phase === "start" ? startDefs : endDefs;
  const anyHardBlock = activeDefs.some((d) => fieldIssue(d)?.hardBlock);
  const readingsFilled = !!(readings.surface_temp_c && readings.dew_point_c);
  const requiredFilled = activeDefs.every((d) => !d.required || !!(values[d.key] ?? "").trim());
  // a typed-but-incomplete/invalid DD/MM/YYYY date blocks progression
  const dmyOk = activeDefs.every(
    (d) => d.type !== "date_dmy" || !(values[d.key] ?? "").trim() || dmyIssue(values[d.key]) === null,
  );
  // Curing + QA takes no environmental/surface-temp readings; the snapshot's
  // requires_coat_readings flag says whether this stage captures them at all
  const needsReadings = !!stageMeta?.requires_coat_readings;

  const canStart = (!needsReadings || (readingsFilled && gate.ok)) && requiredFilled && dmyOk && !submitting;
  const canSubmit = (!needsReadings || readingsFilled) && requiredFilled && dmyOk && !anyHardBlock && !submitting;

  const addPhoto = () => {
    if (photos.length >= 5) return;
    // simulate a captured photo with a procedural placeholder (data URI 1x1)
    const placeholder = `data:image/svg+xml;utf8,${encodeURIComponent(
      `<svg xmlns='http://www.w3.org/2000/svg' width='160' height='120'><rect width='100%' height='100%' fill='%23${["111827","1F2937","374151","4B5563","6B7280"][photos.length % 5]}'/><text x='50%' y='52%' fill='white' font-family='monospace' font-size='14' text-anchor='middle'>PHOTO ${photos.length + 1}</text></svg>`,
    )}`;
    setPhotos((p) => [...p, placeholder]);
  };

  const numericReadings = () => ({
    ambient_temp_c: n(readings.ambient_temp_c),
    relative_humidity_pct: n(readings.relative_humidity_pct),
    dew_point_c: n(readings.dew_point_c),
    surface_temp_c: n(readings.surface_temp_c),
  });

  const onStart = async () => {
    if (!wo) return;
    setServerError(null);
    setSubmitting(true);
    try {
      const startValues: Record<string, string | number> = {};
      for (const def of startDefs) {
        const raw = (values[def.key] ?? "").trim();
        if (!raw) continue;
        startValues[def.key] = def.type === "number" || def.type === "decimal" ? Number(raw) : raw;
      }
      await api.startStage(wo.work_order_id, stageKey, numericReadings(), startValues, photos);
      setReadings(emptyR); // form now collects END readings
      setPhotos([]);       // and after-work photos
      await load();
    } catch (e: any) {
      setServerError(e?.body?.detail?.errors?.join("\n") || e?.body?.detail || e?.message || "Failed to record start of stage");
    } finally {
      setSubmitting(false);
    }
  };

  const onSubmit = async () => {
    if (!wo) return;
    setServerError(null);
    setSubmitting(true);
    try {
      const fields: Record<string, string | number> = {};
      for (const def of endDefs) {
        const raw = (values[def.key] ?? "").trim();
        if (!raw) continue;
        fields[def.key] = def.type === "number" || def.type === "decimal" ? Number(raw) : raw;
      }
      const failByField = endDefs.some(
        (d) => d.fail_on && values[d.key] === d.fail_on,
      ) || endDefs.some((d) => fieldIssue(d) !== null);
      const body = {
        readings: { end: numericReadings() },
        fields,
        notes,
        photos,
        result: (!needsReadings || gate.ok) && !failByField ? "pass" : "fail",
      };
      const r = await api.submitStage(wo.work_order_id, stageKey, body);
      router.replace(`/work-order/${wo.work_order_id}/submitted?stage=${stageKey}&result=${r.result}`);
    } catch (e: any) {
      setServerError(e?.body?.detail?.errors?.join("\n") || e?.body?.detail || e?.message || "Submission failed");
    } finally {
      setSubmitting(false);
    }
  };

  if (loading || !wo) {
    return (
      <SafeAreaView style={styles.safe} edges={["top"]}>
        <ActivityIndicator color={colors.accent} style={{ marginTop: 80 }} />
      </SafeAreaView>
    );
  }

  const renderField = (def: FieldDef) => {
    const issue = fieldIssue(def);
    const val = values[def.key] ?? "";
    const range = stageMeta ? fieldRange(wo, stageMeta, def, values) : null;
    const caption =
      def.type === "number" || def.type === "decimal"
        ? range
          ? `${range[0]}–${range[1]}${def.unit ? ` ${def.unit}` : ""}`
          : def.unit ?? ""
        : "";

    return (
      <View key={def.key} style={{ marginTop: spacing.md }}>
        <View style={styles.rowBetween}>
          <Text style={[type.label, { color: colors.textPrimary, flexShrink: 1 }]}>
            {def.label.toUpperCase()}{def.required ? " *" : ""}
          </Text>
          {caption ? <Text style={type.caption}>{caption}</Text> : null}
        </View>

        {def.type === "ok_notok" || def.type === "pass_fail" ? (
          <View style={styles.toggleRow}>
            {(def.type === "ok_notok" ? ["OK", "NOT_OK"] : ["PASS", "FAIL"]).map((opt) => {
              const selected = val === opt;
              const failing = opt === def.fail_on;
              return (
                <TouchableOpacity
                  key={opt}
                  testID={`field-${def.key}-${opt}`}
                  onPress={() => setValue(def.key, opt)}
                  style={[
                    styles.toggleBtn,
                    selected && { backgroundColor: failing ? colors.errorBg : colors.successBg,
                                  borderColor: failing ? colors.errorText : colors.successText },
                  ]}
                >
                  <Text style={[type.label, { color: selected ? (failing ? colors.errorText : colors.successText) : colors.textSecondary }]}>
                    {opt.replace("_", " ")}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>
        ) : def.type === "dropdown" ? (
          (() => {
            const opts = resolveOptions(def, paintOpts, values);
            const blockedBy = def.depends_on && !values[def.depends_on];
            return (
              <>
                <TouchableOpacity
                  testID={`field-${def.key}-picker`}
                  onPress={() => !blockedBy && setPickerFor(def)}
                  style={[styles.input, styles.pickerRow, blockedBy && { opacity: 0.5 }]}
                  activeOpacity={0.85}
                >
                  <Text style={val ? type.body : [type.body, { color: colors.textMuted }]}>
                    {val || (blockedBy ? `Pick ${def.depends_on} first` : opts.length ? "Tap to select" : "No options available")}
                  </Text>
                  <Ionicons name="chevron-down" size={16} color={colors.textMuted} />
                </TouchableOpacity>
              </>
            );
          })()
        ) : def.type === "note" ? (
          <TextInput
            testID={`field-${def.key}-input`}
            value={val}
            onChangeText={(v) => setValue(def.key, v)}
            multiline
            numberOfLines={3}
            placeholder="Notes..."
            placeholderTextColor={colors.textMuted}
            style={[styles.input, { minHeight: 72, textAlignVertical: "top" }]}
          />
        ) : def.type === "date_dmy" ? (
          (() => {
            // masked date input: digits only, "/" auto-inserted (DD/MM/YYYY)
            const err = val.trim() ? dmyIssue(val) : null;
            return (
              <>
                <TextInput
                  testID={`field-${def.key}-input`}
                  value={val}
                  onChangeText={(v) => setValue(def.key, maskDmy(v))}
                  keyboardType="number-pad"
                  maxLength={10}
                  placeholder="DD/MM/YYYY"
                  placeholderTextColor={colors.textMuted}
                  style={[styles.input, err && styles.inputError]}
                />
                {err ? (
                  <View style={styles.hardBlock}>
                    <Ionicons name="warning-outline" size={14} color={colors.warningText} />
                    <Text style={[styles.inlineErr, { color: colors.warningText }]}>{err}</Text>
                  </View>
                ) : null}
              </>
            );
          })()
        ) : (
          <TextInput
            testID={`field-${def.key}-input`}
            value={val}
            onChangeText={(v) => setValue(def.key, v)}
            keyboardType={def.type === "number" || def.type === "decimal" ? "decimal-pad" : "default"}
            placeholder={def.type === "date" ? "YYYY-MM-DD" : def.type === "time" ? "HH:MM" : def.type === "number" || def.type === "decimal" ? "0.00" : ""}
            placeholderTextColor={colors.textMuted}
            style={[styles.input, issue && styles.inputError]}
          />
        )}

        {issue ? (
          <View style={styles.hardBlock}>
            <Ionicons
              name={issue.hardBlock ? "lock-closed" : "warning-outline"}
              size={14}
              color={issue.hardBlock ? colors.errorText : colors.warningText}
            />
            <Text style={[styles.inlineErr, { color: issue.hardBlock ? colors.errorText : colors.warningText }]}>
              {issue.hardBlock ? "HARD BLOCK · " : ""}{issue.msg}
            </Text>
          </View>
        ) : null}
      </View>
    );
  };

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <View style={styles.header}>
        <TouchableOpacity testID="stage-back" onPress={() => router.back()}>
          <Ionicons name="chevron-back" size={26} color={colors.textPrimary} />
        </TouchableOpacity>
        <View style={{ flex: 1, alignItems: "center" }}>
          <Text style={[type.caption]}>{stageMeta?.name?.toUpperCase()}</Text>
          <DataId style={{ fontSize: 13 }}>#{wo.work_order_id}</DataId>
        </View>
        <View style={{ width: 26 }} />
      </View>

      {phase === "submitted" ? (
        <View style={{ padding: spacing.md }}>
          <Card>
            <View style={styles.rowBetween}>
              <Label>Stage already submitted</Label>
              <StatusPill status={stageMeta?.result === "pass" ? "pass" : "fail"} />
            </View>
            <Text style={[type.bodySm, { marginTop: spacing.sm }]}>
              Submitted {stageMeta?.submitted_at ?? ""} by {stageMeta?.submitted_by ?? ""}.
            </Text>
            <TouchableOpacity
              testID="submitted-back-btn"
              onPress={() => router.back()}
              style={[styles.primaryCta, { marginTop: spacing.md }]}
            >
              <Text style={styles.primaryCtaText}>BACK TO WORK ORDER</Text>
            </TouchableOpacity>
          </Card>
        </View>
      ) : (
        <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={{ flex: 1 }}>
          <ScrollView contentContainerStyle={{ padding: spacing.md, paddingBottom: 120 }} keyboardShouldPersistTaps="handled">
            {/* Phase indicator: start and end are separate submissions */}
            <View style={styles.segment}>
              <View style={[styles.segmentBtn, phase === "start" && styles.segmentBtnActive]}>
                <Text style={[styles.segmentText, phase === "start" && styles.segmentTextActive]}>
                  {phase === "end" ? "✓ START RECORDED" : "START OF STAGE"}
                </Text>
              </View>
              <View style={[styles.segmentBtn, phase === "end" && styles.segmentBtnActive]}>
                <Text style={[styles.segmentText, phase === "end" && styles.segmentTextActive]}>END OF STAGE</Text>
              </View>
            </View>

            {phase === "end" && stageMeta?.start_readings ? (
              <Card style={{ marginBottom: spacing.md }}>
                <Label>Start of stage (recorded)</Label>
                {needsReadings ? (
                  <Text style={[type.mono, { marginTop: 4 }]}>
                    Air {stageMeta.start_readings.ambient_temp_c ?? "—"}°C · RH {stageMeta.start_readings.relative_humidity_pct ?? "—"}% ·
                    Dew {stageMeta.start_readings.dew_point_c ?? "—"}°C · Surface {stageMeta.start_readings.surface_temp_c ?? "—"}°C
                  </Text>
                ) : null}
                {Object.keys(stageMeta.start_fields ?? {}).length > 0 ? (
                  <Text style={[type.bodySm, { marginTop: 6 }]}>
                    {startDefs
                      .filter((d) => stageMeta.start_fields?.[d.key] != null)
                      .map((d) => `${d.label}: ${stageMeta.start_fields[d.key]}`)
                      .join("  ·  ")}
                  </Text>
                ) : null}
                {(stageMeta.start_photos ?? []).length > 0 ? (
                  <Text style={[type.caption, { marginTop: 4 }]}>
                    {stageMeta.start_photos.length} before-work photo(s) recorded
                  </Text>
                ) : null}
                <Text style={[type.caption, { marginTop: 4 }]}>
                  {stageMeta.started_at} · {stageMeta.started_by}
                </Text>
              </Card>
            ) : null}

            {/* Environmental + surface-temp capture only on stages that take
                coat readings — Curing + QA (requires_coat_readings=false)
                shows neither the weather fetch nor the surface-temp gate */}
            {needsReadings ? (
            <>
            {/* Weather block (auto) */}
            <Card>
              <View style={styles.rowBetween}>
                <Label>Environmental · Weather (Auto)</Label>
                <TouchableOpacity testID="fetch-weather-btn" onPress={fetchWeather} style={styles.smallCta}>
                  <Ionicons name="cloud-download-outline" size={12} color={colors.textInverse} />
                  <Text style={styles.smallCtaText}>FETCH</Text>
                </TouchableOpacity>
              </View>
              <View style={styles.grid2}>
                <ReadingField
                  label="Air Temp (°C)"
                  testID="env-air-temp-input"
                  value={readings.ambient_temp_c}
                  onChangeText={(v) => setReadings((r) => ({ ...r, ambient_temp_c: v }))}
                />
                <ReadingField
                  label="Humidity (%)"
                  testID="env-rh-input"
                  value={readings.relative_humidity_pct}
                  onChangeText={(v) => setReadings((r) => ({ ...r, relative_humidity_pct: v }))}
                />
                <ReadingField
                  label="Dew Point (°C)"
                  testID="env-dew-input"
                  value={readings.dew_point_c}
                  onChangeText={(v) => setReadings((r) => ({ ...r, dew_point_c: v }))}
                />
                <View style={{ flex: 1 }} />
              </View>
            </Card>

            {/* Surface Temp block (manual) */}
            <Card style={{ marginTop: spacing.md }}>
              <Label>Surface Temperature (Manual · Elcometer 319)</Label>
              <ReadingField
                label={`Surface Temp at ${phase.toUpperCase()} (°C)`}
                testID={`env-surface-temp-${phase}-input`}
                value={readings.surface_temp_c}
                onChangeText={(v) => setReadings((r) => ({ ...r, surface_temp_c: v }))}
                style={{ marginTop: spacing.sm }}
              />
              <View style={[styles.gateBox, { backgroundColor: gate.ok ? colors.successBg : colors.errorBg, borderColor: gate.ok ? colors.successText : colors.errorText }]} testID="gate-check-box">
                <Ionicons name={gate.ok ? "checkmark-circle" : "alert-circle"} size={16} color={gate.ok ? colors.successText : colors.errorText} />
                <View style={{ flex: 1 }}>
                  <Text style={[type.label, { color: gate.ok ? colors.successText : colors.errorText }]}>
                    GATE · &le;60°C AND Surface Temp &gt; Dew Point + 3°C
                  </Text>
                  <Text style={[type.bodySm, { color: gate.ok ? colors.successText : colors.errorText, marginTop: 2 }]}>
                    {gate.msg}
                  </Text>
                </View>
                <StatusPill status={gate.ok ? "pass" : "fail"} testID={`gate-pill-${phase}`} />
              </View>
            </Card>
            </>
            ) : null}

            {/* Stage fields for the current capture phase */}
            {activeDefs.length > 0 ? (
              <Card style={{ marginTop: spacing.md }}>
                <Label>
                  {stageMeta?.name} · {phase === "start" ? "Paint Identification (before work)" : "Inspection Results"}
                </Label>
                {activeDefs.map(renderField)}
              </Card>
            ) : null}

            {/* Photos at both capture points: before-work at start, after-work at end */}
            <Card style={{ marginTop: spacing.md }}>
              <Label>{phase === "start" ? "Before-Work Photos" : "Evidence Photos"} ({photos.length}/5)</Label>
              <TouchableOpacity testID="capture-photo-btn" onPress={addPhoto} disabled={photos.length >= 5} style={[styles.dropzone, photos.length >= 5 && { opacity: 0.4 }]}>
                <Ionicons name="camera-outline" size={28} color={colors.textPrimary} />
                <Text style={[type.label, { marginTop: 6, color: colors.textPrimary }]}>CAPTURE PHOTO</Text>
              </TouchableOpacity>
              <View style={{ flexDirection: "row", gap: 8, marginTop: spacing.sm }}>
                {Array.from({ length: 5 }).map((_, i) => (
                  <View key={i} style={styles.thumb} testID={`photo-thumb-${i}`}>
                    {photos[i] ? (
                      <Image source={{ uri: photos[i] }} style={{ width: "100%", height: "100%", borderRadius: radius.sharp }} />
                    ) : (
                      <Ionicons name="image-outline" size={18} color={colors.textMuted} />
                    )}
                  </View>
                ))}
              </View>
            </Card>

            {/* Notes only on the final (end) submission */}
            {phase === "end" ? (
              <Card style={{ marginTop: spacing.md }}>
                <Label>Inspection Notes</Label>
                <TextInput
                  testID="notes-input"
                  value={notes}
                  onChangeText={setNotes}
                  multiline
                  numberOfLines={4}
                  placeholder="Observations, non-conformance details..."
                  placeholderTextColor={colors.textMuted}
                  style={[styles.input, { minHeight: 96, textAlignVertical: "top", marginTop: spacing.sm }]}
                />
              </Card>
            ) : null}

            {serverError ? (
              <View style={styles.errorBanner} testID="server-error">
                <Ionicons name="alert-circle" size={18} color={colors.errorText} />
                <Text style={{ flex: 1, color: colors.errorText, fontSize: 13 }}>{serverError}</Text>
              </View>
            ) : null}
          </ScrollView>

          <View style={[styles.stickyBar, { paddingBottom: spacing.md + insets.bottom }]}>
            <View style={styles.rowBetween}>
              <Text style={type.caption}>
                {phase === "start" ? "Record conditions to begin this stage" : "Ready to submit end-of-stage inspection"}
              </Text>
              <StatusPill status={anyHardBlock ? "fail" : !needsReadings || gate.ok ? "pass" : "in_progress"} />
            </View>
            {phase === "start" ? (
              <TouchableOpacity
                testID="start-stage-btn"
                disabled={!canStart}
                onPress={onStart}
                style={[styles.primaryCta, !canStart && { opacity: 0.5 }]}
                activeOpacity={0.85}
              >
                {submitting ? (
                  <ActivityIndicator color={colors.textInverse} />
                ) : (
                  <>
                    <Ionicons name="play" size={16} color={colors.textInverse} />
                    <Text style={styles.primaryCtaText}>RECORD START & BEGIN STAGE</Text>
                  </>
                )}
              </TouchableOpacity>
            ) : (
              <TouchableOpacity
                testID="submit-inspection-btn"
                disabled={!canSubmit}
                onPress={onSubmit}
                style={[styles.primaryCta, !canSubmit && { opacity: 0.5 }]}
                activeOpacity={0.85}
              >
                {submitting ? (
                  <ActivityIndicator color={colors.textInverse} />
                ) : (
                  <>
                    <Ionicons name="checkmark-done" size={16} color={colors.textInverse} />
                    <Text style={styles.primaryCtaText}>SUBMIT INSPECTION</Text>
                  </>
                )}
              </TouchableOpacity>
            )}
          </View>
        </KeyboardAvoidingView>
      )}

      {/* generic dropdown picker */}
      <Modal visible={!!pickerFor} animationType="slide" transparent onRequestClose={() => setPickerFor(null)}>
        <Pressable style={styles.modalBackdrop} onPress={() => setPickerFor(null)}>
          <Pressable style={styles.modalSheet} onPress={(e) => e.stopPropagation()}>
            <View style={styles.modalHandle} />
            <Text style={[type.h3, { marginBottom: spacing.sm }]}>{pickerFor?.label}</Text>
            <ScrollView style={{ maxHeight: 360 }}>
              {pickerFor && resolveOptions(pickerFor, paintOpts, values).length === 0 ? (
                <Text style={[type.bodySm, { textAlign: "center", padding: spacing.lg }]}>No options available.</Text>
              ) : (
                pickerFor &&
                resolveOptions(pickerFor, paintOpts, values).map((opt) => (
                  <TouchableOpacity
                    key={opt}
                    testID={`option-${opt}`}
                    onPress={() => {
                      setValue(pickerFor.key, opt);
                      // reset downstream dependent fields when a parent changes
                      fieldDefs.forEach((d) => {
                        if (d.depends_on === pickerFor.key) setValue(d.key, "");
                      });
                      // picking an operator auto-fills their designation
                      if (pickerFor.options === "operators") {
                        const op = paintOpts?.operators.find((o) => o.name === opt);
                        if (op) setValue("operator_designation", op.designation);
                      }
                      setPickerFor(null);
                    }}
                    style={styles.specOption}
                    activeOpacity={0.85}
                  >
                    <Text style={type.body}>{opt}</Text>
                    {values[pickerFor.key] === opt ? (
                      <Ionicons name="checkmark-circle" size={20} color={colors.successText} />
                    ) : null}
                  </TouchableOpacity>
                ))
              )}
            </ScrollView>
            <TouchableOpacity testID="picker-close" onPress={() => setPickerFor(null)} style={styles.modalClose}>
              <Text style={[type.label, { color: colors.textPrimary }]}>CLOSE</Text>
            </TouchableOpacity>
          </Pressable>
        </Pressable>
      </Modal>
    </SafeAreaView>
  );
}

function ReadingField({
  label,
  value,
  onChangeText,
  testID,
  style,
}: {
  label: string;
  value: string;
  onChangeText: (v: string) => void;
  testID: string;
  style?: any;
}) {
  return (
    <View style={[{ flex: 1, minWidth: "45%" }, style]}>
      <Text style={[type.label, { color: colors.textPrimary }]}>{label.toUpperCase()}</Text>
      <TextInput
        testID={testID}
        value={value}
        onChangeText={onChangeText}
        keyboardType="decimal-pad"
        placeholder="0.0"
        placeholderTextColor={colors.textMuted}
        style={styles.input}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    backgroundColor: colors.card,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    gap: spacing.sm,
  },
  rowBetween: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  segment: { flexDirection: "row", backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, borderRadius: radius.sharp, padding: 4, marginBottom: spacing.md },
  segmentBtn: { flex: 1, paddingVertical: 12, alignItems: "center", borderRadius: radius.sharp },
  segmentBtnActive: { backgroundColor: colors.brand },
  segmentText: { ...type.label, color: colors.textSecondary },
  segmentTextActive: { color: colors.textInverse },
  grid2: { flexDirection: "row", flexWrap: "wrap", gap: spacing.md, marginTop: spacing.sm },
  smallCta: { flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 10, paddingVertical: 6, backgroundColor: colors.brand, borderRadius: radius.sharp },
  smallCtaText: { color: colors.textInverse, fontSize: 10, fontWeight: "800", letterSpacing: 0.8 },
  input: { minHeight: 52, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.inputBg, borderRadius: radius.sharp, paddingHorizontal: spacing.md, marginTop: 6, fontSize: 16, color: colors.textPrimary },
  inputError: { borderColor: colors.borderError, backgroundColor: colors.errorBg },
  inlineErr: { color: colors.errorText, fontSize: 12, marginTop: 4 },
  hardBlock: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 4 },
  gateBox: { flexDirection: "row", alignItems: "center", gap: spacing.sm, marginTop: spacing.md, padding: spacing.md, borderWidth: 1, borderRadius: radius.sharp },
  dropzone: { marginTop: spacing.sm, borderStyle: "dashed", borderWidth: 1.5, borderColor: colors.border, paddingVertical: 28, alignItems: "center", justifyContent: "center", borderRadius: radius.sharp, backgroundColor: colors.bg },
  thumb: { flex: 1, aspectRatio: 1, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.bg, alignItems: "center", justifyContent: "center", borderRadius: radius.sharp, overflow: "hidden" },
  errorBanner: { marginTop: spacing.md, flexDirection: "row", alignItems: "center", gap: spacing.sm, padding: spacing.md, backgroundColor: colors.errorBg, borderWidth: 1, borderColor: colors.borderError, borderRadius: radius.sharp },
  stickyBar: { padding: spacing.md, backgroundColor: colors.card, borderTopWidth: 1, borderTopColor: colors.border, gap: 10 },
  primaryCta: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, backgroundColor: colors.brand, paddingVertical: 16, borderRadius: radius.button },
  primaryCtaText: { color: colors.textInverse, fontWeight: "800", letterSpacing: 1, fontSize: 13 },
  toggleRow: { flexDirection: "row", gap: spacing.sm, marginTop: 6 },
  toggleBtn: { flex: 1, paddingVertical: 14, alignItems: "center", borderWidth: 1, borderColor: colors.border, borderRadius: radius.sharp, backgroundColor: colors.inputBg },
  pickerRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  modalBackdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.45)", justifyContent: "flex-end" },
  modalSheet: { backgroundColor: colors.card, borderTopLeftRadius: 16, borderTopRightRadius: 16, padding: spacing.md, paddingBottom: spacing.lg },
  modalHandle: { alignSelf: "center", width: 44, height: 4, borderRadius: 2, backgroundColor: colors.border, marginBottom: spacing.sm },
  modalClose: { alignItems: "center", paddingVertical: 12, marginTop: spacing.sm, borderTopWidth: 1, borderTopColor: colors.border },
  specOption: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", padding: spacing.md, borderWidth: 1, borderColor: colors.border, borderRadius: radius.sharp, marginBottom: spacing.sm, backgroundColor: colors.inputBg },
});
