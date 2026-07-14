import { useState } from "react";
import {
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
  ActivityIndicator,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";

import { api, TOKEN_KEY, USER_KEY } from "@/src/api";
import { storage } from "@/src/utils/storage";
import { colors, radius, spacing, type } from "@/src/theme";

export default function LoginScreen() {
  const router = useRouter();
  const [email, setEmail] = useState("j.thompson@aerospace-precision.com");
  const [password, setPassword] = useState("Inspector@123");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onSubmit = async () => {
    setError(null);
    setLoading(true);

    try {
      console.log("STEP 1");

      const r = await api.login(email.trim(), password);

      console.log("STEP 2", r);

      await storage.setItem(TOKEN_KEY, r.access_token);
      console.log("STEP 3");

      await storage.setItem(USER_KEY, JSON.stringify(r.user));
      console.log("STEP 4");

      router.replace("/(tabs)");
      console.log("STEP 5");

    } catch (e: any) {
      console.error("LOGIN ERROR:", e);
      setError(e?.message || "Login failed");
    } finally {
      console.log("STEP 6");
      setLoading(false);
    }
  };
  return (
    <SafeAreaView style={styles.safe} edges={["top", "bottom"]}>
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={{ flex: 1 }}
      >
        <ScrollView
          contentContainerStyle={styles.scroll}
          keyboardShouldPersistTaps="handled"
        >
          <View style={styles.brand}>
            <View style={styles.brandIcon}>
              <Ionicons name="shield-checkmark" size={28} color={colors.accent} />
            </View>
            <Text style={styles.brandLabel}>ISO 9001 · SECURE</Text>
            <Text style={styles.brandTitle}>TechniSure S</Text>
            <Text style={styles.brandSub}>QC Inspection · Traceability</Text>
          </View>

          <View style={styles.card} testID="login-card">
            <Text style={[type.label, { marginBottom: spacing.sm }]}>Domain Email</Text>
            <TextInput
              testID="login-email-input"
              value={email}
              onChangeText={setEmail}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="email-address"
              placeholder="firstname.lastname@company.com"
              placeholderTextColor={colors.textMuted}
              style={styles.input}
            />

            <Text style={[type.label, { marginTop: spacing.md, marginBottom: spacing.sm }]}>Password</Text>
            <TextInput
              testID="login-password-input"
              value={password}
              onChangeText={setPassword}
              placeholder="••••••••"
              placeholderTextColor={colors.textMuted}
              secureTextEntry
              style={styles.input}
            />

            {error ? (
              <View style={styles.errorBox} testID="login-error">
                <Ionicons name="alert-circle" size={16} color={colors.errorText} />
                <Text style={styles.errorText}>{error}</Text>
              </View>
            ) : null}

            <TouchableOpacity
              testID="login-submit-button"
              onPress={onSubmit}
              disabled={loading || !email || !password}
              style={[styles.cta, (loading || !email || !password) && { opacity: 0.5 }]}
              activeOpacity={0.85}
            >
              {loading ? (
                <ActivityIndicator color={colors.textInverse} />
              ) : (
                <Text style={styles.ctaText}>SIGN IN</Text>
              )}
            </TouchableOpacity>

            <View style={styles.hint}>
              <Text style={[type.caption, { color: colors.textMuted }]}>SEED ACCOUNT</Text>
              <Text style={[type.mono, { color: colors.textSecondary, marginTop: 4 }]}>
                j.thompson@aerospace-precision.com
              </Text>
              <Text style={[type.mono, { color: colors.textSecondary }]}>Inspector@123</Text>
            </View>
          </View>

          <Text style={styles.footer}>v1.0 · Plant-issued device authentication</Text>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  scroll: { padding: spacing.lg, paddingTop: spacing.xl, gap: spacing.lg },
  brand: { alignItems: "flex-start" },
  brandIcon: {
    width: 56,
    height: 56,
    borderRadius: radius.sharp,
    backgroundColor: "#FFF7ED",
    borderWidth: 1,
    borderColor: colors.accent,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: spacing.md,
  },
  brandLabel: { ...type.label, color: colors.accent },
  brandTitle: { ...type.h1, marginTop: 4, letterSpacing: 1 },
  brandSub: { ...type.bodySm, marginTop: 4 },
  card: {
    backgroundColor: colors.card,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radius.sharp,
    padding: spacing.lg,
  },
  input: {
    minHeight: 56,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.inputBg,
    borderRadius: radius.sharp,
    paddingHorizontal: spacing.md,
    fontSize: 15,
    color: colors.textPrimary,
  },
  cta: {
    marginTop: spacing.lg,
    backgroundColor: colors.brand,
    paddingVertical: 18,
    alignItems: "center",
    borderRadius: radius.button,
  },
  ctaText: { color: colors.textInverse, fontWeight: "800", letterSpacing: 1, fontSize: 14 },
  errorBox: {
    marginTop: spacing.md,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    padding: 10,
    backgroundColor: colors.errorBg,
    borderRadius: radius.sharp,
    borderWidth: 1,
    borderColor: colors.borderError,
  },
  errorText: { color: colors.errorText, fontSize: 13, flex: 1 },
  hint: {
    marginTop: spacing.lg,
    padding: spacing.md,
    backgroundColor: colors.bg,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sharp,
  },
  footer: { ...type.caption, textAlign: "center", marginTop: spacing.xl },
});
