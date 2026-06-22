import { Text, TextProps, StyleSheet, View, ViewProps } from "react-native";
import { colors, radius, type } from "@/src/theme";

export function StatusPill({
  status,
  testID,
}: {
  status: "pending" | "in_progress" | "done" | "fail" | "pass" | string;
  testID?: string;
}) {
  const map: Record<string, { bg: string; fg: string; label: string }> = {
    done:        { bg: colors.successBg, fg: colors.successText, label: "DONE" },
    pass:        { bg: colors.successBg, fg: colors.successText, label: "PASS" },
    fail:        { bg: colors.errorBg,   fg: colors.errorText,   label: "FAIL" },
    in_progress: { bg: colors.warningBg, fg: colors.warningText, label: "IN PROGRESS" },
    pending:     { bg: colors.pendingBg, fg: colors.pendingText, label: "PENDING" },
  };
  const cfg = map[status] || map.pending;
  return (
    <View testID={testID} style={[styles.pill, { backgroundColor: cfg.bg }]}>
      <Text style={[styles.pillText, { color: cfg.fg }]}>{cfg.label}</Text>
    </View>
  );
}

export function Label({ children, style, ...p }: TextProps) {
  return <Text {...p} style={[type.label, style]}>{children}</Text>;
}

export function DataId({ children, style, ...p }: TextProps) {
  return <Text {...p} style={[type.dataId, style]}>{children}</Text>;
}

export function Card({ children, style, ...p }: ViewProps) {
  return <View {...p} style={[styles.card, style]}>{children}</View>;
}

export function Divider() {
  return <View style={styles.divider} />;
}

const styles = StyleSheet.create({
  pill: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: radius.sharp,
    alignSelf: "flex-start",
  },
  pillText: {
    fontFamily: type.label.fontFamily,
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 0.8,
  },
  card: {
    backgroundColor: colors.card,
    borderRadius: radius.sharp,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 16,
  },
  divider: { height: 1, backgroundColor: colors.border, marginVertical: 12 },
});
