import { useCallback, useState } from "react";
import { StyleSheet, Text, TouchableOpacity, View, ScrollView, ActivityIndicator } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter, useFocusEffect } from "expo-router";
import { Ionicons } from "@expo/vector-icons";

import { api, Dashboard } from "@/src/api";
import { colors, radius, spacing, type } from "@/src/theme";
import { Card, DataId, Label, StatusPill } from "@/src/components/UI";

export default function InspectTab() {
  const router = useRouter();
  const [dash, setDash] = useState<Dashboard | null>(null);
  const [loading, setLoading] = useState(true);

  useFocusEffect(
    useCallback(() => {
      let alive = true;
      (async () => {
        try {
          const d = await api.dashboard();
          if (alive) setDash(d);
        } catch {
          router.replace("/login");
        } finally {
          if (alive) setLoading(false);
        }
      })();
      return () => { alive = false; };
    }, [router]),
  );

  if (loading) {
    return (
      <SafeAreaView style={styles.safe} edges={["top"]}>
        <ActivityIndicator color={colors.accent} style={{ marginTop: 80 }} />
      </SafeAreaView>
    );
  }

  const wo = dash?.current_assignment;

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>INSPECT</Text>
      </View>
      <ScrollView contentContainerStyle={{ padding: spacing.md, paddingBottom: 80 }}>
        {wo ? (
          <>
            <Card>
              <Label>Current Assignment</Label>
              <DataId style={{ marginTop: 6 }}>#{wo.work_order_id}</DataId>
              <Text style={[type.body, { marginTop: 4, fontWeight: "700" }]}>{wo.customer_name}</Text>
              <Text style={[type.bodySm, { marginTop: 2 }]}>{wo.part_description}</Text>
              <View style={{ flexDirection: "row", marginTop: spacing.md, gap: 6, alignItems: "center" }}>
                <View style={styles.productChip}>
                  <Text style={styles.productChipText}>{wo.paint_product_code}</Text>
                </View>
                <StatusPill status={wo.overall_status} />
              </View>
            </Card>

            <Label style={{ marginTop: spacing.lg, marginBottom: spacing.sm }}>Inspection Workflow · 6 Stages</Label>
            <Card style={{ padding: 0 }}>
              {wo.stages.map((s, idx) => {
                const enabled = s.status !== "pending" || idx === 0 || wo.stages[idx - 1]?.status === "done";
                return (
                  <TouchableOpacity
                    key={s.key}
                    testID={`inspect-stage-${s.key}`}
                    disabled={!enabled}
                    onPress={() => router.push(`/work-order/${wo.work_order_id}/stage/${s.key}`)}
                    style={[styles.stageRow, idx < wo.stages.length - 1 && styles.stageRowDivider, !enabled && { opacity: 0.5 }]}
                    activeOpacity={0.85}
                  >
                    <View style={{ flex: 1 }}>
                      <Text style={[type.body, { fontWeight: "700" }]}>{s.name}</Text>
                      <Text style={[type.bodySm, { marginTop: 2 }]}>{s.description}</Text>
                    </View>
                    <StatusPill status={s.status} testID={`stage-status-${s.key}`} />
                  </TouchableOpacity>
                );
              })}
            </Card>

            <TouchableOpacity
              testID="open-wo-detail"
              onPress={() => router.push(`/work-order/${wo.work_order_id}`)}
              style={styles.primaryCta}
            >
              <Ionicons name="open-outline" size={14} color={colors.textInverse} />
              <Text style={styles.primaryCtaText}>OPEN FULL WORK ORDER</Text>
            </TouchableOpacity>
          </>
        ) : (
          <View style={{ alignItems: "center", padding: spacing.xl }}>
            <Ionicons name="checkmark-done-circle" size={48} color={colors.successText} />
            <Text style={[type.h3, { marginTop: spacing.md }]}>All Clear</Text>
            <Text style={[type.bodySm, { marginTop: 4 }]}>No active assignment right now.</Text>
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  header: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    backgroundColor: colors.card,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  headerTitle: { ...type.h2, letterSpacing: 1 },
  productChip: { paddingHorizontal: 10, paddingVertical: 5, backgroundColor: colors.bg, borderRadius: radius.sharp, borderWidth: 1, borderColor: colors.border },
  productChipText: { ...type.caption, color: colors.textPrimary, fontWeight: "700" },
  stageRow: { flexDirection: "row", alignItems: "center", padding: spacing.md, gap: spacing.md },
  stageRowDivider: { borderBottomWidth: 1, borderBottomColor: colors.border },
  primaryCta: { marginTop: spacing.lg, backgroundColor: colors.brand, paddingVertical: 14, borderRadius: radius.button, alignItems: "center", flexDirection: "row", justifyContent: "center", gap: 6 },
  primaryCtaText: { color: colors.textInverse, fontWeight: "800", letterSpacing: 1, fontSize: 12 },
});
