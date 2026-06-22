import { useEffect, useMemo, useState } from "react";
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
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";

import { api, CoatingSpec, CreateWorkOrderBody, DuplicateExistingWO } from "@/src/api";
import { colors, radius, spacing, type } from "@/src/theme";
import { Card, Label } from "@/src/components/UI";

type Form = {
  customer_name: string;
  customer_address: string;
  po_number: string;
  po_line_item_number: string;
  part_number: string;
  part_revision_number: string;
  coating_spec_code: string;
  coating_spec_revision_number: string;
  quantity: string;
};

const initial: Form = {
  customer_name: "",
  customer_address: "",
  po_number: "",
  po_line_item_number: "",
  part_number: "",
  part_revision_number: "",
  coating_spec_code: "",
  coating_spec_revision_number: "",
  quantity: "",
};

export default function NewWorkOrderScreen() {
  const router = useRouter();
  const [form, setForm] = useState<Form>(initial);
  const [specs, setSpecs] = useState<CoatingSpec[]>([]);
  const [specsLoading, setSpecsLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [showSpecPicker, setShowSpecPicker] = useState(false);
  const [specSearch, setSpecSearch] = useState("");
  const [serverError, setServerError] = useState<string | null>(null);
  const [duplicateWo, setDuplicateWo] = useState<DuplicateExistingWO | null>(null);
  const [touched, setTouched] = useState<Record<keyof Form, boolean>>({} as any);

  useEffect(() => {
    (async () => {
      try {
        const r = await api.coatingSpecs();
        setSpecs(r);
      } catch (e: any) {
        if (e?.status === 401) router.replace("/login");
      } finally {
        setSpecsLoading(false);
      }
    })();
  }, [router]);

  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((s) => ({ ...s, [k]: v }));
  const blur = (k: keyof Form) => setTouched((t) => ({ ...t, [k]: true }));

  const errors = useMemo(() => {
    const e: Partial<Record<keyof Form, string>> = {};
    if (!form.customer_name.trim()) e.customer_name = "Required";
    if (!form.po_number.trim()) e.po_number = "Required";
    if (!form.po_line_item_number.trim()) e.po_line_item_number = "Required";
    else if (!/^\d+$/.test(form.po_line_item_number) || Number(form.po_line_item_number) < 1) e.po_line_item_number = "Whole number ≥ 1";
    if (!form.part_number.trim()) e.part_number = "Required";
    if (!form.part_revision_number.trim()) e.part_revision_number = "Required";
    if (!form.coating_spec_code) e.coating_spec_code = "Pick a spec";
    if (!form.coating_spec_revision_number.trim()) e.coating_spec_revision_number = "Required";
    if (!form.quantity.trim()) e.quantity = "Required";
    else if (!/^\d+$/.test(form.quantity) || Number(form.quantity) < 1) e.quantity = "Whole number ≥ 1";
    return e;
  }, [form]);

  const canSubmit = Object.keys(errors).length === 0 && !submitting;

  const buildBody = (): CreateWorkOrderBody => ({
    customer_name: form.customer_name.trim(),
    customer_address: form.customer_address.trim() || undefined,
    po_number: form.po_number.trim(),
    po_line_item_number: Number(form.po_line_item_number),
    part_number: form.part_number.trim(),
    part_revision_number: form.part_revision_number.trim(),
    coating_spec_code: form.coating_spec_code,
    coating_spec_revision_number: form.coating_spec_revision_number.trim(),
    quantity: Number(form.quantity),
  });

  const doCreate = async (confirmDuplicate: boolean) => {
    setServerError(null);
    setSubmitting(true);
    try {
      const created = await api.createWorkOrder({ ...buildBody(), confirm_duplicate: confirmDuplicate });
      setDuplicateWo(null);
      router.replace(`/work-order/created?id=${encodeURIComponent(created.work_order_id)}`);
    } catch (e: any) {
      if (e?.status === 409 && e?.body?.detail?.duplicate) {
        setDuplicateWo(e.body.detail.existing as DuplicateExistingWO);
      } else {
        setServerError(e?.message || "Failed to create work order");
      }
    } finally {
      setSubmitting(false);
    }
  };

  const onSubmit = async () => {
    setTouched(Object.fromEntries(Object.keys(form).map((k) => [k, true])) as any);
    if (!canSubmit) return;
    await doCreate(false);
  };

  const pickedSpec = specs.find((s) => s.code === form.coating_spec_code);
  const filteredSpecs = specs.filter((s) =>
    `${s.code} ${s.name}`.toLowerCase().includes(specSearch.toLowerCase()),
  );

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <View style={styles.header}>
        <TouchableOpacity testID="new-wo-back" onPress={() => router.back()}>
          <Ionicons name="chevron-back" size={26} color={colors.textPrimary} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>NEW WORK ORDER</Text>
        <View style={{ width: 26 }} />
      </View>

      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={{ flex: 1 }}>
        <ScrollView contentContainerStyle={{ padding: spacing.md, paddingBottom: 120 }} keyboardShouldPersistTaps="handled">
          <Card>
            <Label>Customer</Label>
            <Field
              label="Customer Name *"
              testID="field-customer-name"
              value={form.customer_name}
              onChangeText={(v) => set("customer_name", v)}
              onBlur={() => blur("customer_name")}
              error={touched.customer_name ? errors.customer_name : undefined}
              placeholder="e.g. Helix Drilling Co."
            />
            <Field
              label="Customer Address (optional)"
              testID="field-customer-address"
              value={form.customer_address}
              onChangeText={(v) => set("customer_address", v)}
              placeholder="Street, city, postal code"
              multiline
              numberOfLines={3}
            />
          </Card>

          <Card style={{ marginTop: spacing.md }}>
            <Label>Purchase Order</Label>
            <Field
              label="PO Number *"
              testID="field-po-number"
              value={form.po_number}
              onChangeText={(v) => set("po_number", v)}
              onBlur={() => blur("po_number")}
              error={touched.po_number ? errors.po_number : undefined}
              placeholder="Customer external PO ref (e.g. PO-HDC-2026-008)"
            />
            <Field
              label="PO Line Item Number *"
              testID="field-po-line-item"
              value={form.po_line_item_number}
              onChangeText={(v) => set("po_line_item_number", v.replace(/[^0-9]/g, ""))}
              onBlur={() => blur("po_line_item_number")}
              error={touched.po_line_item_number ? errors.po_line_item_number : undefined}
              keyboardType="number-pad"
              placeholder="e.g. 1"
            />
            <Text style={[type.caption, { marginTop: spacing.xs }]}>
              The customer's PO and line item — separate from the internal WO-YYYY-NNNN ID we generate.
            </Text>
          </Card>

          <Card style={{ marginTop: spacing.md }}>
            <Label>Part</Label>
            <Field
              label="Part Number *"
              testID="field-part-number"
              value={form.part_number}
              onChangeText={(v) => set("part_number", v)}
              onBlur={() => blur("part_number")}
              error={touched.part_number ? errors.part_number : undefined}
              placeholder="e.g. HX-441"
            />
            <Field
              label="Part Revision Number *"
              testID="field-part-revision"
              value={form.part_revision_number}
              onChangeText={(v) => set("part_revision_number", v)}
              onBlur={() => blur("part_revision_number")}
              error={touched.part_revision_number ? errors.part_revision_number : undefined}
              placeholder="e.g. B"
            />
            <Text style={[type.caption, { marginTop: spacing.xs }]}>
              Part Number + Revision form the unique part identifier.
            </Text>
          </Card>

          <Card style={{ marginTop: spacing.md }}>
            <Label>Coating Specification</Label>

            <Text style={[type.label, { color: colors.textPrimary, marginTop: spacing.sm }]}>SPECIFICATION *</Text>
            <TouchableOpacity
              testID="field-coating-spec-picker"
              onPress={() => { setSpecSearch(""); setShowSpecPicker(true); }}
              style={[styles.input, styles.pickerRow, touched.coating_spec_code && errors.coating_spec_code && styles.inputError]}
              activeOpacity={0.85}
            >
              {pickedSpec ? (
                <View style={{ flex: 1 }}>
                  <Text style={[type.body, { fontWeight: "700" }]}>{pickedSpec.code}</Text>
                  <Text style={[type.caption, { marginTop: 2 }]}>{pickedSpec.name}</Text>
                </View>
              ) : (
                <Text style={[type.body, { color: colors.textMuted, flex: 1 }]}>
                  {specsLoading ? "Loading specs…" : "Tap to pick a coating specification"}
                </Text>
              )}
              <Ionicons name="chevron-down" size={18} color={colors.textMuted} />
            </TouchableOpacity>
            {touched.coating_spec_code && errors.coating_spec_code ? (
              <Text style={styles.inlineErr}>{errors.coating_spec_code}</Text>
            ) : null}

            {pickedSpec ? (
              <View style={styles.specSummary} testID="picked-spec-summary">
                <SpecRow label="Surface Profile" value={`${pickedSpec.spec.surface_profile_min_um}–${pickedSpec.spec.surface_profile_max_um} µm`} />
                <SpecRow label="DFT" value={`${pickedSpec.spec.dft_min_um}–${pickedSpec.spec.dft_max_um} µm`} />
                <SpecRow label="Salts" value={`≤ ${pickedSpec.spec.soluble_salts_max_mg_m2} mg/m²`} />
              </View>
            ) : null}

            <Field
              label="Coating Spec Revision Number *"
              testID="field-coating-spec-revision"
              value={form.coating_spec_revision_number}
              onChangeText={(v) => set("coating_spec_revision_number", v)}
              onBlur={() => blur("coating_spec_revision_number")}
              error={touched.coating_spec_revision_number ? errors.coating_spec_revision_number : undefined}
              placeholder="e.g. R3"
            />
          </Card>

          <Card style={{ marginTop: spacing.md }}>
            <Label>Quantity</Label>
            <Field
              label="Order Quantity *"
              testID="field-quantity"
              value={form.quantity}
              onChangeText={(v) => set("quantity", v.replace(/[^0-9]/g, ""))}
              onBlur={() => blur("quantity")}
              error={touched.quantity ? errors.quantity : undefined}
              keyboardType="number-pad"
              placeholder="e.g. 18"
            />
          </Card>

          {serverError ? (
            <View style={styles.errorBanner} testID="new-wo-server-error">
              <Ionicons name="alert-circle" size={18} color={colors.errorText} />
              <Text style={{ flex: 1, color: colors.errorText, fontSize: 13 }}>{serverError}</Text>
            </View>
          ) : null}

          <Text style={[type.caption, { textAlign: "center", marginTop: spacing.lg }]}>
            On submit, a unique WO-{new Date().getFullYear()}-NNNN ID is generated automatically.
          </Text>
        </ScrollView>

        <View style={styles.stickyBar}>
          <TouchableOpacity
            testID="submit-new-work-order"
            disabled={!canSubmit}
            onPress={onSubmit}
            style={[styles.primaryCta, !canSubmit && { opacity: 0.5 }]}
            activeOpacity={0.85}
          >
            {submitting ? (
              <ActivityIndicator color={colors.textInverse} />
            ) : (
              <>
                <Ionicons name="add-circle" size={16} color={colors.textInverse} />
                <Text style={styles.primaryCtaText}>CREATE WORK ORDER</Text>
              </>
            )}
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>

      <Modal
        visible={!!duplicateWo}
        animationType="fade"
        transparent
        onRequestClose={() => setDuplicateWo(null)}
      >
        <View style={styles.modalBackdrop}>
          <View style={styles.dupCard} testID="duplicate-warning-modal">
            <View style={styles.dupIconWrap}>
              <Ionicons name="warning" size={32} color={colors.warningText} />
            </View>
            <Text style={[type.h3, { textAlign: "center", marginTop: spacing.md }]}>
              Possible Duplicate Work Order
            </Text>
            <Text style={[type.bodySm, { textAlign: "center", marginTop: 6 }]}>
              A work order already exists for{"\n"}
              PO <Text style={type.mono}>{form.po_number}</Text> · line{" "}
              <Text style={type.mono}>{form.po_line_item_number}</Text> · part{" "}
              <Text style={type.mono}>{form.part_number} Rev {form.part_revision_number}</Text>.
            </Text>

            {duplicateWo ? (
              <View style={styles.dupExisting} testID="duplicate-existing-info">
                <View style={styles.dupRow}>
                  <Text style={type.caption}>EXISTING WO</Text>
                  <Text style={[type.dataId, { fontSize: 15 }]} testID="duplicate-existing-id">
                    #{duplicateWo.work_order_id}
                  </Text>
                </View>
                <View style={styles.dupRow}>
                  <Text style={type.caption}>STATUS</Text>
                  <Text style={[type.mono, { textTransform: "uppercase" }]}>
                    {duplicateWo.overall_status} · {duplicateWo.progress}/6
                  </Text>
                </View>
                <View style={styles.dupRow}>
                  <Text style={type.caption}>CREATED BY</Text>
                  <Text style={type.mono}>#{duplicateWo.created_by}</Text>
                </View>
                <View style={styles.dupRow}>
                  <Text style={type.caption}>CREATED AT</Text>
                  <Text style={type.mono}>{new Date(duplicateWo.created_at).toLocaleString()}</Text>
                </View>
                <View style={styles.dupRow}>
                  <Text style={type.caption}>QTY</Text>
                  <Text style={type.mono}>{duplicateWo.quantity} pcs</Text>
                </View>
              </View>
            ) : null}

            <TouchableOpacity
              testID="duplicate-open-existing"
              onPress={() => {
                const id = duplicateWo?.work_order_id;
                setDuplicateWo(null);
                if (id) router.replace(`/work-order/${id}`);
              }}
              style={styles.dupPrimaryCta}
              activeOpacity={0.85}
            >
              <Ionicons name="open-outline" size={16} color={colors.textInverse} />
              <Text style={styles.dupPrimaryCtaText}>OPEN EXISTING WO</Text>
            </TouchableOpacity>

            <TouchableOpacity
              testID="duplicate-create-anyway"
              onPress={() => doCreate(true)}
              disabled={submitting}
              style={[styles.dupDangerCta, submitting && { opacity: 0.5 }]}
              activeOpacity={0.85}
            >
              {submitting ? (
                <ActivityIndicator color={colors.errorText} />
              ) : (
                <>
                  <Ionicons name="add-circle-outline" size={16} color={colors.errorText} />
                  <Text style={styles.dupDangerCtaText}>CREATE ANYWAY</Text>
                </>
              )}
            </TouchableOpacity>

            <TouchableOpacity
              testID="duplicate-cancel"
              onPress={() => setDuplicateWo(null)}
              style={styles.dupCancel}
              activeOpacity={0.85}
            >
              <Text style={styles.dupCancelText}>CANCEL</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      <Modal
        visible={showSpecPicker}
        animationType="slide"
        transparent
        onRequestClose={() => setShowSpecPicker(false)}
      >
        <Pressable style={styles.modalBackdrop} onPress={() => setShowSpecPicker(false)}>
          <Pressable style={styles.modalSheet} onPress={(e) => e.stopPropagation()}>
            <View style={styles.modalHandle} />
            <Text style={[type.h3, { marginBottom: spacing.sm }]}>Select Coating Spec</Text>
            <TextInput
              testID="spec-picker-search"
              value={specSearch}
              onChangeText={setSpecSearch}
              placeholder="Search by code or name…"
              placeholderTextColor={colors.textMuted}
              style={[styles.input, { marginBottom: spacing.sm }]}
            />
            <ScrollView style={{ maxHeight: 360 }}>
              {filteredSpecs.length === 0 ? (
                <Text style={[type.bodySm, { textAlign: "center", padding: spacing.lg }]}>No specs match.</Text>
              ) : (
                filteredSpecs.map((s) => {
                  const selected = s.code === form.coating_spec_code;
                  return (
                    <TouchableOpacity
                      key={s.code}
                      testID={`spec-option-${s.code}`}
                      onPress={() => { set("coating_spec_code", s.code); blur("coating_spec_code"); setShowSpecPicker(false); }}
                      style={[styles.specOption, selected && { backgroundColor: colors.bg, borderColor: colors.brand }]}
                      activeOpacity={0.85}
                    >
                      <View style={{ flex: 1 }}>
                        <Text style={[type.body, { fontWeight: "700" }]}>{s.code}</Text>
                        <Text style={[type.caption, { marginTop: 2 }]}>{s.name}</Text>
                        <Text style={[type.caption, { marginTop: 4 }]}>
                          SP {s.spec.surface_profile_min_um}–{s.spec.surface_profile_max_um}µm · DFT {s.spec.dft_min_um}–{s.spec.dft_max_um}µm · Salts ≤{s.spec.soluble_salts_max_mg_m2}
                        </Text>
                      </View>
                      {selected ? <Ionicons name="checkmark-circle" size={20} color={colors.successText} /> : null}
                    </TouchableOpacity>
                  );
                })
              )}
            </ScrollView>
            <TouchableOpacity testID="spec-picker-close" onPress={() => setShowSpecPicker(false)} style={styles.modalClose}>
              <Text style={[type.label, { color: colors.textPrimary }]}>CLOSE</Text>
            </TouchableOpacity>
          </Pressable>
        </Pressable>
      </Modal>
    </SafeAreaView>
  );
}

