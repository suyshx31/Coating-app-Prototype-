import { useEffect } from "react";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import { useRouter } from "expo-router";

import { storage } from "@/src/utils/storage";
import { TOKEN_KEY } from "@/src/api";
import { colors } from "@/src/theme";

export default function Index() {
  const router = useRouter();
  useEffect(() => {
    (async () => {
      const token = await storage.getItem<string>(TOKEN_KEY, "");
      router.replace(token ? "/(tabs)" : "/login");
    })();
  }, [router]);
  return (
    <View style={styles.container} testID="splash-loader">
      <ActivityIndicator color={colors.accent} size="large" />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg, alignItems: "center", justifyContent: "center" },
});
