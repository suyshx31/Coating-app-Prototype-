import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
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

import { api, WorkOrderDetail, Weather } from "@/src/api";
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

// Mirror of backend STAGE_PARAMS: which measured parameters each stage takes.
// curing / final_qc are observational (readings, photos, notes, result only).
const STAGE_FIELDS: Record<string, ("surface_profile" | "dft" | "salts")[]> = {
  surface_prep: ["surface_profile", "salts"],
  primer_coat: ["dft"],
  mid_inspection: ["dft"],
  top_coat: ["dft"],
  curing: [],
  final_qc: [],
};

const DFT_LABEL: Record<string, string> = {
  primer_coat: "PRIMER COAT DFT (µm)",
  mid_inspection: "CUMULATIVE DFT (µm)",
  top_coat: "TOTAL SYSTEM DFT (µm)",
};

function n(s: string): number | null {
  if (s === "" || s == null) return null;
  const v = Number(s);
  return Number.isFinite(v) ? v : null;
}

// Cumulative DFT window for this stage: per-coat limits from the paint system
// when present, else the WO's total spec range (legacy WOs).
function dftWindow(wo: WorkOrderDetail, stageKey: string): [number, number] {
  const cl = wo.coat_limits;
  const w =
    stageKey === "primer_coat" ? cl?.primer
    : stageKey === "mid_inspection" ? cl?.mid_cumulative
    : stageKey === "top_coat" ? cl?.total
    : null;
  return w ?? [wo.spec.dft_min_um, wo.spec.dft_max_um];
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
  const [surfaceProfile, setSurfaceProfile] = useState("");
  const [dft, setDft] = useState("");
  const [salts, setSalts] = useState("");
  const [notes, setNotes] = useState("");
  const [photos, setPhotos] = useState<string[]>([]);

  const stageKey = String(stage);
  const fields = useMemo(() => STAGE_FIELDS[stageKey] ?? [], [stageKey]);

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
  // Two-step flow: record start readings first, end readings + parameters after.
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

  // Gate check: surface temp must be > dew point + 3
  const gate = useMemo(() => {
    const st = n(readings.surface_temp_c);
    const dp = n(readings.dew_point_c);
    if (st == null || dp == null) return { ok: false, msg: "Enter surface temp & dew point" };
    if (st > dp + 3) return { ok: true, msg: `${st} > ${dp} + 3 °C` };
    return { ok: false, msg: `${st} ≤ ${dp} + 3 °C — unsafe to coat` };
  }, [readings]);

  const [dftMin, dftMax] = wo ? dftWindow(wo, stageKey) : [0, 0];

  const dftIssue = useMemo(() => {
    if (!wo || !fields.includes("dft")) return null;
    const v = n(dft);
    if (v == null) return null;
    if (v > dftMax) return { hardBlock: true, msg: `DFT ${v} µm exceeds max ${dftMax} µm` };
    if (v < dftMin) return { hardBlock: false, msg: `Below min ${dftMin} µm` };
    return null;
  }, [dft, wo, fields, dftMin, dftMax]);

  const profileIssue = useMemo(() => {
    if (!wo || !fields.includes("surface_profile")) return null;
    const v = n(surfaceProfile);
    if (v == null) return null;
    if (v < wo.spec.surface_profile_min_um || v > wo.spec.surface_profile_max_um) {
      return `Outside spec ${wo.spec.surface_profile_min_um}-${wo.spec.surface_profile_max_um} µm`;
    }
    return null;
  }, [surfaceProfile, wo, fields]);

  const saltsIssue = useMemo(() => {
    if (!wo || !fields.includes("salts")) return null;
    const v = n(salts);
    if (v == null) return null;
    if (wo.spec.soluble_salts_max_mg_m2 == null) return null; // spec defines no salts limit
    if (v > wo.spec.soluble_salts_max_mg_m2) return `Exceeds max ${wo.spec.soluble_salts_max_mg_m2} mg/m²`;
    return null;
  }, [salts, wo, fields]);

  const readingsFilled = !!(readings.surface_temp_c && readings.dew_point_c);
  const paramsFilled =
    (!fields.includes("surface_profile") || !!surfaceProfile) &&
    (!fields.includes("dft") || !!dft) &&
    (!fields.includes("salts") || !!salts);

  const canStart = readingsFilled && !submitting;
  const canSubmit = readingsFilled && paramsFilled && !dftIssue?.hardBlock && !submitting;

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
      await api.startStage(wo.work_order_id, stageKey, numericReadings());
      setReadings(emptyR); // form now collects END readings
      await load();
    } catch (e: any) {
      setServerError(e?.message || "Failed to record start of stage");
    } finally {
      setSubmitting(false);
    }
  };

  const onSubmit = async () => {
    if (!wo) return;
    setServerError(null);
    setSubmitting(true);
    try {
      const parameters: Record<string, number> = {};
      if (fields.includes("surface_profile")) parameters.surface_profile_um = Number(surfaceProfile);
      if (fields.includes("dft")) parameters.dft_um = Number(dft);
      if (fields.includes("salts")) parameters.soluble_salts_mg_m2 = Number(salts);
      const body = {
        readings: { end: numericReadings() },
        parameters,
        notes,
        photos,
        result: gate.ok && !profileIssue && !saltsIssue && !dftIssue ? "pass" : "fail",
      };
      const r = await api.submitStage(wo.work_order_id, stageKey, body);
      router.replace(`/work-order/${wo.work_order_id}/submitted?stage=${stageKey}&result=${r.result}`);
    } catch (e: any) {
      setServerError(e?.body?.detail?.errors?.join("\n") || e?.message || "Submission failed");
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
                <Label>Start readings (recorded)</Label>
                <Text style={[type.mono, { marginTop: 4 }]}>
                  Air {stageMeta.start_readings.ambient_temp_c ?? "—"}°C · RH {stageMeta.start_readings.relative_humidity_pct ?? "—"}% ·
                  Dew {stageMeta.start_readings.dew_point_c ?? "—"}°C · Surface {stageMeta.start_readings.surface_temp_c ?? "—"}°C
                </Text>
                <Text style={[type.caption, { marginTop: 4 }]}>
                  {stageMeta.started_at} · {stageMeta.started_by}
                </Text>
              </Card>
            ) : null}

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
                <Field
                  label="Air Temp (°C)"
                  testID="env-air-temp-input"
                  value={readings.ambient_temp_c}
                  onChangeText={(v) => setReadings((r) => ({ ...r, ambient_temp_c: v }))}
                />
                <Field
                  label="Humidity (%)"
                  testID="env-rh-input"
                  value={readings.relative_humidity_pct}
                  onChangeText={(v) => setReadings((r) => ({ ...r, relative_humidity_pct: v }))}
                />
                <Field
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
              <Field
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
                    GATE · Surface Temp &gt; Dew Point + 3°C
                  </Text>
                  <Text style={[type.bodySm, { color: gate.ok ? colors.successText : colors.errorText, marginTop: 2 }]}>
                    {gate.msg}
                  </Text>
                </View>
                <StatusPill status={gate.ok ? "pass" : "fail"} testID={`gate-pill-${phase}`} />
              </View>
            </Card>

            {/* Measured parameters — END phase only, fields specific to this stage */}
            {phase === "end" && fields.length > 0 ? (
              <Card style={{ marginTop: spacing.md }}>
                <Label>Measured Parameters · {stageMeta?.name}</Label>

                {fields.includes("surface_profile") ? (
                  <View style={{ marginTop: spacing.md }}>
                    <View style={styles.rowBetween}>
                      <Text style={[type.label, { color: colors.textPrimary }]}>SURFACE PROFILE (µm)</Text>
                      <Text style={type.caption}>Limit {wo.spec.surface_profile_min_um}-{wo.spec.surface_profile_max_um} µm</Text>
                    </View>
                    <TextInput
                      testID="param-surface-profile-input"
                      value={surfaceProfile}
                      onChangeText={setSurfaceProfile}
                      placeholder="0.00"
                      placeholderTextColor={colors.textMuted}
                      keyboardType="decimal-pad"
                      style={[styles.input, profileIssue && styles.inputError]}
                    />
                    {profileIssue ? <Text style={styles.inlineErr}>{profileIssue}</Text> : null}
                  </View>
                ) : null}

                {fields.includes("dft") ? (
                  <View style={{ marginTop: spacing.md }}>
                    <View style={styles.rowBetween}>
                      <Text style={[type.label, { color: colors.textPrimary }]}>{DFT_LABEL[stageKey] ?? "DFT (µm)"}</Text>
                      <Text style={type.caption}>Min {dftMin} · Max {dftMax}</Text>
                    </View>
                    <TextInput
                      testID="param-dft-input"
                      value={dft}
                      onChangeText={setDft}
                      placeholder="0.00"
                      placeholderTextColor={colors.textMuted}
                      keyboardType="decimal-pad"
                      style={[styles.input, dftIssue && styles.inputError]}
                    />
                    {dftIssue ? (
                      <View style={styles.hardBlock}>
                        <Ionicons
                          name={dftIssue.hardBlock ? "lock-closed" : "warning-outline"}
                          size={14}
                          color={dftIssue.hardBlock ? colors.errorText : colors.warningText}
                        />
                        <Text style={[styles.inlineErr, { color: dftIssue.hardBlock ? colors.errorText : colors.warningText }]}>
                          {dftIssue.hardBlock ? "HARD BLOCK · " : ""}{dftIssue.msg}
                        </Text>
                      </View>
                    ) : null}
                  </View>
                ) : null}

                {fields.includes("salts") ? (
                  <View style={{ marginTop: spacing.md }}>
                    <View style={styles.rowBetween}>
                      <Text style={[type.label, { color: colors.textPrimary }]}>SOLUBLE SALTS (mg/m²)</Text>
                      <Text style={type.caption}>{wo.spec.soluble_salts_max_mg_m2 != null ? `Max ${wo.spec.soluble_salts_max_mg_m2}` : "No limit in spec"}</Text>
                    </View>
                    <TextInput
                      testID="param-salts-input"
                      value={salts}
                      onChangeText={setSalts}
                      placeholder="0.00"
                      placeholderTextColor={colors.textMuted}
                      keyboardType="decimal-pad"
                      style={[styles.input, saltsIssue && styles.inputError]}
                    />
                    {saltsIssue ? <Text style={styles.inlineErr}>{saltsIssue}</Text> : null}
                  </View>
                ) : null}
              </Card>
            ) : null}

            {phase === "end" && fields.length === 0 ? (
              <Card style={{ marginTop: spacing.md }}>
                <Label>Observational stage</Label>
                <Text style={[type.bodySm, { marginTop: spacing.xs }]}>
                  {stageMeta?.description}. No measured parameters — record photos, notes and the result.
                </Text>
              </Card>
            ) : null}

            {/* Photos + notes only make sense on the final (end) submission */}
            {phase === "end" ? (
              <>
                <Card style={{ marginTop: spacing.md }}>
                  <Label>Evidence Photos ({photos.length}/5)</Label>
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
              </>
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
              <StatusPill status={dftIssue?.hardBlock ? "fail" : gate.ok ? "pass" : "in_progress"} />
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
    </SafeAreaView>
  );
}

function Field({
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
});
