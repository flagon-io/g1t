import { Stack, router, useLocalSearchParams } from "expo-router";
import * as WebBrowser from "expo-web-browser";
import { ExternalLink, Send } from "lucide-react-native";
import { useState } from "react";
import { View } from "react-native";

import { Body, IssueIcon, PullIcon, Timeline } from "@/components/code";
import { Button, ErrorView, Field, Loading, Row, Screen, SectionHeader, Text } from "@/components/ui";
import { useComment, useIssue } from "@/lib/code";
import { siteUrl } from "@/lib/server";
import { useSignedIn } from "@/lib/session";
import { ago } from "@/lib/time";
import { space } from "@/theme";

/** An issue: what it asks for, the pull requests made for it, and its conversation. */
export default function Issue() {
  const params = useLocalSearchParams<{ owner: string; repo: string; number: string }>();
  const number = Number(params.number);
  const { server } = useSignedIn();
  const issue = useIssue(params.owner, params.repo, number);
  const comment = useComment(params.owner, params.repo, number);
  const [draft, setDraft] = useState("");

  if (issue.isPending || issue.error) {
    return (
      <Screen>
        <Stack.Screen options={{ title: `#${number}` }} />
        {issue.error ? <ErrorView error={issue.error} retry={() => issue.refetch()} /> : <Loading />}
      </Screen>
    );
  }

  const { issue: item, pulls, comments } = issue.data;
  const by = item.author.display_username ?? item.author.username;

  return (
    <Screen scroll>
      <Stack.Screen options={{ title: `#${number}` }} />
      <View style={{ gap: space.sm }}>
        <Text size="heading">{item.title}</Text>
        <View style={{ flexDirection: "row", gap: space.sm, alignItems: "center" }}>
          <IssueIcon issue={item} />
          <Text size="small" tone="muted">
            {item.state === "open" ? "Open" : "Closed"} · {by} · {ago(item.created_at)}
            {item.labels.length ? ` · ${item.labels.join(", ")}` : ""}
          </Text>
        </View>
      </View>
      <Body text={item.body} />
      {pulls.length ? (
        <View style={{ marginHorizontal: -space.lg }}>
          <SectionHeader title="Pull requests" />
          {pulls.map((pull) => (
            <Row
              key={pull.id}
              leading={<PullIcon pull={pull} />}
              title={pull.title}
              subtitle={`#${pull.number} · ${pull.status}`}
              onPress={() =>
                router.push({ pathname: "/code/[owner]/[repo]/pull/[number]", params: { owner: params.owner, repo: params.repo, number: String(pull.number) } })
              }
            />
          ))}
        </View>
      ) : null}
      <Timeline comments={comments} />
      <View style={{ gap: space.sm }}>
        <Field label="Comment" placeholder="Add to the conversation" value={draft} onChangeText={setDraft} multiline />
        <Button
          title="Comment"
          icon={Send}
          busy={comment.isPending}
          disabled={!draft.trim()}
          onPress={() => comment.mutate(draft.trim(), { onSuccess: () => setDraft("") })}
        />
        {comment.error ? <Text tone="danger">{comment.error.message}</Text> : null}
      </View>
      <Button
        title="Open on g1t"
        variant="secondary"
        icon={ExternalLink}
        onPress={() => WebBrowser.openBrowserAsync(siteUrl(server, `/${params.owner}/${params.repo}/issues/${number}`))}
      />
    </Screen>
  );
}
