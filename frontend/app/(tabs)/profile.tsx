import { useCallback, useState } from "react";
import { Image, ScrollView, StyleSheet, Text, TouchableOpacity, View, ActivityIndicator } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useFocusEffect, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";

import { api, Inspector, TOKEN_KEY, USER_KEY } from "@/src/api";
import { storage } from "@/src/utils/storage";
import { colors, radius, spacing, type } from "@/src/theme";
import { Card, Label } from "@/src/components/UI";

export default function ProfileTab() {
  const router = useRouter();
  const [user, setUser] = useState<Inspector | null>(null);
  const [loading, setLoading] = useState(true);

  useFocusEffect(
    useCallback(() => {
      let alive = true;
      (async () => {
        try {
          const u = await api.me();
          if (alive) setUser(u);
        } catch {
          router.replace("/login");
        } finally {
          if (alive) setLoading(false);
        }
      })();
      return () => { alive = false; };
    }, [router]),
  );

  const signOut = async () => {
    await storage.removeItem(TOKEN_KEY);
    await storage.removeItem(USER_KEY);
    router.replace("/login");
  };

  if (loading || !user) {
    return (
      <SafeAreaView style={styles.safe} edges={["top"]}>
        <ActivityIndicator color={colors.accent} style={{ marginTop: 80 }} />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>ACCOUNT DETAILS</Text>
      </View>
      <ScrollView contentContainerStyle={{ padding: spacing.md, paddingBottom: 80 }}>
        <View style={{ alignItems: "center", paddingVertical: spacing.lg }}>
          <View style={styles.avatarWrap}>
            {user.avatar_url ? (
              <Image source={{ uri: user.avatar_url }} style={styles.avatar} />
            ) : (
              <Ionicons name="person" size={48} color={colors.textMuted} />
            )}
            <View style={styles.avatarBadge}>
              <Ionicons name="checkmark" size={12} color={colors.textInverse} />
            </View>
          </View>
          <Text style={[type.h2, { marginTop: spacing.md, letterSpacing: 1 }]}>{user.name.toUpperCase()}</Text>
          <Text style={[type.label, { marginTop: 4, color: colors.accent }]}>{user.role.toUpperCase()}</Text>
        </View>

        <Card style={{ padding: 0 }}>
          {[
            { label: "Employee ID", value: `#${user.employee_id}`, mono: true },
            { label: "Shift", value: user.shift },
            { label: "Department", value: user.department },
            { label: "Email", value: user.email },
          ].map((row, i, arr) => (
            <View key={row.label} style={[styles.row, i < arr.length - 1 && styles.rowDivider]}>
              <Label>{row.label}</Label>
              <Text style={[row.mono ? type.dataId : type.body, { marginTop: 4 }]} numberOfLines={1}>
                {row.value}
              </Text>
            </View>
          ))}
        </Card>

        <TouchableOpacity testID="sync-settings-row" style={[styles.actionRow]} activeOpacity={0.85}>
          <Ionicons name="sync" size={16} color={colors.textPrimary} />
          <Text style={[type.body, { fontWeight: "700", flex: 1, marginLeft: 10 }]}>SYNC SETTINGS</Text>
          <Ionicons name="chevron-forward" size={16} color={colors.textMuted} />
        </TouchableOpacity>

        <TouchableOpacity
          testID="sign-out-button"
          onPress={signOut}
          style={[styles.actionRow, { borderColor: colors.borderError, marginTop: spacing.md }]}
          activeOpacity={0.85}
        >
          <Ionicons name="log-out-outline" size={16} color={colors.errorText} />
          <Text style={[type.body, { fontWeight: "700", flex: 1, marginLeft: 10, color: colors.errorText }]}>SIGN OUT</Text>
        </TouchableOpacity>

        <Text style={[type.caption, { textAlign: "center", marginTop: spacing.xl }]}>APP v1.0.0 · COATING PORTAL</Text>
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
  avatarWrap: { width: 96, height: 96, borderRadius: 8, backgroundColor: colors.card, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: colors.border },
  avatar: { width: 96, height: 96, borderRadius: 8 },
  avatarBadge: { position: "absolute", right: -4, bottom: -4, backgroundColor: colors.brand, width: 22, height: 22, borderRadius: 11, alignItems: "center", justifyContent: "center" },
  row: { padding: spacing.md },
  rowDivider: { borderBottomWidth: 1, borderBottomColor: colors.border },
  actionRow: {
    marginTop: spacing.lg,
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: colors.card,
    padding: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sharp,
  },
});
