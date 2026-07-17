import { useCallback, useState } from "react";
import { FlatList, StyleSheet, Text, View, ActivityIndicator } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useFocusEffect, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";

import { api, HistoryItem } from "@/src/api";
import { colors, radius, spacing, type } from "@/src/theme";
import { Card, DataId, Label, StatusPill } from "@/src/components/UI";

function fmtTs(iso: string) {
  try {
    const d = new Date(iso);
    return d.toLocaleString(undefined, { month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
  } catch {
    return iso;
  }
}

export default function HistoryTab() {
  const router = useRouter();
  const [items, setItems] = useState<HistoryItem[]>([]);
  const [loading, setLoading] = useState(true);

  useFocusEffect(
    useCallback(() => {
      let alive = true;
      (async () => {
        try {
          const r = await api.history();
          if (alive) setItems(r);
        } catch {
          router.replace("/login");
        } finally {
          if (alive) setLoading(false);
        }
      })();
      return () => { alive = false; };
    }, [router]),
  );

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>HISTORY</Text>
      </View>
      {loading ? (
        <ActivityIndicator color={colors.accent} style={{ marginTop: 80 }} />
      ) : (
        <FlatList
          data={items}
          keyExtractor={(it, idx) => `${it.work_order_id}-${it.stage_key}-${idx}`}
          contentContainerStyle={{ padding: spacing.md, paddingBottom: 80 }}
          ListEmptyComponent={
            <View style={{ alignItems: "center", padding: spacing.xl }}>
              <Ionicons name="time-outline" size={32} color={colors.textMuted} />
              <Text style={[type.bodySm, { marginTop: 8 }]}>No submissions yet.</Text>
            </View>
          }
          renderItem={({ item }) => (
            <Card style={{ marginBottom: spacing.md }} testID={`history-${item.work_order_id}-${item.stage_key}`}>
              <View style={styles.rowBetween}>
                <DataId>#{item.work_order_id}</DataId>
                <StatusPill status={item.result === "pass" ? "pass" : item.result === "fail" ? "fail" : "pending"} />
              </View>
              <Text style={[type.body, { marginTop: 6, fontWeight: "700" }]}>{item.stage_name}</Text>
              <Text style={[type.bodySm, { marginTop: 2 }]}>{item.customer_name}</Text>
              <View style={[styles.rowBetween, { marginTop: 10 }]}>
                <Text style={type.caption}>BY {item.inspector_name || "—"}</Text>
                <Text style={type.caption}>{fmtTs(item.timestamp)}</Text>
              </View>
            </Card>
          )}
        />
      )}
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
  rowBetween: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
});
