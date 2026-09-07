import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';

/** The root: one stack, screen titles from each route's options. */
export default function RootLayout() {
  return (
    <>
      <Stack screenOptions={{ headerTitleAlign: 'center' }} />
      <StatusBar style="auto" />
    </>
  );
}
