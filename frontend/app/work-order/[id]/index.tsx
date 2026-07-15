import { useCallback, useEffect, useState } from "react";
import {
  ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View,
  ActivityIndicator, Alert, Linking,
} from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { useLocalSearchParams, useRouter, useFocusEffect } from "expo-router";
import { Ionicons } from "@expo/vector-icons";

import { api, BASE, TOKEN_KEY, GenerateReportResponse, WorkOrderDetail } from "@/src/api";
import { storage } from "@/src/utils/storage";
import { colors, radius, spacing, type } from "@/src/theme";
import { Card, DataId, Label, StatusPill, Divider } from "@/src/components/UI";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Recipient picker + "Generate & Send Report" action, shown once every stage
 * has been submitted. Suggests previously-used recipient emails as you type
 * (from /report-recipients); new addresses are remembered server-side. */
function ReportCard({ workOrderId }: { workOrderId: string }) {
  const [saved, setSaved] = useState<string[]>([]);
  const [recipients, setRecipients] = useState<string[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<GenerateReportResponse | null>(null);

  useEffect(() => {
    api.reportRecipients().then((rows) => setSaved(rows.map((r) => r.email))).catch(() => {});
  }, []);

  const needle = input.trim().toLowerCase();
  const suggestions = needle
    ? saved.filter((e) => e.includes(needle) && !recipients.includes(e)).slice(0, 4)
    : [];

  const addRecipient = (email: string) => {
    const e = email.trim().toLowerCase();
    if (!EMAIL_RE.test(e)) {
      Alert.alert("Invalid email", `"${email.trim()}" is not a valid email address.`);
      return;
    }
    if (!recipients.includes(e)) setRecipients((prev) => [...prev, e]);
    setInput("");
  };

  const generate = async () => {
    setBusy(true);
    setResult(null);
    try {
      const r = await api.generateReport(workOrderId, recipients);
      setResult(r);
      // newly-used addresses are now saved server-side — refresh suggestions
      api.reportRecipients().then((rows) => setSaved(rows.map((x) => x.email))).catch(() => {});
      Alert.alert(
        "Report generated",
        r.email_sent
          ? `PDF emailed to ${r.sent_to.join(", ")}`
          : r.email_error
            ? `PDF generated, but email failed: ${r.email_error}`
            : "PDF generated (no email recipients given).",
      );
    } catch (e: any) {
      Alert.alert("Report failed", e?.message || "Could not generate the report.");
    } finally {
      setBusy(false);
    }
  };

  const openPdf = async () => {
    if (!result) return;
    const token = (await storage.getItem<string>(TOKEN_KEY, "")) || "";
    Linking.openURL(`${BASE}${result.download_url}?token=${encodeURIComponent(token)}`);
  };

  return (
    <Card style={{ marginTop: spacing.lg }}>
      <Label>Final Report</Label>
      <Text style={[type.bodySm, { marginTop: 4 }]}>
        Generate the NOV inspection report and email the PDF to one or more recipients.
      </Text>

      {recipients.length > 0 && (
        <View style={reportStyles.chipRow}>
          {recipients.map((e) => (
            <TouchableOpacity
              key={e}
              testID={`recipient-chip-${e}`}
              style={reportStyles.chip}
              onPress={() => setRecipients((prev) => prev.filter((x) => x !== e))}
            >
              <Text style={reportStyles.chipText}>{e}</Text>
              <Ionicons name="close" size={13} color={colors.textPrimary} />
            </TouchableOpacity>
          ))}
        </View>
      )}

      <View style={reportStyles.inputRow}>
        <TextInput
          testID="report-recipient-input"
          style={reportStyles.input}
          value={input}
          onChangeText={setInput}
          placeholder="Recipient email…"
          placeholderTextColor={colors.textSecondary}
          autoCapitalize="none"
          keyboardType="email-address"
          onSubmitEditing={() => input.trim() && addRecipient(input)}
        />
        <TouchableOpacity
          testID="report-recipient-add"
          style={[reportStyles.addBtn, !input.trim() && { opacity: 0.4 }]}
          disabled={!input.trim()}
          onPress={() => addRecipient(input)}
        >
          <Ionicons name="add" size={18} color={colors.textInverse} />
        </TouchableOpacity>
      </View>

      {suggestions.length > 0 && (
        <View style={reportStyles.suggestBox}>
          {suggestions.map((e) => (
            <TouchableOpacity
              key={e}
              testID={`recipient-suggestion-${e}`}
              style={reportStyles.suggestRow}
              onPress={() => addRecipient(e)}
            >
              <Ionicons name="time-outline" size={14} color={colors.textSecondary} />
              <Text style={type.bodySm}>{e}</Text>
            </TouchableOpacity>
          ))}
        </View>
      )}

      <TouchableOpacity
        testID="generate-send-report"
        style={[reportStyles.generateBtn, busy && { opacity: 0.6 }]}
        disabled={busy}
        onPress={generate}
        activeOpacity={0.85}
      >
        {busy ? (
          <ActivityIndicator color={colors.textInverse} size="small" />
        ) : (
          <Ionicons name="document-text-outline" size={16} color={colors.textInverse} />
        )}
        <Text style={reportStyles.generateText}>
          {recipients.length > 0 ? "GENERATE & SEND REPORT" : "GENERATE REPORT"}
        </Text>
      </TouchableOpacity>

      {result && (
        <View style={reportStyles.resultBox} testID="report-result">
          <Text style={[type.bodySm, { fontWeight: "700" }]}>
            ✓ {result.filename} {result.email_sent ? `— emailed to ${result.sent_to.join(", ")}` : "— generated"}
          </Text>
          <TouchableOpacity onPress={openPdf} style={{ marginTop: 6 }} testID="view-report-pdf">
            <Text style={[type.bodySm, { color: colors.accent, fontWeight: "800" }]}>VIEW PDF</Text>
          </TouchableOpacity>
        </View>
      )}
    </Card>
  );
}

export default function WorkOrderDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [wo, setWo] = useState<WorkOrderDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      const r = await api.workOrder(id);
      setWo(r);
      // auto-select first non-done stage
      const next = r.stages.find((s) => s.status !== "done") || r.stages[0];
      setSelected(next?.key || null);
    } catch (e: any) {
      if (e?.status === 401) router.replace("/login");
    } finally {
      setLoading(false);
    }
  }, [id, router]);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  if (loading || !wo) {
    return (
      <SafeAreaView style={styles.safe} edges={["top"]}>
        <ActivityIndicator color={colors.accent} style={{ marginTop: 80 }} />
      </SafeAreaView>
    );
  }

  const selectedStage = wo.stages.find((s) => s.key === selected);

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <View style={styles.header}>
        <TouchableOpacity testID="wo-back" onPress={() => router.back()}>
          <Ionicons name="chevron-back" size={26} color={colors.textPrimary} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>WORK ORDER</Text>
        <View style={{ width: 26 }} />
      </View>

      <ScrollView contentContainerStyle={{ padding: spacing.md, paddingBottom: 120 }}>
        <Card style={{ borderLeftWidth: 4, borderLeftColor: wo.priority ? colors.errorText : colors.accent }}>
          <View style={styles.rowBetween}>
            <Label>Current Assignment</Label>
            {wo.priority ? (
              <View style={styles.prioBadge}>
                <Ionicons name="flame" size={11} color={colors.errorText} />
                <Text style={styles.prioText}>PRIORITY</Text>
              </View>
            ) : null}
          </View>
          <DataId style={{ marginTop: 6 }}>#{wo.work_order_id}</DataId>
          <Text style={[type.body, { marginTop: 4, fontWeight: "700" }]}>{wo.customer_name}</Text>
          <Text style={[type.bodySm, { marginTop: 2 }]}>{wo.part_description}</Text>
          <Divider />
          <View style={{ flexDirection: "row", gap: spacing.lg }}>
            <View style={{ flex: 1 }}>
              <Label>PO Number</Label>
              <Text style={[type.mono, { marginTop: 4 }]}>{wo.po_number}</Text>
            </View>
            <View style={{ flex: 1 }}>
              <Label>Quantity</Label>
              <Text style={[type.mono, { marginTop: 4 }]}>{wo.quantity} pcs</Text>
            </View>
          </View>
          <View style={{ marginTop: spacing.md }}>
            <Label>Serial Range</Label>
            <Text style={[type.mono, { marginTop: 4 }]}>{wo.serial_range}</Text>
          </View>
          <Divider />
          <Label>Paint Spec · {wo.paint_product_code}</Label>
          <View style={styles.specGrid}>
            <View style={styles.specBox}>
              <Text style={type.caption}>SURFACE PROFILE</Text>
              <Text style={[type.mono, { marginTop: 2 }]}>{wo.spec.surface_profile_min_um}–{wo.spec.surface_profile_max_um} µm</Text>
            </View>
            <View style={styles.specBox}>
              <Text style={type.caption}>DFT (MIN–MAX)</Text>
              <Text style={[type.mono, { marginTop: 2 }]}>{wo.spec.dft_min_um}–{wo.spec.dft_max_um} µm</Text>
            </View>
            <View style={styles.specBox}>
              <Text style={type.caption}>SALTS MAX</Text>
              <Text style={[type.mono, { marginTop: 2 }]}>
                {wo.spec.soluble_salts_max_mg_m2 != null ? `≤ ${wo.spec.soluble_salts_max_mg_m2} mg/m²` : "No limit in spec"}
              </Text>
            </View>
          </View>
        </Card>

        <View style={[styles.rowBetween, { marginTop: spacing.lg, marginBottom: spacing.sm }]}>
          <Label>Inspection Workflow</Label>
          <Text style={type.caption}>{wo.stages.filter(s => s.status === "done").length}/{wo.stages.length} STAGES</Text>
        </View>

        <Card style={{ padding: 0 }}>
          {wo.stages.map((s, idx) => {
            const isSelected = selected === s.key;
            const prevDone = idx === 0 || wo.stages[idx - 1].status === "done";
            const tappable = s.status === "done" || s.status === "fail" || prevDone;
            return (
              <TouchableOpacity
                key={s.key}
                testID={`stage-row-${s.key}`}
                disabled={!tappable}
                onPress={() => setSelected(s.key)}
                style={[
                  styles.stageRow,
                  idx < wo.stages.length - 1 && styles.stageRowDivider,
                  isSelected && styles.stageRowSelected,
                  !tappable && { opacity: 0.55 },
                  s.status === "fail" && { backgroundColor: colors.errorBg },
                ]}
                activeOpacity={0.85}
              >
                <View style={styles.stageIndex}>
                  <Text style={styles.stageIndexText}>{idx + 1}</Text>
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={[type.body, { fontWeight: "700" }, isSelected && { color: colors.textInverse }]}>
                    {s.name}
                  </Text>
                  <Text style={[type.bodySm, { marginTop: 2 }, isSelected && { color: "#E5E7EB" }]}>
                    {s.description}
                  </Text>
                  {/* specific failure reasons, not just a FAIL badge */}
                  {s.status === "fail" && (s.submission?.errors ?? []).length > 0 ? (
                    <View style={{ marginTop: 4 }} testID={`stage-fail-reasons-${s.key}`}>
                      {(s.submission.errors as string[]).map((e, i) => (
                        <Text key={i} style={[type.caption, { color: isSelected ? "#FECACA" : colors.errorText }]}>
                          ✕ {e}
                        </Text>
                      ))}
                    </View>
                  ) : null}
                </View>
                <StatusPill status={s.status} testID={`stage-status-${s.key}`} />
              </TouchableOpacity>
            );
          })}
        </Card>

        <TouchableOpacity
          testID="view-audit-log"
          onPress={() => router.push(`/work-order/${wo.work_order_id}/audit`)}
          style={styles.secondaryCta}
          activeOpacity={0.85}
        >
          <Ionicons name="time-outline" size={16} color={colors.textPrimary} />
          <Text style={styles.secondaryCtaText}>VIEW AUDIT LOG</Text>
        </TouchableOpacity>

        {wo.stages.every((s) => s.status === "done" || s.status === "fail") && (
          <ReportCard workOrderId={wo.work_order_id} />
        )}
      </ScrollView>

      <View style={[styles.stickyBar, { paddingBottom: spacing.md + insets.bottom }]}>
        <TouchableOpacity
          testID="update-selected-stage"
          disabled={!selectedStage}
          onPress={() => selectedStage && router.push(`/work-order/${wo.work_order_id}/stage/${selectedStage.key}`)}
          style={[styles.primaryCta, !selectedStage && { opacity: 0.5 }]}
          activeOpacity={0.85}
        >
          <Ionicons name="create-outline" size={16} color={colors.textInverse} />
          <Text style={styles.primaryCtaText}>UPDATE SELECTED STAGE</Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

