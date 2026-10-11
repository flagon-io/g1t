import { Link, Stack } from "expo-router";
import { CircleHelp } from "lucide-react-native";

import { Empty, Screen, Text } from "@/components/ui";

export default function NotFound() {
  return (
    <Screen safe>
      <Stack.Screen options={{ headerShown: false }} />
      <Empty
        icon={CircleHelp}
        title="Nothing here"
        body="The app has no screen for this link."
        action={
          <Link href="/" replace>
            <Text tone="accent">Go to Chat</Text>
          </Link>
        }
      />
    </Screen>
  );
}
