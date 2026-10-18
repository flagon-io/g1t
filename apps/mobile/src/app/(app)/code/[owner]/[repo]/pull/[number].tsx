import { Stack, router, useLocalSearchParams } from "expo-router";
import * as WebBrowser from "expo-web-browser";
import { Check, ExternalLink, MessageSquareWarning } from "lucide-react-native";
import { useState } from "react";
import { View } from "react-native";

import { Body, Checks, Diff, StateBadge, Timeline } from "@/components/code";
import { Segments } from "@/components/segments";
import { Button, ErrorView, Field, Loading, Row, Screen, Text } from "@/components/ui";
import { ItemIcon, stateLabel } from "@/components/work";
import { usePull, usePullChanges, useReview } from "@/lib/code";
import { siteUrl } from "@/lib/server";
import { useSignedIn } from "@/lib/session";
import { ago } from "@/lib/time";
import { space } from "@/theme";

/**
 * A pull request: what it is for, its checks, the conversation, and what
 * it changes; approve it or ask for changes from here. Merging stays on
 * the site for now, where its rules and the merge queue are shown.
 */
export default function PullRequest() {
  const params = useLocalSearchParams<{ owner: string; repo: string; number: string }>();
  const number = Number(params.number);
  const { server } = useSignedIn();
  const [tab, setTab] = useState<"conversation" | "files">("conversation");
  const pull = usePull(params.owner, params.repo, number);
  const changes = usePullChanges(params.owner, params.repo, number, tab === "files");
  const review = useReview(params.owner, params.repo, number);
  const [note, setNote] = useState("");

  const open = () => WebBrowser.openBrowserAsync(siteUrl(server, `/${params.owner}/${params.repo}/pull/${number}`));

  if (pull.isPending) {
    return (
      <Screen>
        <Stack.Screen options={{ title: `#${number}` }} />
        <Loading />
      </Screen>
    );
  }
  if (pull.error) {
    return (
      <Screen>
        <Stack.Screen options={{ title: `#${number}` }} />
        <ErrorView error={pull.error} retry={() => pull.refetch()} />
      </Screen>
    );
  }

  const { pull: pr, item, comments } = pull.data;
  const by = pr.author.display_username ?? pr.author.username;
  const reviewable = pr.status === "open";
  const refs = { repo: `${params.owner}/${params.repo}` };

  return (
    <Screen scroll>
      <Stack.Screen options={{ title: `#${number}` }} />
      <View style={{ gap: space.sm }}>
        <Text size="heading">{pr.title}</Text>
        <View style={{ flexDirection: "row", gap: space.sm, alignItems: "center", flexWrap: "wrap" }}>
          <StateBadge pull={pr} />
          <Checks status={pr.check_status} />
          <Text size="small" tone="muted">
            {by}
            {pr.agent ? ` with ${pr.agent}` : ""} · {pr.branch ?? "a fork"} → {pr.base} · {ago(pr.updated_at)}
          </Text>
        </View>
      </View>

      {item ? (
        <View style={{ marginHorizontal: -space.lg }}>
          <Row
            leading={<ItemIcon item={item} />}
            title={item.title}
            subtitle={`For work item #${item.number} · ${stateLabel(item)}`}
            onPress={() => router.push({ pathname: "/work/[number]", params: { number: String(item.number), workspace: item.workspace } })}
          />
        </View>
      ) : null}

      <Segments
        value={tab}
        onChange={setTab}
        options={[
          { value: "conversation", label: "Conversation" },
          { value: "files", label: `Files · ${pr.files.length}` },
        ]}
      />

      {tab === "conversation" ? (
        <>
          <Body text={pr.body} refs={refs} />
          <Timeline comments={comments} refs={refs} />
          {reviewable ? (
            <View style={{ gap: space.md }}>
              <Field label="Review" placeholder="Say what you think (optional to approve)" value={note} onChangeText={setNote} multiline />
              <View style={{ flexDirection: "row", gap: space.sm }}>
                <View style={{ flex: 1 }}>
                  <Button
                    title="Approve"
                    icon={Check}
                    busy={review.isPending && review.variables?.verdict === "approve"}
                    disabled={review.isPending}
                    onPress={() => review.mutate({ verdict: "approve", body: note.trim() }, { onSuccess: () => setNote("") })}
                  />
                </View>
                <View style={{ flex: 1 }}>
                  <Button
                    title="Request changes"
                    variant="secondary"
                    icon={MessageSquareWarning}
                    busy={review.isPending && review.variables?.verdict === "request_changes"}
                    disabled={review.isPending || !note.trim()}
                    onPress={() => review.mutate({ verdict: "request_changes", body: note.trim() }, { onSuccess: () => setNote("") })}
                  />
                </View>
              </View>
              {review.error ? <Text tone="danger">{review.error.message}</Text> : null}
            </View>
          ) : null}
        </>
      ) : changes.isPending ? (
        <Loading />
      ) : changes.error ? (
        <ErrorView error={changes.error} retry={() => changes.refetch()} />
      ) : (
        <Diff changes={changes.data} />
      )}

      <Button title="Open on g1t" variant="secondary" icon={ExternalLink} onPress={open} />
    </Screen>
  );
}
