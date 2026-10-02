import { FileDiff as FileIcon, FileMinus, FilePlus, MessageSquarePlus } from "lucide-react";
import { useState } from "react";
import { Form } from "react-router";

import type { Comment, Comparison, DiffLine, FileDiff } from "@g1t/contracts";

import { Markdown } from "./markdown";
import { Avatar, Button, EmptyState, Textarea, TimeAgo } from "./ui";

const ROW_STYLES: Record<DiffLine["kind"], string> = {
  context: "",
  add: "bg-accent/10",
  delete: "bg-danger/10",
};

const MARKERS: Record<DiffLine["kind"], string> = {
  context: " ",
  add: "+",
  delete: "-",
};

/** Comments on lines of the change, and whether the viewer may add one. */
export type LineReview = { comments: Comment[]; canComment: boolean };

/** `+12 −3` with a five-block bar, like the summary on a pull request. */
function Stat({
  additions,
  deletions,
}: {
  additions: number;
  deletions: number;
}) {
  const total = additions + deletions;
  const green = total === 0 ? 0 : Math.round((additions / total) * 5);
  return (
    <span className="flex shrink-0 items-center gap-2 font-mono text-xs">
      <span className="text-accent">+{additions}</span>
      <span className="text-danger">−{deletions}</span>
      <span className="flex gap-px" aria-hidden="true">
        {Array.from({ length: 5 }, (_, i) => (
          <span
            key={i}
            className={`size-2 rounded-xs ${
              total === 0 ? "bg-line" : i < green ? "bg-accent" : "bg-danger"
            }`}
          />
        ))}
      </span>
    </span>
  );
}

/** One comment made on a line, shown under that line. */
function LineComment({ comment }: { comment: Comment }) {
  return (
    <div className="rounded-lg border border-line bg-bg font-sans">
      <p className="flex items-center gap-2 border-b border-line px-3 py-1.5 text-xs text-muted">
        <Avatar name={comment.author.username} size={16} />
        <span className="font-medium text-fg">{comment.author.username}</span>
        <TimeAgo at={comment.createdAt} />
      </p>
      <div className="px-3 py-2 text-sm">
        <Markdown source={comment.body} />
      </div>
    </div>
  );
}

