import { Stack, router, useLocalSearchParams } from "expo-router";
import { useHeaderHeight } from "expo-router/react-navigation";
import { Check } from "lucide-react-native";
import { useRef, useState } from "react";
import { KeyboardAvoidingView, Pressable, ScrollView, StyleSheet, TextInput, View } from "react-native";

import { Button, Text } from "@/components/ui";
import { Chip } from "@/components/work";
import { useRepos } from "@/lib/code";
import { useSignedIn } from "@/lib/session";
import { useLabels, useOpenWorkItem } from "@/lib/work";
import { radius, space, useColors } from "@/theme";

/**
 * A new work item: a title, what it is about, its labels, and the
 * repositories where it is meant to land (none is fine: it can be linked
 * later). Opened from a repository's Work, that repository is its origin.
 * Made for the on-screen keyboard: the title's return goes on to the
 * description, and Create stays in the header above the keyboard.
 */
export default function NewWorkItem() {
  const params = useLocalSearchParams<{ workspace?: string; repo?: string }>();
  const { workspace: current } = useSignedIn();
  const workspace = params.workspace ?? current?.slug ?? "";
  const origin = params.repo ? `${workspace}/${params.repo}` : undefined;
  const colors = useColors();
  const headerHeight = useHeaderHeight();
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [labels, setLabels] = useState<string[]>([]);
  const [targets, setTargets] = useState<string[]>([]);
  const bodyField = useRef<TextInput>(null);
  const known = useLabels(workspace);
  const repos = useRepos("");
  const open = useOpenWorkItem(workspace);
  const ready = title.trim().length > 0 && !open.isPending;

  const toggle = (list: string[], value: string) => (list.includes(value) ? list.filter((one) => one !== value) : [...list, value]);
  const create = () => {
    if (!ready) return;
    open.mutate(
      { title: title.trim(), body: body.trim(), labels, targets, ...(origin ? { repo: origin } : {}) },
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
              Filed from {params.repo}, in {workspace}
            </Text>
          ) : (
            <Text size="small" tone="muted">
              In {workspace}
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
            {(repos.data ?? []).map((repo) => {
              const path = `${repo.namespace}/${repo.name}`;
              const on = targets.includes(path);
              return (
                <Chip
                  key={repo.id}
                  label={repo.name}
                  tone={on ? "accent" : "neutral"}
                  leading={on ? <Check size={12} color={colors.accent} /> : null}
                  onPress={() => setTargets(toggle(targets, path))}
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
