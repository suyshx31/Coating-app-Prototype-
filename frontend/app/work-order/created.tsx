import { useEffect } from "react";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";

import { colors, radius, spacing, type } from "@/src/theme";
import { Card, DataId, Label } from "@/src/components/UI";

export default function WorkOrderCreatedScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();

  useEffect(() => {
    // safety: if somehow no id, bounce back
    if (!id) router.replace("/(tabs)");
  }, [id, router]);

  return (
    <SafeAreaView style={styles.safe} edges={["top", "bottom"]}>
      <View style={styles.container}>
        <View style={styles.checkBox}>
          <Ionicons name="checkmark-circle" size={64} color={colors.successText} />
        </View>

        <Text style={[type.h2, { marginTop: spacing.lg, textAlign: "center" }]}>
          Work Order Created
        </Text>
        <Text style={[type.bodySm, { marginTop: 6, textAlign: "center", paddingHorizontal: spacing.lg }]}>
          The work order is now in the Orders list and ready for inspection.
        </Text>

        <Card style={{ marginTop: spacing.xl, width: "100%", alignItems: "center" }}>
          <Label>Internal Work Order ID</Label>
          <DataId style={{ fontSize: 22, marginTop: 8 }} testID="created-wo-id">#{id}</DataId>
          <Text style={[type.caption, { marginTop: 6, textAlign: "center" }]}>
            Use this ID on all inspection screens, audit logs, and reports.
          </Text>
        </Card>

        <TouchableOpacity
          testID="open-created-wo"
          onPress={() => router.replace(`/work-order/${id}`)}
          style={styles.primaryCta}
          activeOpacity={0.85}
        >
          <Ionicons name="open-outline" size={16} color={colors.textInverse} />
          <Text style={styles.primaryCtaText}>OPEN WORK ORDER</Text>
        </TouchableOpacity>

        <TouchableOpacity
          testID="back-to-orders"
          onPress={() => router.replace("/(tabs)")}
          style={styles.secondaryCta}
          activeOpacity={0.85}
        >
          <Text style={styles.secondaryCtaText}>BACK TO ORDERS</Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  container: { flex: 1, padding: spacing.lg, alignItems: "center", justifyContent: "center" },
  checkBox: { width: 100, height: 100, borderRadius: radius.sharp, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: colors.border, backgroundColor: colors.successBg },
  primaryCta: { marginTop: spacing.xl, width: "100%", backgroundColor: colors.brand, paddingVertical: 16, borderRadius: radius.button, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8 },
  primaryCtaText: { color: colors.textInverse, fontWeight: "800", letterSpacing: 1, fontSize: 13 },
  secondaryCta: { marginTop: spacing.md, paddingVertical: 12, paddingHorizontal: 20 },
  secondaryCtaText: { color: colors.textPrimary, fontWeight: "800", letterSpacing: 1, fontSize: 12 },
});