function File({ file, review }: { file: FileDiff; review?: LineReview }) {
  const Icon =
    file.status === "added"
      ? FilePlus
      : file.status === "deleted"
        ? FileMinus
        : FileIcon;
  const comments = review?.comments.filter((comment) => comment.path === file.path) ?? [];
  const shown = new Set(
    file.hunks.flatMap((hunk) => hunk.lines.map((line) => line.new)),
  );
  // Made against an earlier version of the change, on a line no longer in it.
  const outdated = comments.filter(
    (comment) => comment.line == null || !shown.has(comment.line),
  );
  return (
    <section
      id={`file-${file.path}`}
      className="scroll-mt-20 overflow-hidden rounded-xl border border-line"
    >
      <header className="flex items-center gap-3 border-b border-line bg-surface px-4 py-2.5">
        <Icon
          size={15}
          className={
            file.status === "added"
              ? "text-accent"
              : file.status === "deleted"
                ? "text-danger"
                : "text-faint"
          }
        />
        <span className="min-w-0 grow truncate font-mono text-[0.8125rem]">
          {file.path}
        </span>
        <Stat additions={file.additions} deletions={file.deletions} />
      </header>
      {outdated.length > 0 && (
        <div className="space-y-2 border-b border-line bg-surface/50 p-3">
          <p className="text-xs text-faint">On lines that have since changed</p>
          {outdated.map((comment) => (
            <LineComment key={comment.id} comment={comment} />
          ))}
        </div>
      )}
      {file.binary ? (
        <p className="px-4 py-6 text-sm text-muted">
          Binary or large file; its contents are not shown.
        </p>
      ) : file.hunks.length === 0 ? (
        <p className="px-4 py-6 text-sm text-muted">No line changes.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse font-mono text-xs leading-5">
            <tbody>
              {file.hunks.map((hunk, index) => (
                <HunkRows
                  key={index}
                  path={file.path}
                  lines={hunk.lines}
                  first={index === 0}
                  comments={comments}
                  canComment={review?.canComment ?? false}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function HunkRows({
  path,
  lines,
  first,
  comments,
  canComment,
}: {
  path: string;
  lines: DiffLine[];
  first: boolean;
  comments: Comment[];
  canComment: boolean;
}) {
  // The line whose comment box is open, if any.
  const [writing, setWriting] = useState<number | null>(null);
  return (
    <>
      {!first && (
        <tr aria-hidden="true">
          <td
            colSpan={4}
            className="border-y border-line bg-surface py-1 text-center text-faint"
          >
            ⋯
          </td>
        </tr>
      )}
      {lines.map((line, index) => {
        const here = comments.filter(
          (comment) => line.new != null && comment.line === line.new,
        );
        const open = line.new != null && writing === line.new;
        return (
          <Rows key={index}>
            <tr className={`group ${ROW_STYLES[line.kind]}`}>
              <td className="w-10 px-2 text-right text-faint select-none">{line.old}</td>
              <td className="relative w-10 px-2 text-right text-faint select-none">
                {line.new}
                {/* Lines that exist after the change can be commented on. */}
                {canComment && line.new != null && (
                  <button
                    type="button"
                    aria-label={`Comment on line ${line.new}`}
                    onClick={() => setWriting(open ? null : line.new)}
                    className="absolute top-0 -right-2.5 z-10 hidden size-5 items-center justify-center rounded bg-accent text-bg group-hover:flex focus-visible:flex"
                  >
                    <MessageSquarePlus size={12} />
                  </button>
                )}
              </td>
              <td
                className={`w-5 text-center select-none ${
                  line.kind === "add"
                    ? "text-accent"
                    : line.kind === "delete"
                      ? "text-danger"
                      : "text-faint"
                }`}
              >
                {MARKERS[line.kind]}
              </td>
              <td className="pr-4 whitespace-pre">{line.text}</td>
            </tr>
            {(here.length > 0 || open) && (
              <tr>
                <td colSpan={4} className="border-y border-line bg-surface p-3">
                  <div className="max-w-2xl space-y-2">
                    {here.map((comment) => (
                      <LineComment key={comment.id} comment={comment} />
                    ))}
                    {open && (
                      <Form
                        method="post"
                        className="space-y-2 font-sans"
                        onSubmit={() => setWriting(null)}
                      >
                        <input type="hidden" name="action" value="comment" />
                        <input type="hidden" name="path" value={path} />
                        <input type="hidden" name="line" value={line.new ?? ""} />
                        <Textarea
                          name="body"
                          rows={3}
                          required
                          autoFocus
                          placeholder={`Comment on line ${line.new}`}
                        />
                        <div className="flex gap-2">
                          <Button type="submit">Comment</Button>
                          <Button variant="quiet" type="button" onClick={() => setWriting(null)}>
                            Cancel
                          </Button>
                        </div>
                      </Form>
                    )}
                  </div>
                </td>
              </tr>
            )}
          </Rows>
        );
      })}
    </>
  );
}

/** Groups a line's rows without adding an element to the table. */
function Rows({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}

export function DiffView({
  comparison,
  review,
}: {
  comparison: Comparison;
  review?: LineReview;
}) {
  const { files, truncated } = comparison;
  if (files.length === 0) {
    return (
      <EmptyState title="No changes yet">
        Nothing has been pushed to this pull request yet, or it matches the
        branch it would merge into.
      </EmptyState>
    );
  }
  const additions = files.reduce((sum, file) => sum + file.additions, 0);
  const deletions = files.reduce((sum, file) => sum + file.deletions, 0);
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 text-sm text-muted">
        <span>
          <span className="font-medium text-fg">{files.length}</span>{" "}
          {files.length === 1 ? "file" : "files"} changed
        </span>
        <Stat additions={additions} deletions={deletions} />
        {review?.canComment && (
          <span className="ml-auto text-xs text-faint">
            Hover a line and press the button beside its number to comment on it.
          </span>
        )}
      </div>
      {files.length > 1 && (
        <ul className="rounded-xl border border-line bg-surface p-2 text-sm">
          {files.map((file) => (
            <li key={file.path}>
              <a
                href={`#file-${file.path}`}
                className="flex items-center gap-3 rounded-md px-2 py-1 hover:bg-raised"
              >
                <span className="min-w-0 grow truncate font-mono text-[0.8125rem]">
                  {file.path}
                </span>
                <Stat additions={file.additions} deletions={file.deletions} />
              </a>
            </li>
          ))}
        </ul>
      )}
      {files.map((file) => (
        <File key={file.path} file={file} review={review} />
      ))}
      {truncated && (
        <p className="text-center text-sm text-muted">
          This change is too large to show in full.
        </p>
      )}
    </div>
  );
}
