import { CircleCheck, CircleX, GitMerge, GitPullRequest, GitPullRequestClosed, GitPullRequestDraft, Loader } from "lucide-react-native";
import { ScrollView, StyleSheet, View } from "react-native";

import { Markdown } from "@/components/chat/markdown";
import { Badge, Text } from "@/components/ui";
import type { ApiChanges, ApiComment, ApiPull, CheckStatus } from "@/lib/code";
import type { RefContext } from "@/lib/links";
import { ago } from "@/lib/time";
import { fonts, radius, space, useColors } from "@/theme";

/** A pull request's state, as an icon in its colour. */
export function PullIcon({ pull }: { pull: Pick<ApiPull, "status"> }) {
  const colors = useColors();
  if (pull.status === "merged") return <GitMerge size={20} color={colors.merged} />;
  if (pull.status === "closed") return <GitPullRequestClosed size={20} color={colors.danger} />;
  if (pull.status === "draft") return <GitPullRequestDraft size={20} color={colors.muted} />;
  return <GitPullRequest size={20} color={colors.success} />;
}

export function Checks({ status }: { status: CheckStatus }) {
  const colors = useColors();
  if (status === "passed") return <CircleCheck size={16} color={colors.success} accessibilityLabel="Checks passed" />;
  if (status === "failed" || status === "errored") return <CircleX size={16} color={colors.danger} accessibilityLabel="Checks failed" />;
  if (status === "queued" || status === "running") return <Loader size={16} color={colors.warn} accessibilityLabel="Checks running" />;
  return null;
}

export function StateBadge({ pull }: { pull: Pick<ApiPull, "status"> }) {
  const tone = pull.status === "merged" ? "merged" : pull.status === "closed" ? "danger" : pull.status === "open" ? "success" : "neutral";
  return <Badge label={pull.status[0].toUpperCase() + pull.status.slice(1)} tone={tone} />;
}

/** A description in Markdown; `#123` in it is read in `refs`. */
export function Body({ text, refs }: { text: string | null; refs: RefContext }) {
  const colors = useColors();
  if (!text?.trim()) {
    return (
      <Text tone="faint" style={{ fontStyle: "italic" }}>
        No description.
      </Text>
    );
  }
  return (
    <View style={[styles.box, { borderColor: colors.line, backgroundColor: colors.surface }]}>
      <Markdown text={text} refs={refs} />
    </View>
  );
}

/** The conversation under a work item or pull request: comments, reviews and what happened. */
export function Timeline({ comments, refs }: { comments: ApiComment[]; refs: RefContext }) {
  const colors = useColors();
  if (comments.length === 0) return null;
  return (
    <View style={{ gap: space.md }}>
      {comments.map((comment) =>
        comment.kind === "event" ? (
          <Text key={comment.id} size="small" tone="muted">
            {comment.author.display_username ?? comment.author.username} {comment.body} · {ago(comment.created_at)}
          </Text>
        ) : (
          <View key={comment.id} style={[styles.box, { borderColor: colors.line, backgroundColor: colors.surface, gap: space.xs }]}>
            <View style={{ flexDirection: "row", gap: space.sm, alignItems: "center" }}>
              <Text style={{ fontWeight: "600" }}>{comment.author.display_username ?? comment.author.username}</Text>
              {comment.author.kind === "agent" ? <Badge label="Agent" tone="accent" /> : null}
              {comment.verdict ? <Badge label={comment.verdict.replace(/_/g, " ")} tone={comment.verdict === "approve" ? "success" : "warn"} /> : null}
              <Text size="small" tone="faint">
                {ago(comment.created_at)}
              </Text>
            </View>
            {comment.path ? (
              <Text size="mono" tone="muted">
                {comment.path}
                {comment.line ? `:${comment.line}` : ""}
              </Text>
            ) : null}
            <Markdown text={comment.body} refs={refs} />
          </View>
        ),
      )}
    </View>
  );
}

/** What a pull request changes, file by file, as unified hunks. */
export function Diff({ changes }: { changes: ApiChanges }) {
  const colors = useColors();
  return (
    <View style={{ gap: space.lg }}>
      {changes.files.map((file) => (
        <View key={file.path} style={[styles.file, { borderColor: colors.line }]}>
          <View style={[styles.fileHeader, { backgroundColor: colors.raised, borderBottomColor: colors.line }]}>
            <Text size="mono" style={{ flex: 1 }} numberOfLines={1}>
              {file.path}
            </Text>
            {!file.omitted && (
              <>
                <Text size="mono" tone="success">
                  +{file.additions}
                </Text>
                <Text size="mono" tone="danger">
                  −{file.deletions}
                </Text>
              </>
            )}
          </View>
          {file.omitted ? (
            <Text tone="muted" size="small" style={{ padding: space.md }}>
              Not shown here: this change is too large. Open it on the web to read this file.
            </Text>
          ) : file.binary ? (
            <Text tone="muted" size="small" style={{ padding: space.md }}>
              A binary file.
            </Text>
          ) : (
            <ScrollView horizontal>
              <View>
                {(file.hunks ?? []).flatMap((hunk, index) =>
                  hunk.lines.map((line, at) => (
                    <Text
                      key={`${index}-${at}`}
                      style={{
                        fontFamily: fonts.mono,
                        fontSize: 12,
                        lineHeight: 18,
                        paddingHorizontal: space.sm,
                        color: line.kind === "add" ? colors.success : line.kind === "delete" ? colors.danger : colors.fgSoft,
                        backgroundColor: line.kind === "add" ? colors.successLow : "transparent",
                      }}
                    >
                      {line.kind === "add" ? "+ " : line.kind === "delete" ? "− " : "  "}
                      {line.text}
                    </Text>
                  )),
                )}
              </View>
            </ScrollView>
          )}
        </View>
      ))}
      {changes.truncated ? (
        <Text tone="muted" size="small">
          Too much changed to show here. Open it on g1t for the rest.
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  box: { borderWidth: 1, borderRadius: radius.md, padding: space.md },
  file: { borderWidth: 1, borderRadius: radius.md, overflow: "hidden" },
  fileHeader: { flexDirection: "row", gap: space.sm, padding: space.sm, borderBottomWidth: StyleSheet.hairlineWidth },
});
