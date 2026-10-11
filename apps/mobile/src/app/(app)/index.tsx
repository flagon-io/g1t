import { Redirect } from "expo-router";

/** The app opens on Chat. */
export default function Index() {
  return <Redirect href="/chat" />;
}
