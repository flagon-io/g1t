import { Stack, useLocalSearchParams } from "expo-router";

import { Conversation } from "@/components/chat/conversation";
import { Screen } from "@/components/ui";
import { useChatSidebar } from "@/lib/chat";

/** A thread: the message it is under, its replies, and a box to reply in. */
export default function ThreadScreen() {
  const { channel, root } = useLocalSearchParams<{ channel: string; root: string }>();
  const sidebar = useChatSidebar();
  const entry = sidebar.data?.entries.find((one) => one.channel.id === channel);
  const where = entry ? (entry.channel.kind === "dm" ? entry.title : `#${entry.channel.name}`) : "";
  return (
    <Screen>
      <Stack.Screen options={{ title: where ? `Thread in ${where}` : "Thread" }} />
      <Conversation channelId={channel} thread={root} title={where} />
    </Screen>
  );
}
