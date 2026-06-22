/**
 * Coating Portal — design tokens
 * Mirrors /app/design_guidelines.json so screens import a single source of truth.
 */
import { Platform } from "react-native";

export const colors = {
  bg: "#F3F4F6",
  card: "#FFFFFF",
  tabBar: "#FFFFFF",
  textPrimary: "#0B132B",
  textSecondary: "#4B5563",
  textMuted: "#9CA3AF",
  textInverse: "#FFFFFF",
  brand: "#0A0A0A",
  accent: "#D97706",
  successBg: "#ECFDF5",
  successText: "#059669",
  errorBg: "#FEF2F2",
  errorText: "#DC2626",
  warningBg: "#FFFBEB",
  warningText: "#D97706",
  pendingBg: "#F3F4F6",
  pendingText: "#6B7280",
  border: "#E5E7EB",
  borderFocus: "#D97706",
  borderError: "#EF4444",
  inputBg: "#F9FAFB",
};

export const spacing = { xs: 4, sm: 8, md: 16, lg: 24, xl: 32, xxl: 48 };
export const radius = { sharp: 2, button: 4, pill: 999 };

export const mono = Platform.select({
  ios: "Menlo",
  android: "monospace",
  default: "Menlo",
}) as string;

export const fonts = {
  body: Platform.select({ ios: "System", android: "Roboto", default: "System" }) as string,
  mono,
};

export const type = {
  h1: { fontFamily: fonts.body, fontSize: 28, lineHeight: 36, fontWeight: "800" as const, color: colors.textPrimary, letterSpacing: -0.5 },
  h2: { fontFamily: fonts.body, fontSize: 22, lineHeight: 30, fontWeight: "700" as const, color: colors.textPrimary },
  h3: { fontFamily: fonts.body, fontSize: 18, lineHeight: 26, fontWeight: "700" as const, color: colors.textPrimary },
  body: { fontFamily: fonts.body, fontSize: 15, lineHeight: 22, fontWeight: "400" as const, color: colors.textPrimary },
  bodySm: { fontFamily: fonts.body, fontSize: 13, lineHeight: 20, fontWeight: "400" as const, color: colors.textSecondary },
  label: { fontFamily: fonts.mono, fontSize: 11, lineHeight: 16, fontWeight: "700" as const, color: colors.textSecondary, textTransform: "uppercase" as const, letterSpacing: 0.8 },
  dataId: { fontFamily: fonts.mono, fontSize: 16, lineHeight: 22, fontWeight: "700" as const, color: colors.accent, letterSpacing: 0.5 },
  caption: { fontFamily: fonts.mono, fontSize: 11, lineHeight: 14, fontWeight: "600" as const, color: colors.textMuted, letterSpacing: 0.5 },
  mono: { fontFamily: fonts.mono, fontSize: 13, lineHeight: 18, fontWeight: "600" as const, color: colors.textPrimary, letterSpacing: 0.5 },
};
