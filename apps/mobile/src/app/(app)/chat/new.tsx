import { useQuery } from "@tanstack/react-query";
import { Stack, router } from "expo-router";
import { Check, Hash, Search } from "lucide-react-native";
import { useMemo, useState } from "react";
import { FlatList, Pressable, StyleSheet, TextInput, View } from "react-native";

import { PromptSheet } from "@/components/chat/sheet";
import { Avatar, Button, Loading, Row, Screen, SectionHeader, Text } from "@/components/ui";
import { useStartConversation } from "@/lib/chat";
import { useSignedIn } from "@/lib/session";
import { radius, space, useColors } from "@/theme";

type Person = { key: string; name: string; handle: string; avatar: string | null };

/**
 * A new conversation: pick people for a direct message (one, or a
 * group), or make a channel. People come from the workspace's members
 * (`GET /workspaces/<ws>/members`).
 */
export default function NewConversation() {
  const { client, workspace, me, server } = useSignedIn();
  const slug = workspace?.slug ?? "";
  const colors = useColors();
  const start = useStartConversation();
  const [search, setSearch] = useState("");
  const [picked, setPicked] = useState<Person[]>([]);
  const [making, setMaking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const members = useQuery({
    queryKey: ["workspace", slug, "members"],
    queryFn: () =>
      client.api<{ username: string; display_username?: string; name?: string | null; avatar?: string | null }[]>(`/workspaces/${encodeURIComponent(slug)}/members`),
    enabled: !!slug,
  });

  const everyone = useMemo(() => {
    const people: Person[] = (members.data ?? [])
      .filter((member) => member.username.toLowerCase() !== me.username.toLowerCase())
      .map((member) => ({
        key: `user:${member.username.toLowerCase()}`,
        name: member.name || member.display_username || member.username,
        handle: member.display_username ?? member.username,
        avatar: member.avatar ?? null,
      }));
    const words = search.trim().toLowerCase();
    return people.filter((one) => !words || `${one.name} ${one.handle}`.toLowerCase().includes(words));
  }, [members.data, me.username, search]);

  const toggle = (person: Person) =>
    setPicked((now) => (now.some((one) => one.key === person.key) ? now.filter((one) => one.key !== person.key) : [...now, person]));

  const open = () => {
    setError(null);
    start.dm.mutate(
      picked.map((one) => one.key),
      {
        onSuccess: ({ channel }) => router.replace({ pathname: "/chat/[channel]", params: { channel: channel.id } }),
        onError: (failure) => setError(failure.message),
      },
    );
  };

  return (
    <Screen>
      <Stack.Screen options={{ title: "New message", presentation: "modal" }} />
      <View style={[styles.search, { backgroundColor: colors.raised }]}>
        <Search size={16} color={colors.faint} />
        <TextInput
          autoFocus
          value={search}
          onChangeText={setSearch}
          placeholder="Find a person"
          placeholderTextColor={colors.faint}
          style={{ flex: 1, color: colors.fg, fontSize: 15, paddingVertical: 8 }}
          autoCorrect={false}
          autoCapitalize="none"
        />
      </View>
      {picked.length ? (
        <Text size="small" tone="muted" style={{ paddingHorizontal: space.lg, paddingTop: space.sm }}>
          To {picked.map((one) => one.name).join(", ")}
        </Text>
      ) : null}
      {members.isPending ? (
        <Loading />
      ) : (
        <FlatList
          data={everyone}
          keyExtractor={(one) => one.key}
          keyboardShouldPersistTaps="handled"
          ListHeaderComponent={
            <>
              <Row leading={<Hash size={20} color={colors.accent} />} title="Make a channel" subtitle="A conversation for a team or a topic" onPress={() => setMaking(true)} />
              <SectionHeader title="People" />
            </>
          }
          renderItem={({ item }) => {
            const on = picked.some((one) => one.key === item.key);
            return (
              <Pressable onPress={() => toggle(item)} style={({ pressed }) => [styles.person, { backgroundColor: pressed ? colors.raised : "transparent" }]}>
                <Avatar name={item.name} uri={item.avatar ? `${server.site}/avatars/${item.avatar}` : null} size={36} />
                <View style={{ flex: 1 }}>
                  <Text style={{ fontWeight: "600" }} numberOfLines={1}>
                    {item.name}
                  </Text>
                  <Text size="small" tone="muted" numberOfLines={1}>
                    @{item.handle}
                  </Text>
                </View>
                <View style={[styles.check, { borderColor: on ? colors.accent : colors.lineStrong, backgroundColor: on ? colors.accent : "transparent" }]}>
                  {on ? <Check size={14} color={colors.onAccent} strokeWidth={3} /> : null}
                </View>
              </Pressable>
            );
          }}
        />
      )}
      {error ? (
        <Text tone="danger" style={{ paddingHorizontal: space.lg }}>
          {error}
        </Text>
      ) : null}
      {picked.length ? (
        <View style={{ padding: space.lg }}>
          <Button title={picked.length === 1 ? `Message ${picked[0].name}` : `Message ${picked.length}`} busy={start.dm.isPending} onPress={open} />
        </View>
      ) : null}
      <PromptSheet
        visible={making}
        title="Make a channel"
        label="Lowercase words joined by dashes, like design-reviews."
        placeholder="channel-name"
        confirm="Make it"
        onCancel={() => setMaking(false)}
        onDone={(name) => {
          setMaking(false);
          start.create.mutate(
            { name },
            {
              onSuccess: ({ channel }) => router.replace({ pathname: "/chat/[channel]", params: { channel: channel.id } }),
              onError: (failure) => setError(failure.message),
            },
          );
        }}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  search: { flexDirection: "row", alignItems: "center", gap: space.sm, marginHorizontal: space.lg, marginTop: space.md, paddingHorizontal: space.md, borderRadius: radius.md },
  person: { flexDirection: "row", alignItems: "center", gap: space.md, paddingHorizontal: space.lg, paddingVertical: 10 },
  check: { width: 22, height: 22, borderRadius: 11, borderWidth: 2, alignItems: "center", justifyContent: "center" },
});
