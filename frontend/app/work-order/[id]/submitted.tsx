import { useCallback, useState } from "react";
import { ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";

import { api, Stage, WorkOrderDetail } from "@/src/api";
import { colors, radius, spacing, type } from "@/src/theme";
import { Card, DataId, Label, StatusPill } from "@/src/components/UI";

export default function SubmittedScreen() {
  const { id, stage, result } = useLocalSearchParams<{ id: string; stage: string; result: string }>();
  const router = useRouter();
  const [wo, setWo] = useState<WorkOrderDetail | null>(null);

  useFocusEffect(
    useCallback(() => {
      if (!id) return;
      api.workOrder(id).then(setWo).catch((e: any) => {
        if (e?.status === 401) router.replace("/login");
      });
    }, [id, router]),
  );

  const pass = result === "pass";
  const stageMeta: Stage | undefined = wo?.stages.find((s) => s.key === String(stage));
  // specific reasons that produced this result, straight from the stored submission
  const failureReasons: string[] = stageMeta?.submission?.errors ?? [];
  // next actionable stage in the case-type sequence (stages are ordered)
  const nextStage = wo?.stages.find((s) => s.status === "pending" || s.status === "in_progress");

  return (
    <SafeAreaView style={styles.safe} edges={["top", "bottom"]}>
      <ScrollView contentContainerStyle={styles.container}>
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
            <Text style={[type.body, { fontWeight: "700" }]}>{stageMeta?.name ?? stage}</Text>
          </View>
          <View style={[styles.row]}>
            <View>
              <Text style={type.bodySm}>Result</Text>
              <Text style={type.caption}>{stageMeta?.submitted_at ?? ""}</Text>
            </View>
            <StatusPill status={pass ? "pass" : "fail"} testID="submitted-result-pill" />
          </View>
        </Card>

        {failureReasons.length > 0 ? (
          <Card style={{ marginTop: spacing.md, width: "100%", borderColor: colors.borderError, backgroundColor: colors.errorBg }}>
            <Label>Failure Reasons</Label>
            {failureReasons.map((reason, i) => (
              <View key={i} style={styles.reasonRow} testID={`failure-reason-${i}`}>
                <Ionicons name="close-circle" size={14} color={colors.errorText} style={{ marginTop: 2 }} />
                <Text style={[type.bodySm, { color: colors.errorText, flex: 1 }]}>{reason}</Text>
              </View>
            ))}
          </Card>
        ) : null}

        {nextStage ? (
          <TouchableOpacity
            testID="proceed-next-stage"
            onPress={() => router.replace(`/work-order/${id}/stage/${nextStage.key}`)}
            style={styles.primaryCta}
            activeOpacity={0.85}
          >
            <Text style={styles.primaryCtaText}>PROCEED TO NEXT STAGE · {nextStage.name.toUpperCase()}</Text>
            <Ionicons name="play-forward" size={16} color={colors.textInverse} />
          </TouchableOpacity>
        ) : null}

        <TouchableOpacity
          testID="return-to-orders"
          onPress={() => router.replace("/(tabs)")}
          style={nextStage ? styles.secondaryBtn : styles.primaryCta}
          activeOpacity={0.85}
        >
          <Text style={nextStage ? styles.secondaryBtnText : styles.primaryCtaText}>RETURN TO ORDER LIST</Text>
          <Ionicons name="arrow-forward" size={16} color={nextStage ? colors.textPrimary : colors.textInverse} />
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
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  container: { flexGrow: 1, padding: spacing.lg, alignItems: "center", justifyContent: "center" },
  checkBox: { width: 100, height: 100, borderRadius: radius.sharp, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: colors.border },
  row: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingVertical: spacing.sm },
  rowDivider: { borderTopWidth: 1, borderTopColor: colors.border, borderBottomWidth: 1, borderBottomColor: colors.border },
  reasonRow: { flexDirection: "row", gap: 6, alignItems: "flex-start", marginTop: spacing.xs },
  primaryCta: { marginTop: spacing.xl, width: "100%", backgroundColor: colors.brand, paddingVertical: 16, borderRadius: radius.button, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8 },
  primaryCtaText: { color: colors.textInverse, fontWeight: "800", letterSpacing: 1, fontSize: 13 },
  secondaryBtn: { marginTop: spacing.md, width: "100%", borderWidth: 1, borderColor: colors.border, backgroundColor: colors.card, paddingVertical: 16, borderRadius: radius.button, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8 },
  secondaryBtnText: { color: colors.textPrimary, fontWeight: "800", letterSpacing: 1, fontSize: 13 },
  secondaryCta: { marginTop: spacing.md, flexDirection: "row", alignItems: "center", gap: 6, paddingVertical: 12, paddingHorizontal: 20 },
  secondaryCtaText: { color: colors.textPrimary, fontWeight: "800", letterSpacing: 1, fontSize: 12 },
});
