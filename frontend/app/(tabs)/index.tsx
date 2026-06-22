import { useCallback, useEffect, useState } from "react";
import {
  FlatList,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter, useFocusEffect } from "expo-router";
import { Ionicons } from "@expo/vector-icons";

import { api, Dashboard, WorkOrderSummary } from "@/src/api";
import { colors, radius, spacing, type } from "@/src/theme";
import { Card, StatusPill, Label, DataId } from "@/src/components/UI";

type Filter = "all" | "priority" | "pending";

export default function OrdersTab() {
  const router = useRouter();
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [items, setItems] = useState<WorkOrderSummary[]>([]);
  const [dash, setDash] = useState<Dashboard | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const [wos, d] = await Promise.all([
        api.workOrders({ q, filter }),
        api.dashboard(),
      ]);
      setItems(wos);
      setDash(d);
    } catch (e) {
      // unauthenticated; bounce to login
      router.replace("/login");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [q, filter, router]);

  useFocusEffect(useCallback(() => { load(); }, [load]));
  useEffect(() => { load(); }, [load]);

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>QC INSPECTOR</Text>
        <TouchableOpacity testID="orders-profile-shortcut" onPress={() => router.push("/(tabs)/profile")}>
          <Ionicons name="person-circle-outline" size={28} color={colors.textPrimary} />
        </TouchableOpacity>
      </View>

      <View style={styles.searchRow}>
        <Ionicons name="search" size={18} color={colors.textMuted} style={{ marginRight: 8 }} />
        <TextInput
          testID="orders-search-input"
          placeholder="Search work orders, customers, products..."
          placeholderTextColor={colors.textMuted}
          value={q}
          onChangeText={setQ}
          style={styles.searchInput}
        />
      </View>

      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.chipsRow}
        style={{ maxHeight: 56 }}
      >
        {(["all", "priority", "pending"] as Filter[]).map((f) => (
          <TouchableOpacity
            key={f}
            testID={`orders-filter-${f}`}
            onPress={() => setFilter(f)}
            style={[styles.chip, filter === f && styles.chipActive]}
            activeOpacity={0.85}
          >
            <Text style={[styles.chipText, filter === f && styles.chipTextActive]}>
              {f === "all" ? "ALL ORDERS" : f.toUpperCase()}
            </Text>
          </TouchableOpacity>
        ))}
      </ScrollView>

      <FlatList
        data={items}
        keyExtractor={(it) => it.work_order_id}
        contentContainerStyle={{ padding: spacing.md, paddingBottom: 80 }}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => { setRefreshing(true); load(); }}
            tintColor={colors.accent}
          />
        }
        ListHeaderComponent={
          dash ? (
            <View style={{ gap: spacing.md, marginBottom: spacing.md }}>
              <Card style={{ borderLeftWidth: 4, borderLeftColor: colors.accent }}>
                <View style={styles.rowBetween}>
                  <Label>Current Assignment</Label>
                  {dash.current_assignment?.priority ? <StatusPill status="fail" testID="priority-pill" /> : null}
                </View>
                {dash.current_assignment ? (
                  <>
                    <DataId style={{ marginTop: 6 }}>{dash.current_assignment.work_order_id}</DataId>
                    <Text style={[type.body, { marginTop: 4 }]}>{dash.current_assignment.part_description}</Text>
                    <Text style={[type.bodySm, { marginTop: 2 }]}>{dash.current_assignment.customer_name}</Text>
                    <TouchableOpacity
                      testID="open-current-assignment"
                      onPress={() => router.push(`/work-order/${dash.current_assignment!.work_order_id}`)}
                      style={styles.primaryCta}
                    >
                      <Ionicons name="play" size={14} color={colors.textInverse} />
                      <Text style={styles.primaryCtaText}>OPEN INSPECTION</Text>
                    </TouchableOpacity>
                  </>
                ) : (
                  <Text style={[type.bodySm, { marginTop: 6 }]}>{"All orders complete"}</Text>
                )}
              </Card>

              <View style={{ flexDirection: "row", gap: spacing.md }}>
                <Card style={{ flex: 1 }}>
                  <Label>Daily Quota</Label>
                  <Text style={styles.quotaNum}>
                    {dash.quota.completed}<Text style={{ color: colors.textMuted }}>/{dash.quota.target}</Text>
                  </Text>
                  <View style={styles.progressTrack}>
                    <View style={[styles.progressFill, { width: `${Math.min(100, (dash.quota.completed / dash.quota.target) * 100)}%` }]} />
                  </View>
                </Card>
                <Card style={{ flex: 1 }}>
                  <Label>System Status</Label>
                  <View style={{ flexDirection: "row", alignItems: "center", marginTop: 6, gap: 6 }}>
                    <View style={styles.dot} />
                    <Text style={{ ...type.mono, color: colors.successText, fontWeight: "800" }}>SYNCED</Text>
                  </View>
                  <Text style={[type.caption, { marginTop: 4 }]}>2 mins ago</Text>
                </Card>
              </View>

              <Card>
                <Label>Active Shift</Label>
                <Text style={[type.h3, { marginTop: 4 }]}>{dash.shift.code.toUpperCase()}</Text>
                <Text style={[type.bodySm, { marginTop: 2 }]}>Lead: {dash.shift.lead}</Text>
              </Card>

              <Label style={{ marginTop: spacing.sm }}>Work Orders ({items.length})</Label>
            </View>
          ) : null
        }
        renderItem={({ item }) => (
          <TouchableOpacity
            testID={`work-order-card-${item.work_order_id}`}
            onPress={() => router.push(`/work-order/${item.work_order_id}`)}
            activeOpacity={0.85}
          >
            <Card style={{ marginBottom: spacing.md }}>
              <View style={styles.rowBetween}>
                <DataId>#{item.work_order_id}</DataId>
                {item.priority ? (
                  <View style={styles.prioBadge}>
                    <Ionicons name="flame" size={11} color={colors.errorText} />
                    <Text style={styles.prioText}>PRIORITY</Text>
                  </View>
                ) : null}
              </View>
              <Text style={[type.body, { marginTop: 6, fontWeight: "700" }]}>{item.customer_name}</Text>
              <Text style={[type.bodySm, { marginTop: 2 }]}>{item.part_description}</Text>
              <View style={[styles.rowBetween, { marginTop: spacing.md }]}>
                <View style={styles.productChip}>
                  <Text style={styles.productChipText}>{item.paint_product_code}</Text>
                </View>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
                  <Text style={type.caption}>{item.progress}/{item.total_stages} STAGES</Text>
                  <StatusPill status={item.overall_status} testID={`wo-status-${item.work_order_id}`} />
                </View>
              </View>
              <TouchableOpacity
                testID={`inspect-cta-${item.work_order_id}`}
                onPress={() => router.push(`/work-order/${item.work_order_id}`)}
                style={[styles.inspectCta]}
              >
                <Ionicons name="clipboard-outline" size={14} color={colors.textInverse} />
                <Text style={styles.inspectCtaText}>INSPECT</Text>
              </TouchableOpacity>
            </Card>
          </TouchableOpacity>
        )}
        ListEmptyComponent={
          !loading ? (
            <View style={{ padding: spacing.xl, alignItems: "center" }}>
              <Ionicons name="file-tray-outline" size={32} color={colors.textMuted} />
              <Text style={[type.bodySm, { marginTop: 8 }]}>No work orders match the filter.</Text>
            </View>
          ) : null
        }
      />
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
  headerTitle: { ...type.h2, letterSpacing: 1 },
  searchRow: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: colors.card,
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
    margin: spacing.md,
    marginBottom: 0,
    borderRadius: radius.sharp,
    borderWidth: 1,
    borderColor: colors.border,
  },
  searchInput: { flex: 1, paddingVertical: 12, color: colors.textPrimary, fontSize: 14 },
  chipsRow: { paddingHorizontal: spacing.md, paddingVertical: spacing.sm, gap: 8, alignItems: "center" },
  chip: {
    flexShrink: 0,
    height: 36,
    paddingHorizontal: 14,
    borderRadius: radius.sharp,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
    alignItems: "center",
    justifyContent: "center",
  },
  chipActive: { backgroundColor: colors.brand, borderColor: colors.brand },
  chipText: { fontFamily: type.label.fontFamily, fontWeight: "700", fontSize: 11, color: colors.textSecondary, letterSpacing: 0.8 },
  chipTextActive: { color: colors.textInverse },
  rowBetween: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  prioBadge: { flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 8, paddingVertical: 3, backgroundColor: colors.errorBg, borderRadius: radius.sharp },
  prioText: { ...type.caption, color: colors.errorText, fontWeight: "800" },
  productChip: { paddingHorizontal: 10, paddingVertical: 5, backgroundColor: colors.bg, borderRadius: radius.sharp, borderWidth: 1, borderColor: colors.border },
  productChipText: { ...type.caption, color: colors.textPrimary, fontWeight: "700" },
  inspectCta: { marginTop: spacing.md, backgroundColor: colors.brand, paddingVertical: 12, borderRadius: radius.button, alignItems: "center", flexDirection: "row", justifyContent: "center", gap: 6 },
  inspectCtaText: { color: colors.textInverse, fontWeight: "800", letterSpacing: 1, fontSize: 12 },
  primaryCta: { marginTop: spacing.md, backgroundColor: colors.brand, paddingVertical: 12, borderRadius: radius.button, alignItems: "center", flexDirection: "row", justifyContent: "center", gap: 6 },
  primaryCtaText: { color: colors.textInverse, fontWeight: "800", letterSpacing: 1, fontSize: 12 },
  quotaNum: { ...type.h1, marginTop: 4, fontSize: 30 },
  progressTrack: { height: 6, backgroundColor: colors.bg, borderRadius: 999, marginTop: 8, overflow: "hidden", borderWidth: 1, borderColor: colors.border },
  progressFill: { height: "100%", backgroundColor: colors.brand },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.successText },
});
