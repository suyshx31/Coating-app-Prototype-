import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";

import { colors, radius, spacing, type } from "@/src/theme";
import { Card, DataId, Label, StatusPill } from "@/src/components/UI";

const STAGE_NAME: Record<string, string> = {
  surface_prep: "Surface Prep",
  primer_coat: "Primer Coat",
  mid_inspection: "Mid-Inspection",
  top_coat: "Top Coat",
  curing: "Curing Process",
  final_qc: "Final QC",
};

export default function SubmittedScreen() {
  const { id, stage, result } = useLocalSearchParams<{ id: string; stage: string; result: string }>();
  const router = useRouter();

  const pass = result === "pass";
  const now = new Date().toLocaleTimeString();

  return (
    <SafeAreaView style={styles.safe} edges={["top", "bottom"]}>
      <View style={styles.container}>
        <View style={[styles.checkBox, { backgroundColor: pass ? colors.successBg : colors.errorBg }]}>
          <Ionicons name={pass ? "checkmark-circle" : "alert-circle"} size={64} color={pass ? colors.successText : colors.errorText} />
        </View>

        <Text style={[type.h2, { marginTop: spacing.lg, textAlign: "center" }]}>
          {pass ? "Inspection Submitted Successfully" : "Inspection Logged as FAIL"}
        </Text>
        <Text style={[type.bodySm, { marginTop: 6, textAlign: "center", paddingHorizontal: spacing.lg }]}>
          The data has been synchronized with the main server and recorded in the audit trail.
        </Text>

        <Card style={{ marginTop: spacing.xl, width: "100%" }}>
          <Label>Inspection Summary</Label>
          <View style={styles.row}>
            <Text style={type.bodySm}>Work Order</Text>
            <DataId>#{id}</DataId>
          </View>
          <View style={[styles.row, styles.rowDivider]}>
            <Text style={type.bodySm}>Stage</Text>
            <Text style={[type.body, { fontWeight: "700" }]}>{STAGE_NAME[String(stage)] || stage}</Text>
          </View>
          <View style={[styles.row]}>
            <View>
              <Text style={type.bodySm}>Result</Text>
              <Text style={type.caption}>{now}</Text>
            </View>
            <StatusPill status={pass ? "pass" : "fail"} testID="submitted-result-pill" />
          </View>
        </Card>

        <TouchableOpacity
          testID="return-to-orders"
          onPress={() => router.replace("/(tabs)")}
          style={styles.primaryCta}
          activeOpacity={0.85}
        >
          <Text style={styles.primaryCtaText}>RETURN TO ORDER LIST</Text>
          <Ionicons name="arrow-forward" size={16} color={colors.textInverse} />
        </TouchableOpacity>

        <TouchableOpacity
          testID="view-this-audit"
          onPress={() => router.replace(`/work-order/${id}/audit`)}
          style={styles.secondaryCta}
          activeOpacity={0.85}
        >
          <Ionicons name="time-outline" size={14} color={colors.textPrimary} />
          <Text style={styles.secondaryCtaText}>VIEW AUDIT LOG</Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  container: { flex: 1, padding: spacing.lg, alignItems: "center", justifyContent: "center" },
  checkBox: { width: 100, height: 100, borderRadius: radius.sharp, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: colors.border },
  row: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingVertical: spacing.sm },
  rowDivider: { borderTopWidth: 1, borderTopColor: colors.border, borderBottomWidth: 1, borderBottomColor: colors.border },
  primaryCta: { marginTop: spacing.xl, width: "100%", backgroundColor: colors.brand, paddingVertical: 16, borderRadius: radius.button, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8 },
  primaryCtaText: { color: colors.textInverse, fontWeight: "800", letterSpacing: 1, fontSize: 13 },
  secondaryCta: { marginTop: spacing.md, flexDirection: "row", alignItems: "center", gap: 6, paddingVertical: 12, paddingHorizontal: 20 },
  secondaryCtaText: { color: colors.textPrimary, fontWeight: "800", letterSpacing: 1, fontSize: 12 },
});