const reportStyles = StyleSheet.create({
  chipRow: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm, marginTop: spacing.md },
  chip: { flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 10, paddingVertical: 6, borderWidth: 1, borderColor: colors.border, borderRadius: radius.button, backgroundColor: colors.bg },
  chipText: { ...type.bodySm, fontWeight: "700" },
  inputRow: { flexDirection: "row", gap: spacing.sm, marginTop: spacing.md },
  input: { flex: 1, borderWidth: 1, borderColor: colors.border, borderRadius: radius.sharp, backgroundColor: colors.bg, paddingHorizontal: 12, paddingVertical: 10, ...type.bodySm, color: colors.textPrimary },
  addBtn: { width: 42, alignItems: "center", justifyContent: "center", backgroundColor: colors.brand, borderRadius: radius.sharp },
  suggestBox: { marginTop: 4, borderWidth: 1, borderColor: colors.border, borderRadius: radius.sharp, backgroundColor: colors.bg },
  suggestRow: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 12, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  generateBtn: { marginTop: spacing.md, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, backgroundColor: colors.brand, paddingVertical: 14, borderRadius: radius.button },
  generateText: { color: colors.textInverse, fontWeight: "800", letterSpacing: 1, fontSize: 12 },
  resultBox: { marginTop: spacing.md, padding: spacing.sm, borderWidth: 1, borderColor: colors.border, borderRadius: radius.sharp, backgroundColor: colors.bg },
});

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    backgroundColor: colors.card,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  headerTitle: { ...type.h3, letterSpacing: 1 },
  rowBetween: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  prioBadge: { flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 8, paddingVertical: 3, backgroundColor: colors.errorBg, borderRadius: radius.sharp },
  prioText: { ...type.caption, color: colors.errorText, fontWeight: "800" },
  specGrid: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm, marginTop: spacing.sm },
  specBox: { flexGrow: 1, minWidth: "30%", padding: spacing.sm, borderWidth: 1, borderColor: colors.border, borderRadius: radius.sharp, backgroundColor: colors.bg },
  stageRow: { flexDirection: "row", alignItems: "center", padding: spacing.md, gap: spacing.md },
  stageRowDivider: { borderBottomWidth: 1, borderBottomColor: colors.border },
  stageRowSelected: { backgroundColor: colors.brand },
  stageIndex: { width: 24, height: 24, borderRadius: 12, backgroundColor: colors.bg, borderWidth: 1, borderColor: colors.border, alignItems: "center", justifyContent: "center" },
  stageIndexText: { ...type.caption, color: colors.textPrimary, fontWeight: "800" },
  secondaryCta: { marginTop: spacing.lg, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, paddingVertical: 14, borderWidth: 1, borderColor: colors.brand, borderRadius: radius.button, backgroundColor: colors.card },
  secondaryCtaText: { color: colors.textPrimary, fontWeight: "800", letterSpacing: 1, fontSize: 12 },
  stickyBar: { position: "absolute", left: 0, right: 0, bottom: 0, padding: spacing.md, backgroundColor: colors.card, borderTopWidth: 1, borderTopColor: colors.border },
  primaryCta: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, backgroundColor: colors.brand, paddingVertical: 16, borderRadius: radius.button },
  primaryCtaText: { color: colors.textInverse, fontWeight: "800", letterSpacing: 1, fontSize: 13 },
});
