import { Stack, router, useLocalSearchParams } from "expo-router";
import { useHeaderHeight } from "expo-router/react-navigation";
import { Check } from "lucide-react-native";
import { useRef, useState } from "react";
import { KeyboardAvoidingView, Pressable, ScrollView, StyleSheet, TextInput, View } from "react-native";

import { Button, Text } from "@/components/ui";
import { Chip } from "@/components/work";
import { useWorkspaceRepos } from "@/lib/code";
import { originOf } from "@/lib/new-item";
import { useSignedIn } from "@/lib/session";
import { parseNumber } from "@/lib/sub-items";
import { useLabels, useOpenWorkItem } from "@/lib/work";
import { radius, space, useColors } from "@/theme";

/**
 * A new work item: a title, what it is about, its labels, and the
 * repositories where it is meant to land (none is fine: it can be linked
 * later): its own workspace's, whichever the app is in. Opened from a
 * repository (`repo`), that repository is its origin, and a target to
 * start with. Opened from a work item (`parent`), it is filed as one of
 * its sub-items.
 * Made for the on-screen keyboard: the title's return goes on to the
 * description, and Create stays in the header above the keyboard.
 */
export default function NewWorkItem() {
  const params = useLocalSearchParams<{ workspace?: string; repo?: string; parent?: string }>();
  const { workspace: current } = useSignedIn();
  const workspace = params.workspace ?? current?.slug ?? "";
  const origin = originOf(workspace, params.repo) ?? undefined;
  const parent = params.parent ? (parseNumber(params.parent) ?? undefined) : undefined;
  const colors = useColors();
  const headerHeight = useHeaderHeight();
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [labels, setLabels] = useState<string[]>([]);
  // Filed from a repository, it starts as a target too, as on the site; untick it to leave it the origin only.
  const [targets, setTargets] = useState<string[]>(origin ? [origin] : []);
  const bodyField = useRef<TextInput>(null);
  const known = useLabels(workspace);
  const repos = useWorkspaceRepos(workspace);
  const open = useOpenWorkItem(workspace);
  const ready = title.trim().length > 0 && !open.isPending;

  const toggle = (list: string[], value: string) => (list.includes(value) ? list.filter((one) => one !== value) : [...list, value]);
  const create = () => {
    if (!ready) return;
    open.mutate(
      { title: title.trim(), body: body.trim(), labels, targets, ...(origin ? { repo: origin } : {}), ...(parent ? { parent } : {}) },
      { onSuccess: (item) => router.replace({ pathname: "/work/[number]", params: { number: String(item.number), workspace: item.workspace } }) },
    );
  };

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <Stack.Screen
        options={{
          title: "New work item",
          headerRight: () => (
            <Pressable accessibilityRole="button" accessibilityLabel="Create" hitSlop={10} disabled={!ready} onPress={create}>
              <Text style={{ color: ready ? colors.accent : colors.faint, fontWeight: "700" }}>Create</Text>
            </Pressable>
          ),
        }}
      />
      <KeyboardAvoidingView style={{ flex: 1 }} behavior="padding" keyboardVerticalOffset={headerHeight}>
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled" keyboardDismissMode="interactive">
          {origin ? (
            <Text size="small" tone="muted">
              Filed from {origin}
              {parent ? ` · Sub-item of #${parent}` : ""}
            </Text>
          ) : (
            <Text size="small" tone="muted">
              In {workspace}
              {parent ? ` · Sub-item of #${parent}` : ""}
            </Text>
          )}
          <TextInput
            autoFocus
            value={title}
            onChangeText={setTitle}
            placeholder="Title"
            placeholderTextColor={colors.faint}
            returnKeyType="next"
            submitBehavior="submit"
            onSubmitEditing={() => bodyField.current?.focus()}
            style={[styles.title, { color: colors.fg, borderBottomColor: colors.line }]}
          />
          <TextInput
            ref={bodyField}
            value={body}
            onChangeText={setBody}
            placeholder="What is it about? Markdown works. Say what done means, under a “Definition of done” heading."
            placeholderTextColor={colors.faint}
            multiline
            textAlignVertical="top"
            style={[styles.body, { color: colors.fg, backgroundColor: colors.surface, borderColor: colors.lineStrong }]}
          />

          <Group title="Labels" empty={known.isPending ? "…" : "This workspace has no labels yet."}>
            {(known.data ?? []).map((label) => (
              <Chip
                key={label.name}
                label={label.name}
                tone={labels.includes(label.name) ? "accent" : "neutral"}
                leading={<View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: `#${label.color}` }} />}
                onPress={() => setLabels(toggle(labels, label.name))}
              />
            ))}
          </Group>

          <Group
            title="Where it lands"
            hint="The repositories the work is meant to land in. It closes once it has landed in each. Leave them out to pick later."
            empty={repos.isPending ? "…" : "No repositories you can see."}
          >
            {(repos.data ?? []).map((path) => {
              const on = targets.some((one) => one.toLowerCase() === path.toLowerCase());
              return (
                <Chip
                  key={path}
                  label={path.split("/")[1] ?? path}
                  tone={on ? "accent" : "neutral"}
                  leading={on ? <Check size={12} color={colors.accent} /> : null}
                  onPress={() => setTargets(on ? targets.filter((one) => one.toLowerCase() !== path.toLowerCase()) : [...targets, path])}
                />
              );
            })}
          </Group>

          {open.error ? <Text tone="danger">{open.error.message}</Text> : null}
          <Button title="Create" busy={open.isPending} disabled={!ready} onPress={create} />
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}

function Group({ title, hint, empty, children }: { title: string; hint?: string; empty: string; children: React.ReactNode[] }) {
  return (
    <View style={{ gap: space.sm }}>
      <Text size="small" tone="muted" style={{ fontWeight: "600" }}>
        {title}
      </Text>
      {hint ? (
        <Text size="small" tone="faint">
          {hint}
        </Text>
      ) : null}
      {children.length ? (
        <View style={styles.chips}>{children}</View>
      ) : (
        <Text size="small" tone="faint">
          {empty}
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  content: { padding: space.lg, gap: space.lg, paddingBottom: space.xxl },
  title: { fontSize: 20, fontWeight: "600", paddingVertical: space.sm, borderBottomWidth: StyleSheet.hairlineWidth },
  body: { minHeight: 160, borderWidth: 1, borderRadius: radius.md, padding: space.md, fontSize: 15, lineHeight: 21 },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
});