function Field({
  label,
  value,
  onChangeText,
  onBlur,
  error,
  placeholder,
  keyboardType,
  testID,
  multiline,
  numberOfLines,
}: {
  label: string;
  value: string;
  onChangeText: (v: string) => void;
  onBlur?: () => void;
  error?: string;
  placeholder?: string;
  keyboardType?: any;
  testID: string;
  multiline?: boolean;
  numberOfLines?: number;
}) {
  return (
    <View style={{ marginTop: spacing.md }}>
      <Text style={[type.label, { color: colors.textPrimary }]}>{label.toUpperCase()}</Text>
      <TextInput
        testID={testID}
        value={value}
        onChangeText={onChangeText}
        onBlur={onBlur}
        placeholder={placeholder}
        placeholderTextColor={colors.textMuted}
        keyboardType={keyboardType}
        multiline={multiline}
        numberOfLines={numberOfLines}
        style={[styles.input, multiline && { minHeight: 84, textAlignVertical: "top" }, error && styles.inputError]}
      />
      {error ? <Text style={styles.inlineErr} testID={`${testID}-error`}>{error}</Text> : null}
    </View>
  );
}

function SpecRow({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.specRow}>
      <Text style={type.caption}>{label.toUpperCase()}</Text>
      <Text style={[type.mono]}>{value}</Text>
    </View>
  );
}

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
  input: { minHeight: 52, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.inputBg, borderRadius: radius.sharp, paddingHorizontal: spacing.md, marginTop: 6, fontSize: 15, color: colors.textPrimary, paddingVertical: 10 },
  inputError: { borderColor: colors.borderError, backgroundColor: colors.errorBg },
  inlineErr: { color: colors.errorText, fontSize: 12, marginTop: 4 },
  pickerRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  specSummary: { marginTop: spacing.sm, padding: spacing.sm, borderWidth: 1, borderColor: colors.border, borderRadius: radius.sharp, backgroundColor: colors.bg, gap: 4 },
  specRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  errorBanner: { marginTop: spacing.md, flexDirection: "row", alignItems: "center", gap: spacing.sm, padding: spacing.md, backgroundColor: colors.errorBg, borderWidth: 1, borderColor: colors.borderError, borderRadius: radius.sharp },
  stickyBar: { padding: spacing.md, backgroundColor: colors.card, borderTopWidth: 1, borderTopColor: colors.border },
  primaryCta: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, backgroundColor: colors.brand, paddingVertical: 16, borderRadius: radius.button },
  primaryCtaText: { color: colors.textInverse, fontWeight: "800", letterSpacing: 1, fontSize: 13 },
  modalBackdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.45)", justifyContent: "flex-end" },
  modalSheet: { backgroundColor: colors.card, borderTopLeftRadius: 12, borderTopRightRadius: 12, padding: spacing.md, paddingBottom: spacing.xl },
  modalHandle: { alignSelf: "center", width: 40, height: 4, borderRadius: 2, backgroundColor: colors.border, marginBottom: spacing.md },
  specOption: { flexDirection: "row", alignItems: "center", gap: 8, padding: spacing.md, borderWidth: 1, borderColor: colors.border, borderRadius: radius.sharp, marginBottom: spacing.sm },
  modalClose: { alignSelf: "center", paddingVertical: 12, paddingHorizontal: 24, marginTop: spacing.sm },
  dupCard: { width: "92%", maxWidth: 420, backgroundColor: colors.card, borderRadius: radius.sharp, borderWidth: 1, borderColor: colors.warningText, padding: spacing.lg, alignItems: "stretch" },
  dupIconWrap: { alignSelf: "center", width: 56, height: 56, borderRadius: radius.sharp, backgroundColor: colors.warningBg, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: colors.warningText },
  dupExisting: { marginTop: spacing.md, padding: spacing.md, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.bg, borderRadius: radius.sharp, gap: 8 },
  dupRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  dupPrimaryCta: { marginTop: spacing.lg, backgroundColor: colors.brand, paddingVertical: 14, borderRadius: radius.button, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8 },
  dupPrimaryCtaText: { color: colors.textInverse, fontWeight: "800", letterSpacing: 1, fontSize: 13 },
  dupDangerCta: { marginTop: spacing.sm, borderWidth: 1, borderColor: colors.borderError, paddingVertical: 14, borderRadius: radius.button, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, backgroundColor: colors.errorBg },
  dupDangerCtaText: { color: colors.errorText, fontWeight: "800", letterSpacing: 1, fontSize: 12 },
  dupCancel: { marginTop: spacing.sm, paddingVertical: 12, alignItems: "center" },
  dupCancelText: { color: colors.textSecondary, fontWeight: "700", letterSpacing: 1, fontSize: 12 },
});
