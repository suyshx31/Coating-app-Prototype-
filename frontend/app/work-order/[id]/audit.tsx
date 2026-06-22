import { useEffect, useState } from "react";
import { ActivityIndicator, FlatList, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";

import { api, AuditEntry } from "@/src/api";
import { colors, radius, spacing, type } from "@/src/theme";
import { Card } from "@/src/components/UI";

const ICONS: Record<string, any> = {
  login: "log-in-outline",
  stage_submit: "checkmark-done-outline",
  stage_submit_blocked: "lock-closed-outline",
};

function fmtTs(iso: string) {
  try {
    const d = new Date(iso);
    return d.toLocaleString();
  } catch {
    return iso;
  }
}

export default function AuditLogScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const [items, setItems] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!id) return;
    (async () => {
      try {
        const r = await api.auditLog(id);
        setItems(r);
      } catch (e: any) {
        if (e?.status === 401) router.replace("/login");
      } finally {
        setLoading(false);
      }
    })();
  }, [id, router]);

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <View style={styles.header}>
        <TouchableOpacity testID="audit-back" onPress={() => router.back()}>
          <Ionicons name="chevron-back" size={26} color={colors.textPrimary} />
        </TouchableOpacity>
        <Text style={[type.h3, { letterSpacing: 1 }]}>AUDIT LOG · #{id}</Text>
        <View style={{ width: 26 }} />
      </View>

      {loading ? (
        <ActivityIndicator color={colors.accent} style={{ marginTop: 80 }} />
      ) : (
        <FlatList
          data={items}
          keyExtractor={(it) => it.id}
          contentContainerStyle={{ padding: spacing.md, paddingBottom: 80 }}
          ListEmptyComponent={
            <View style={{ alignItems: "center", padding: spacing.xl }}>
              <Ionicons name="document-outline" size={32} color={colors.textMuted} />
              <Text style={[type.bodySm, { marginTop: 8 }]}>No audit entries yet.</Text>
            </View>
          }
          renderItem={({ item, index }) => (
            <View style={styles.row} testID={`audit-${item.id}`}>
              <View style={styles.timeline}>
                <View style={[styles.dot, item.action === "stage_submit_blocked" && { backgroundColor: colors.errorText }]} />
                {index < items.length - 1 ? <View style={styles.line} /> : null}
              </View>
              <Card style={{ flex: 1 }}>
                <View style={styles.rowBetween}>
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                    <Ionicons name={ICONS[item.action] || "ellipse-outline"} size={14} color={colors.textPrimary} />
                    <Text style={[type.label, { color: colors.textPrimary }]}>{item.action.replace(/_/g, " ").toUpperCase()}</Text>
                  </View>
                  <Text style={type.caption}>{fmtTs(item.timestamp)}</Text>
                </View>
                <Text style={[type.bodySm, { marginTop: 6 }]}>{item.detail}</Text>
                <View style={{ marginTop: 8, flexDirection: "row", alignItems: "center", gap: 6 }}>
                  <Ionicons name="person-outline" size={11} color={colors.textMuted} />
                  <Text style={[type.caption, { color: colors.textSecondary }]}>{item.actor_name} · #{item.actor_employee_id}</Text>
                  {item.stage_key ? (
                    <View style={styles.stageChip}>
                      <Text style={[type.caption, { color: colors.textPrimary, fontWeight: "800" }]}>{item.stage_key.replace(/_/g, " ").toUpperCase()}</Text>
                    </View>
                  ) : null}
                </View>
              </Card>
            </View>
          )}
        />
      )}
    </SafeAreaView>
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
  row: { flexDirection: "row", gap: spacing.sm, marginBottom: spacing.sm },
  rowBetween: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  timeline: { width: 16, alignItems: "center", paddingTop: spacing.md },
  dot: { width: 10, height: 10, borderRadius: 5, backgroundColor: colors.brand },
  line: { flex: 1, width: 2, backgroundColor: colors.border, marginTop: 4 },
  stageChip: { marginLeft: "auto", paddingHorizontal: 8, paddingVertical: 2, borderRadius: radius.sharp, backgroundColor: colors.bg, borderWidth: 1, borderColor: colors.border },
});
