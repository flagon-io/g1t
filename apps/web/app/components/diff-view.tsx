import { ChevronDown, ChevronRight, Columns2, FileDiff as FileIcon, FileMinus, FilePlus, Files, Folder, MessageSquarePlus, Rows3, Search } from "lucide-react";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Form, Link } from "react-router";

import type { Comment, Comparison, DiffLine, FileDiff } from "@g1t/contracts";

import { loadFile, peekFile } from "../lib/diff-files";
import {
  type Deferred,
  type FileHtml,
  type HighlightedComparison,
  type HighlightedFile,
  type HighlightedLine,
  LARGE_FILE_LINES,
  diffContent,
  htmlOfFile,
  linkedFile,
  withHtml,
} from "../lib/diff";
import { Markdown } from "./markdown";
import { MentionTextarea } from "./mention-textarea";
import { EmptyState, SubmitButton, TimeAgo } from "./ui";
import { Avatar } from "./ui/avatar";
import { Button } from "./ui/button";
import { Card } from "./ui/card";
import { Checkbox } from "./ui/checkbox";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "./ui/sheet";

const ROW_STYLES: Record<DiffLine["kind"], string> = {
  context: "",
  add: "bg-success/9",
  delete: "bg-danger/9",
};

const GUTTER_STYLES: Record<DiffLine["kind"], string> = {
  context: "text-faint",
  add: "bg-success/[0.14] text-success/70",
  delete: "bg-danger/[0.14] text-danger/70",
};

const MARKERS: Record<DiffLine["kind"], string> = {
  context: " ",
  add: "+",
  delete: "−",
};

/** Comments on lines of the change, and whether the viewer may add one. */
export type LineReview = { comments: Comment[]; canComment: boolean };

type Layout = "unified" | "split";

/** Reads a per-viewer preference; storage can be missing or refuse. */
function stored(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function store(key: string, value: string | null) {
  try {
    if (value == null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    // A private window: the preference lasts until the page is left.
  }
}

/** Whether the screen is phone-sized: a change is shown unified there, never split. */
function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const query = window.matchMedia("(max-width: 639px)");
    const update = () => setNarrow(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return narrow;
}

/** `+12 −3` with a five-block bar (the bar from `sm` up). */
export function Stat({ additions, deletions }: { additions: number; deletions: number }) {
  const total = additions + deletions;
  const green = total === 0 ? 0 : Math.round((additions / total) * 5);
  return (
    <span className="flex shrink-0 items-center gap-2 font-mono text-xs">
      <span className="text-success">+{additions}</span>
      <span className="text-danger">−{deletions}</span>
      <span className="hidden gap-px sm:flex" aria-hidden="true">
        {Array.from({ length: 5 }, (_, i) => (
          <span key={i} className={`size-2 rounded-xs ${total === 0 ? "bg-line" : i < green ? "bg-success" : "bg-danger"}`} />
        ))}
      </span>
    </span>
  );
}

function fileIcon(status: HighlightedFile["status"]) {
  return status === "added" ? FilePlus : status === "deleted" ? FileMinus : FileIcon;
}

function fileTone(status: HighlightedFile["status"]) {
  return status === "added" ? "text-success" : status === "deleted" ? "text-danger" : "text-faint";
}

/** One comment made on a line, shown under that line. */
function LineComment({ comment }: { comment: Comment }) {
  return (
    <Card tone="bg" radius="lg" className="font-sans">
      <p className="flex items-center gap-2 border-b border-line px-3 py-1.5 text-xs text-muted">
        <Avatar name={comment.author.username} size={16} />
        <span className="font-medium text-fg">{comment.author.username}</span>
        <TimeAgo at={comment.createdAt} />
      </p>
      <div className="px-3 py-2 text-sm">
        <Markdown source={comment.body} />
      </div>
    </Card>
  );
}

/** A line's text, highlighted when the server could. */
function Code({ line }: { line: HighlightedLine | null }) {
  if (!line) return null;
  if (line.html != null) {
    return <span dangerouslySetInnerHTML={{ __html: line.html || " " }} />;
  }
  return <>{line.text || " "}</>;
}

/** The comments on a line and, when open, the box to add one. */
function Thread({ path, line, comments, open, onClose }: { path: string; line: number; comments: Comment[]; open: boolean; onClose: () => void }) {
  // The box stays, saying it is posting, until the new comment shows above it.
  const count = useRef(comments.length);
  useEffect(() => {
    if (comments.length > count.current) onClose();
    count.current = comments.length;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only a new comment closes it
  }, [comments.length]);
  return (
    <div className="max-w-2xl space-y-2">
      {comments.map((comment) => (
        <LineComment key={comment.id} comment={comment} />
      ))}
      {open && (
        <Form method="post" className="space-y-2 font-sans">
          <input type="hidden" name="action" value="comment" />
          <input type="hidden" name="path" value={path} />
          <input type="hidden" name="line" value={line} />
          <MentionTextarea name="body" rows={3} required autoFocus placeholder={`Comment on line ${line}`} />
          <div className="flex gap-2">
            <SubmitButton match={{ action: "comment", path, line: String(line) }} pending="Commenting…">
              Comment
            </SubmitButton>
            <Button variant="outline" type="button" onClick={onClose}>
              Cancel
            </Button>
          </div>
        </Form>
      )}
    </div>
  );
}

function CommentButton({ line, onClick }: { line: number; onClick: (event: React.MouseEvent) => void }) {
  return (
    <Button
      type="button"
      aria-label={`Comment on line ${line}`}
      onClick={onClick}
      variant="accent"
      size="icon"
      className="absolute top-0 -right-2.5 z-10 hidden size-5 rounded group-hover:flex focus-visible:flex pointer-coarse:-right-1 pointer-coarse:flex pointer-coarse:size-7"
    >
      <MessageSquarePlus size={12} />
    </Button>
  );
}

type FileProps = {
  file: HighlightedFile;
  comments: Comment[];
  canComment: boolean;
};

function UnifiedRows({ file, comments, canComment }: FileProps) {
  const [writing, setWriting] = useState<number | null>(null);
  return (
    <table className="w-full border-collapse font-mono text-xs leading-5">
      <tbody>
        {file.hunks.map((hunk, h) => (
          <Fragment key={h}>
            {h > 0 && <HunkGap colSpan={4} />}
            {hunk.lines.map((line, index) => {
              const here = comments.filter((c) => line.new != null && c.line === line.new);
              const open = line.new != null && writing === line.new;
              return (
                <Fragment key={index}>
                  <tr className={`group ${ROW_STYLES[line.kind]}`}>
                    <td className={`w-9 px-1 text-right select-none sm:w-12 sm:px-2 ${GUTTER_STYLES[line.kind]}`}>{line.old}</td>
                    <td
                      // A tap on the number comments on the line: a touch screen has no hover for the button.
                      onClick={canComment && line.new != null ? () => setWriting(open ? null : line.new) : undefined}
                      className={`relative w-9 px-1 text-right select-none sm:w-12 sm:px-2 ${canComment && line.new != null ? "cursor-pointer" : ""} ${GUTTER_STYLES[line.kind]}`}
                    >
                      {line.new}
                      {canComment && line.new != null && (
                        <CommentButton
                          line={line.new}
                          onClick={(event) => {
                            event.stopPropagation();
                            setWriting(open ? null : line.new);
                          }}
                        />
                      )}
                    </td>
                    <td className={`w-4 text-center select-none sm:w-5 ${fileToneFor(line.kind)}`}>{MARKERS[line.kind]}</td>
                    <td className="pr-4 whitespace-pre">
                      <Code line={line} />
                    </td>
                  </tr>
                  {(here.length > 0 || open) && line.new != null && (
                    <tr>
                      <td colSpan={4} className="border-y border-line bg-surface p-3">
                        <Thread path={file.path} line={line.new} comments={here} open={open} onClose={() => setWriting(null)} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </Fragment>
        ))}
      </tbody>
    </table>
  );
}

function fileToneFor(kind: DiffLine["kind"]) {
  return kind === "add" ? "text-success" : kind === "delete" ? "text-danger" : "text-faint";
}

/** Lines side by side: a run of deletions beside the additions that replaced it. */
function pairs(lines: HighlightedLine[]): [HighlightedLine | null, HighlightedLine | null][] {
  const rows: [HighlightedLine | null, HighlightedLine | null][] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index]!;
    if (line.kind === "context") {
      rows.push([line, line]);
      index++;
      continue;
    }
    const removed: HighlightedLine[] = [];
    const added: HighlightedLine[] = [];
    while (index < lines.length && lines[index]!.kind === "delete") removed.push(lines[index++]!);
    while (index < lines.length && lines[index]!.kind === "add") added.push(lines[index++]!);
    for (let n = 0; n < Math.max(removed.length, added.length); n++) {
      rows.push([removed[n] ?? null, added[n] ?? null]);
    }
  }
  return rows;
}

function SplitRows({ file, comments, canComment }: FileProps) {
  const [writing, setWriting] = useState<number | null>(null);
  const side = (line: HighlightedLine | null, which: "old" | "new") => {
    const kind = line ? (line.kind === "context" ? "context" : line.kind) : null;
    const empty = "bg-surface/60";
    return (
      <>
        <td
          className={`relative w-12 px-2 text-right align-top select-none ${kind ? GUTTER_STYLES[kind] : empty} ${
            which === "new" ? "border-l border-line" : ""
          }`}
        >
          {line?.[which]}
          {which === "new" && canComment && line?.new != null && (
            <CommentButton line={line.new} onClick={() => setWriting(writing === line.new ? null : line.new)} />
          )}
        </td>
        <td className={`pr-3 pl-2 align-top break-all whitespace-pre-wrap ${kind ? ROW_STYLES[kind] : empty}`}>
          <Code line={line} />
        </td>
      </>
    );
  };
  return (
    <table className="w-full table-fixed border-collapse font-mono text-xs leading-5">
      <colgroup>
        <col className="w-12" />
        <col />
        <col className="w-12" />
        <col />
      </colgroup>
      <tbody>
        {file.hunks.map((hunk, h) => (
          <Fragment key={h}>
            {h > 0 && <HunkGap colSpan={4} />}
            {pairs(hunk.lines).map(([before, after], index) => {
              const line = after?.new ?? null;
              const here = comments.filter((c) => line != null && c.line === line);
              const open = line != null && writing === line;
              return (
                <Fragment key={index}>
                  <tr className="group">
                    {side(before && before.kind !== "add" ? before : null, "old")}
                    {side(after && after.kind !== "delete" ? after : null, "new")}
                  </tr>
                  {(here.length > 0 || open) && line != null && (
                    <tr>
                      <td colSpan={4} className="border-y border-line bg-surface p-3">
                        <Thread path={file.path} line={line} comments={here} open={open} onClose={() => setWriting(null)} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </Fragment>
        ))}
      </tbody>
    </table>
  );
}

function HunkGap({ colSpan }: { colSpan: number }) {
  return (
    <tr aria-hidden="true">
      <td colSpan={colSpan} className="border-y border-line bg-surface py-0.5 text-center text-faint">
        ⋯
      </td>
    </tr>
  );
}

/** How tall a line of a diff is (`leading-5`): a file not loaded yet holds its place at its height. */
const LINE_PX = 20;

/** Where a file sent without its lines shows them: a note and "Load diff", or room for them while they load. */
function NotLoaded({
  deferred,
  failed,
  waiting,
  onLoad,
}: {
  deferred: Deferred;
  failed: boolean;
  /** A large file nobody has asked for yet. */
  waiting: boolean;
  onLoad: () => void;
}) {
  if (failed || waiting) {
    return (
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-4 text-sm text-muted">
        <span className="grow">
          {failed
            ? "This file's diff could not be loaded."
            : `A large diff (${(deferred.lines ?? 0).toLocaleString("en-US")} lines) is not shown until you ask for it.`}
        </span>
        <Button type="button" variant="outline" size="sm" onClick={onLoad}>
          {failed ? "Try again" : "Load diff"}
        </Button>
      </div>
    );
  }
  return (
    <div aria-busy="true" className="px-4 py-3 text-xs text-faint" style={{ height: Math.max(3, Math.min(deferred.lines ?? 3, LARGE_FILE_LINES)) * LINE_PX }}>
      Loading the diff…
    </div>
  );
}

/** How many files waiting after one are fetched with it, and about how many lines that may come to. */
const AHEAD_FILES = 7;
const AHEAD_LINES = 3_000;

/** For each file sent without its lines, the ones after it to fetch in the same request. */
function filesAhead(files: HighlightedFile[]): Map<string, string[]> {
  const waiting = files.filter((file) => file.deferred && !file.deferred.large);
  const ahead = new Map<string, string[]>();
  waiting.forEach((file, index) => {
    const next: string[] = [];
    let lines = file.deferred!.lines ?? 0;
    for (const later of waiting.slice(index + 1, index + 1 + AHEAD_FILES)) {
      // One the comparison left out is counted as a small file.
      lines += later.deferred!.lines ?? 100;
      if (lines > AHEAD_LINES) break;
      next.push(later.path);
    }
    ahead.set(file.path, next);
  });
  return ahead;
}

function FileSection({
  file: given,
  source,
  wanted,
  ahead,
  review,
  layout,
  collapsed,
  viewed,
  onToggle,
  onViewed,
  fileBase,
}: {
  file: HighlightedFile;
  /** Where a file sent without its lines fetches them (lib/diff-files.ts). */
  source: string | null;
  /** Linked to from the address: its lines load at once, however large. */
  wanted: boolean;
  /** The files waiting after it, fetched with it. */
  ahead?: string[];
  review?: LineReview;
  layout: Layout;
  collapsed: boolean;
  viewed: boolean;
  onToggle: () => void;
  onViewed: (viewed: boolean) => void;
  /** Where the file can be read as of the change, e.g. `/acme/web/blob/<hash>`. */
  fileBase?: string;
}) {
  const section = useRef<HTMLElement>(null);
  // Sent without its lines (lib/diff.ts firstScreens): fetched as it comes
  // near the screen, at once when it has comments or is linked to, and a
  // large one when asked for. What was fetched stays through a refresh.
  const deferred = given.deferred ?? null;
  const fetchKey = deferred && source ? `${source}\n${given.path}` : null;
  const [fetched, setFetched] = useState<{ key: string; file: FileDiff | null } | null>(() => {
    const hit = fetchKey ? peekFile(source!, given.path) : undefined;
    return hit === undefined ? null : { key: fetchKey!, file: hit };
  });
  const [failed, setFailed] = useState(false);
  const [asked, setAsked] = useState(false);
  const got = fetched && fetched.key === fetchKey ? fetched : null;
  const ready = !deferred || got != null;
  const file: HighlightedFile = got?.file ?? given;
  const comments = review?.comments.filter((comment) => comment.path === file.path) ?? [];
  const eager = wanted || asked || comments.length > 0;
  useEffect(() => {
    if (!fetchKey || got || collapsed || failed || !source) return;
    if (deferred?.large && !eager) return;
    const path = given.path;
    const load = () =>
      loadFile(source, path, { also: ahead }).then(
        (found) => setFetched({ key: fetchKey, file: found }),
        () => setFailed(true),
      );
    if (eager) {
      void load();
      return;
    }
    const element = section.current;
    if (!element) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry?.isIntersecting) return;
        observer.disconnect();
        void load();
      },
      // Further ahead than the colours: a file's lines are a round trip away.
      { rootMargin: "2000px 0px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
    // The file's identity is its key; a refresh's new `deferred` object changes nothing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetchKey, got != null, collapsed, failed, eager, deferred?.large]);
  // Linked to: once its lines are in, it is kept at the top while the files
  // above it load and change its place, until the reader scrolls or a
  // moment has passed.
  const linkedReady = wanted && (!deferred || got != null);
  useEffect(() => {
    const element = section.current;
    if (!linkedReady || !element) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const align = () => {
      element.scrollIntoView({ block: "start" });
      // Kept there until nothing has moved it for a moment.
      clearTimeout(timer);
      timer = setTimeout(stop, 1500);
    };
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(align);
    observer?.observe(document.body);
    const stop = () => {
      observer?.disconnect();
      for (const type of ["wheel", "touchstart", "keydown"]) window.removeEventListener(type, stop);
    };
    for (const type of ["wheel", "touchstart", "keydown"]) window.addEventListener(type, stop, { passive: true });
    align();
    return () => {
      clearTimeout(timer);
      stop();
    };
  }, [linkedReady]);
  const Icon = fileIcon(file.status);
  const shown = new Set(file.hunks.flatMap((hunk) => hunk.lines.map((line) => line.new)));
  // Made against an earlier version of the change, on a line no longer in
  // it. Not known until a file sent without its lines has them.
  const outdated = ready ? comments.filter((comment) => comment.line == null || !shown.has(comment.line)) : [];
  // Shown plain at once, and highlighted in the browser when it comes near
  // the screen: the page never waits for colours.
  const [highlighted, setHighlighted] = useState<{ content: string; html: FileHtml } | null>(null);
  // What the colours depend on. A refresh hands the page a new `file` with
  // the same lines: it keeps its colours rather than going plain and being
  // highlighted again, which flashed every coloured diff on the page.
  const content = useMemo(() => `${file.path}\n${diffContent(file)}`, [file]);
  const latest = useRef(file);
  latest.current = file;
  const kept = highlighted?.content === content ? highlighted.html : null;
  const drawn = useMemo(() => (kept ? withHtml(file, kept) : file), [file, kept]);
  useEffect(() => {
    const element = section.current;
    const file = latest.current;
    // Highlighted by the server already: one of the change's first files.
    const done = file.hunks.some((hunk) => hunk.lines.some((line) => (line as HighlightedLine).html != null));
    if (!element || collapsed || done || kept || file.hunks.length === 0) return;
    let cancelled = false;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry?.isIntersecting) return;
        observer.disconnect();
        void import("../lib/shiki")
          .then(({ highlightFile }) => highlightFile(file))
          .then((result) => {
            if (!cancelled && result) setHighlighted({ content, html: htmlOfFile(result) });
          })
          .catch(() => {});
      },
      { rootMargin: "600px 0px" },
    );
    observer.observe(element);
    return () => {
      cancelled = true;
      observer.disconnect();
    };
    // `kept` is whether `content` is highlighted already: the lines, not the object they came in.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [content, collapsed, kept != null]);
  const props = { file: drawn, comments, canComment: review?.canComment ?? false };
  return (
    <Card asChild tone="plain" className="scroll-mt-[calc(4rem+var(--diff-toolbar,3rem))]">
      <section
        ref={section}
        id={`file-${file.path}`}
        data-diff-file={file.path}
        // Lands below the site bar and the change's toolbar, whatever their height.
      >
        <header
          // Sticks under the change's toolbar (its height is --diff-toolbar), not behind it.
          className={`sticky top-[calc(var(--topbar-h)+var(--diff-toolbar,0px))] z-20 flex items-center gap-2 border-line bg-surface/95 px-2 py-2 backdrop-blur sm:gap-2.5 sm:px-3 ${
            collapsed ? "rounded-xl" : "rounded-t-xl border-b"
          }`}
        >
          <Button
            type="button"
            onClick={onToggle}
            aria-label={collapsed ? `Show ${file.path}` : `Hide ${file.path}`}
            aria-expanded={!collapsed}
            variant="ghost"
            size="inline"
            className="-m-1.5 rounded p-2 text-faint sm:m-0 sm:p-0.5"
          >
            {collapsed ? <ChevronRight size={15} /> : <ChevronDown size={15} />}
          </Button>
          <Icon size={15} className={`hidden shrink-0 sm:block ${fileTone(file.status)}`} />
          {/* A long path is cut at its start, so the file's own name shows. */}
          <button
            type="button"
            onClick={onToggle}
            dir="rtl"
            className={`min-w-0 grow truncate text-left font-mono text-[0.8125rem] ${viewed ? "text-muted" : ""}`}
          >
            <bdi>{file.path}</bdi>
          </button>
          {comments.length > 0 && (
            <span className="flex items-center gap-1 text-xs text-muted">
              <MessageSquarePlus size={12} />
              {comments.length}
            </span>
          )}
          {/* Not counted until its lines are read (one the comparison left out), nor ever when binary or too large. */}
          {file.binary || file.too_large ? (
            <span className="shrink-0 text-xs text-faint">{file.binary ? "Binary" : "Too large to compare"}</span>
          ) : (
            !(deferred && deferred.lines == null && !ready) && <Stat additions={file.additions} deletions={file.deletions} />
          )}
          {fileBase && file.status !== "deleted" && (
            <span className="hidden items-center gap-0.5 text-xs sm:flex">
              <Link to={`${fileBase}/${file.path}`} className="rounded px-1.5 py-0.5 text-muted hover:bg-raised hover:text-fg">
                View
              </Link>
              <Link to={`${fileBase}/${file.path}?blame=1`} rel="nofollow" className="rounded px-1.5 py-0.5 text-muted hover:bg-raised hover:text-fg">
                Blame
              </Link>
            </span>
          )}
          <label
            className={`ml-1 flex shrink-0 cursor-pointer items-center gap-1.5 rounded-md border px-2 py-1.5 text-xs transition-colors select-none sm:py-0.5 ${
              viewed ? "border-accent/40 bg-accent/10 text-accent" : "border-line text-muted hover:text-fg"
            }`}
          >
            <Checkbox checked={viewed} onCheckedChange={(checked) => onViewed(checked === true)} className="size-3.5 rounded-sm [&_svg]:size-2.5" />
            <span className="sr-only sm:not-sr-only">Viewed</span>
          </label>
        </header>
        {!collapsed && (
          <div className="overflow-hidden rounded-b-xl">
            {outdated.length > 0 && (
              <div className="space-y-2 border-b border-line bg-surface/50 p-3">
                <p className="text-xs text-faint">On lines that have since changed</p>
                {outdated.map((comment) => (
                  <LineComment key={comment.id} comment={comment} />
                ))}
              </div>
            )}
            {deferred && !ready ? (
              <NotLoaded
                deferred={deferred}
                failed={failed}
                waiting={deferred.large && !eager}
                onLoad={() => {
                  setFailed(false);
                  setAsked(true);
                }}
              />
            ) : deferred && got?.file === null ? (
              <p className="px-4 py-6 text-sm text-muted">This file is no longer part of the change; reload the page to see it as it is now.</p>
            ) : file.binary || file.too_large ? (
              <p className="px-4 py-6 text-sm text-muted">
                {file.binary ? "Binary file; its contents are not shown." : "Too large, or too much of it changed, to compare line by line here."}
                {fileBase && file.status !== "deleted" && (
                  <>
                    {" "}
                    <Link to={`${fileBase}/${file.path}`} className="text-accent hover:underline">
                      View the file
                    </Link>
                  </>
                )}
              </p>
            ) : file.hunks.length === 0 ? (
              <p className="px-4 py-6 text-sm text-muted">No line changes{file.status === "added" ? ": an empty file" : ""}.</p>
            ) : (
              <div className="overflow-x-auto">{layout === "split" ? <SplitRows {...props} /> : <UnifiedRows {...props} />}</div>
            )}
          </div>
        )}
      </section>
    </Card>
  );
}

type TreeNode = { name: string; path: string; children: TreeNode[]; file?: HighlightedFile };

/** The changed files as folders, with folders of one folder merged: `src/lib`. */
function treeOf(files: HighlightedFile[]): TreeNode[] {
  const root: TreeNode = { name: "", path: "", children: [] };
  for (const file of files) {
    const parts = file.path.split("/");
    let node = root;
    parts.forEach((part, index) => {
      const path = parts.slice(0, index + 1).join("/");
      let child = node.children.find((c) => c.name === part && !c.file === index < parts.length - 1);
      if (!child) {
        child = { name: part, path, children: [] };
        if (index === parts.length - 1) child.file = file;
        node.children.push(child);
      }
      node = child;
    });
  }
  const squash = (node: TreeNode): TreeNode => {
    let current = node;
    while (!current.file && current.children.length === 1 && !current.children[0]!.file) {
      const only = current.children[0]!;
      current = { ...only, name: `${current.name}/${only.name}` };
    }
    const children = current.children.map(squash).sort((a, b) => Number(!!a.file) - Number(!!b.file) || a.name.localeCompare(b.name));
    return { ...current, children };
  };
  return squash(root).children;
}

function Tree({
  nodes,
  depth,
  active,
  viewed,
  onPick,
}: {
  nodes: TreeNode[];
  depth: number;
  active: string | null;
  viewed: Set<string>;
  onPick: (path: string) => void;
}) {
  return (
    <ul>
      {nodes.map((node) => {
        if (!node.file) {
          return (
            <li key={node.path}>
              <p className="flex items-center gap-1.5 truncate py-1 font-mono text-xs text-faint" style={{ paddingLeft: depth * 12 + 8 }}>
                <Folder size={13} className="shrink-0" />
                {node.name}
              </p>
              <Tree nodes={node.children} depth={depth + 1} active={active} viewed={viewed} onPick={onPick} />
            </li>
          );
        }
        const file = node.file;
        const Icon = fileIcon(file.status);
        return (
          <li key={node.path}>
            <button
              type="button"
              onClick={() => onPick(file.path)}
              style={{ paddingLeft: depth * 12 + 8 }}
              className={`flex w-full items-center gap-1.5 rounded-md py-1 pr-2 text-left font-mono text-xs transition-colors ${
                active === file.path ? "bg-raised text-fg" : "text-muted hover:bg-raised/60 hover:text-fg"
              } ${viewed.has(file.path) ? "opacity-55" : ""}`}
            >
              <Icon size={13} className={`shrink-0 ${fileTone(file.status)}`} />
              <span className="min-w-0 grow truncate">{node.name}</span>
              <span className="shrink-0 text-[0.625rem] tabular-nums">
                {file.additions > 0 && <span className="text-success">+{file.additions}</span>}
                {file.deletions > 0 && <span className="ml-1 text-danger">−{file.deletions}</span>}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * A change, file by file: a tree of what changed beside the diffs, unified
 * or side by side, each file foldable and markable as viewed. `j` and `k`
 * move between files and `t` filters them.
 */
export function DiffView({
  comparison,
  review,
  empty,
  fileBase,
  repo,
  actions,
}: {
  comparison: Comparison | HighlightedComparison;
  review?: LineReview;
  /** At the end of the toolbar, which stays in sight: a pull request's review buttons. */
  actions?: React.ReactNode;
  /** What to say when nothing changed. */
  empty?: React.ReactNode;
  /** Where each file can be read as of the change, to link to it. */
  fileBase?: string;
  /** The repository's address, `/owner/name`: files sent without their lines are fetched from it. */
  repo?: string;
}) {
  const { truncated } = comparison;
  const files: HighlightedFile[] = comparison.files;
  // The commits compared, so a file fetched later is the same change's.
  const source = repo ? `${repo}/diff-files.json?base=${comparison.base ?? ""}&head=${encodeURIComponent(comparison.head)}` : null;
  // A file linked to (`#file-<path>`) loads at once and opens, wherever it is.
  const [wanted, setWanted] = useState<string | null>(null);
  const ahead = useMemo(() => filesAhead(files), [files]);
  const [chosenLayout, setLayout] = useState<Layout>("unified");
  // Side by side has no room on a phone.
  const narrow = useNarrow();
  const layout: Layout = narrow ? "unified" : chosenLayout;
  const [picking, setPicking] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [viewed, setViewed] = useState<Set<string>>(new Set());
  const [active, setActive] = useState<string | null>(files[0]?.path ?? null);
  const [filter, setFilter] = useState("");
  const filterInput = useRef<HTMLInputElement>(null);
  // The toolbar's height, as it wraps at each width, so the files' own
  // sticky headers sit below it rather than under it.
  const frame = useRef<HTMLDivElement>(null);
  const toolbar = useRef<HTMLDivElement>(null);
  const noFiles = files.length === 0;
  useEffect(() => {
    const bar = toolbar.current;
    const root = frame.current;
    if (!bar || !root) return;
    const measure = () => root.style.setProperty("--diff-toolbar", `${bar.offsetHeight}px`);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(bar);
    return () => observer.disconnect();
  }, [noFiles]);
  const viewedKey = `g1t:viewed:${comparison.head}`;

  // Preferences live in the browser: read them once it is there.
  useEffect(() => {
    if (stored("g1t:diff-layout") === "split") setLayout("split");
    const saved = stored(viewedKey);
    if (saved) {
      try {
        const paths = new Set<string>(JSON.parse(saved));
        setViewed(paths);
        setCollapsed(new Set(paths));
      } catch {
        // Something else wrote it.
      }
    }
  }, [viewedKey]);

  const changeLayout = (next: Layout) => {
    setLayout(next);
    store("g1t:diff-layout", next);
  };
  const markViewed = (path: string, on: boolean) => {
    setViewed((previous) => {
      const next = new Set(previous);
      if (on) next.add(path);
      else next.delete(path);
      store(viewedKey, next.size ? JSON.stringify([...next]) : null);
      return next;
    });
    // Marking a file viewed folds it away, as a reviewer moves on.
    setCollapsed((previous) => {
      const next = new Set(previous);
      if (on) next.add(path);
      else next.delete(path);
      return next;
    });
  };
  const toggle = (path: string) =>
    setCollapsed((previous) => {
      const next = new Set(previous);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  const shownFiles = useMemo(() => {
    const words = filter.toLowerCase().split(/\s+/).filter(Boolean);
    return words.length === 0 ? files : files.filter((file) => words.every((word) => file.path.toLowerCase().includes(word)));
  }, [files, filter]);
  const tree = useMemo(() => treeOf(shownFiles), [shownFiles]);

  const jump = useCallback((path: string, behavior: ScrollBehavior = "smooth") => {
    setCollapsed((previous) => {
      if (!previous.has(path)) return previous;
      const next = new Set(previous);
      next.delete(path);
      return next;
    });
    setActive(path);
    requestAnimationFrame(() => document.getElementById(`file-${path}`)?.scrollIntoView({ behavior, block: "start" }));
  }, []);

  // After the viewed files are folded away (above), so a linked one opens.
  useEffect(() => {
    const follow = () => {
      const path = linkedFile(window.location.hash, files);
      if (!path) return;
      setWanted(path);
      // At once: a long smooth scroll would race the files loading on the way.
      jump(path, "instant");
    };
    follow();
    window.addEventListener("hashchange", follow);
    return () => window.removeEventListener("hashchange", follow);
    // The address is read when the page arrives and when it changes, not on every refresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jump]);

  // The file at the top of the screen is the current one.
  useEffect(() => {
    const sections = [...document.querySelectorAll<HTMLElement>("[data-diff-file]")];
    if (sections.length === 0) return;
    const observer = new IntersectionObserver(
      (entries) => {
        const top = entries.filter((entry) => entry.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
        if (top) setActive((top.target as HTMLElement).dataset.diffFile ?? null);
      },
      { rootMargin: "-112px 0px -60% 0px" },
    );
    sections.forEach((section) => observer.observe(section));
    return () => observer.disconnect();
  }, [shownFiles, collapsed]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
      const index = shownFiles.findIndex((file) => file.path === active);
      if (event.key === "j" || event.key === "k") {
        const next = shownFiles[Math.max(0, Math.min(shownFiles.length - 1, index + (event.key === "j" ? 1 : -1)))];
        if (next) {
          event.preventDefault();
          jump(next.path);
        }
      } else if (event.key === "t") {
        event.preventDefault();
        filterInput.current?.focus();
      } else if (event.key === "v" && active) {
        event.preventDefault();
        markViewed(active, !viewed.has(active));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  if (files.length === 0) {
    return (
      <EmptyState title="No changes">{empty ?? "Nothing has been pushed to this pull request yet, or it matches the branch it would merge into."}</EmptyState>
    );
  }
  const additions = files.reduce((sum, file) => sum + file.additions, 0);
  const deletions = files.reduce((sum, file) => sum + file.deletions, 0);
  const allCollapsed = files.every((file) => collapsed.has(file.path));
  // Files the comparison left out have no counts until they are read; binary
  // and too large ones have none.
  const uncounted = files.filter((file) => file.omitted || file.binary || file.too_large).length;
  return (
    <div ref={frame}>
      <div ref={toolbar} className="sticky top-(--topbar-h) z-30 -mx-1 mb-3 flex flex-wrap items-center gap-x-4 gap-y-2 bg-bg/90 px-1 py-2 backdrop-blur">
        <span className="text-sm text-muted">
          <span className="font-medium text-fg">{files.length}</span> {files.length === 1 ? "file" : "files"}
        </span>
        <Stat additions={additions} deletions={deletions} />
        {uncounted > 0 && (
          <span className="text-xs text-faint">
            {uncounted} {uncounted === 1 ? "file" : "files"} not counted
          </span>
        )}
        <span className="flex items-center gap-2 text-xs text-muted">
          <span className="h-1.5 w-20 overflow-hidden rounded-full bg-line">
            <span className="block h-full rounded-full bg-accent transition-all" style={{ width: `${(viewed.size / files.length) * 100}%` }} />
          </span>
          {viewed.size}/{files.length} viewed
        </span>
        <div className="ml-auto flex items-center gap-2">
          {files.length > 1 && (
            // Below xl the tree is not beside the diffs: it opens as a sheet.
            <Button
              type="button"
              onClick={() => setPicking(true)}
              variant="outline"
              size="inline"
              className="flex min-h-9 px-2.5 text-xs text-muted xl:hidden font-normal"
            >
              <Files size={13} />
              Files
            </Button>
          )}
          <Button
            type="button"
            onClick={() => setCollapsed(allCollapsed ? new Set() : new Set(files.map((file) => file.path)))}
            variant="ghost"
            size="inline"
            className="px-2 py-1 text-xs font-normal"
          >
            {allCollapsed ? "Expand all" : "Collapse all"}
          </Button>
          <div className="hidden rounded-md border border-line p-0.5 sm:flex" role="radiogroup" aria-label="Layout">
            {(
              [
                ["unified", <Rows3 key="u" size={13} />, "Unified"],
                ["split", <Columns2 key="s" size={13} />, "Split"],
              ] as const
            ).map(([value, icon, label]) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={chosenLayout === value}
                onClick={() => changeLayout(value)}
                className={`flex items-center gap-1.5 rounded px-2 py-0.5 text-xs transition-colors ${
                  chosenLayout === value ? "bg-raised text-fg" : "text-muted hover:text-fg"
                }`}
              >
                {icon}
                {label}
              </button>
            ))}
          </div>
          {actions}
        </div>
      </div>
      {files.length > 1 && (
        <Sheet open={picking} onOpenChange={setPicking}>
          <SheetContent
            side="left"
            // No keyboard popping up over the list on a phone: the filter is a tap away.
            onOpenAutoFocus={(event) => event.preventDefault()}
            className="inset-x-0 top-auto bottom-0 h-[80dvh] max-w-none rounded-t-2xl pt-0 border-t border-r-0 data-[state=closed]:animate-fade-out data-[state=open]:animate-fade-in sm:max-w-none xl:hidden"
          >
            <SheetHeader>
              <SheetTitle>Files changed</SheetTitle>
              <SheetDescription>
                {files.length} files · {viewed.size} viewed
              </SheetDescription>
            </SheetHeader>
            <div className="relative px-4 pt-3">
              <Search size={14} className="pointer-events-none absolute top-1/2 left-6.5 mt-1.5 -translate-y-1/2 text-faint" />
              <input
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
                placeholder="Filter files"
                aria-label="Filter files"
                autoComplete="off"
                data-1p-ignore
                className="h-10 w-full rounded-md border border-line bg-bg pr-3 pl-8 text-sm outline-none placeholder:text-faint focus:border-accent-dim"
              />
            </div>
            <nav
              aria-label="Files changed"
              className="min-h-0 grow overflow-y-auto px-2 py-2 [&_button]:min-h-10 [&_button]:text-[0.8125rem] [&_p]:min-h-8 [&_p]:text-[0.8125rem]"
            >
              <Tree
                nodes={tree}
                depth={0}
                active={active}
                viewed={viewed}
                onPick={(path) => {
                  setPicking(false);
                  // Once the sheet has let the page go, so its scroll is not undone.
                  setTimeout(() => jump(path), 50);
                }}
              />
              {shownFiles.length === 0 && <p className="px-2 py-6 text-center text-sm text-muted">No file matches.</p>}
            </nav>
          </SheetContent>
        </Sheet>
      )}
      <div className="flex gap-4">
        {files.length > 1 && (
          <aside className="sticky top-[calc(var(--topbar-h)+3.5rem)] hidden max-h-[calc(100vh-var(--topbar-h)-4.5rem)] w-60 shrink-0 flex-col self-start xl:flex">
            <div className="relative">
              <Search size={13} className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-faint" />
              <input
                ref={filterInput}
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    setFilter("");
                    event.currentTarget.blur();
                  } else if (event.key === "Enter" && shownFiles[0]) {
                    jump(shownFiles[0].path);
                    event.currentTarget.blur();
                  }
                }}
                placeholder="Filter files"
                autoComplete="off"
                data-1p-ignore
                className="h-8 w-full rounded-md border border-line bg-surface/60 pr-7 pl-7 text-xs outline-none placeholder:text-faint focus:border-accent-dim"
              />
              <kbd className="absolute top-1/2 right-2 -translate-y-1/2 rounded border border-line px-1 font-mono text-[0.625rem] text-faint">t</kbd>
            </div>
            <nav className="mt-2 min-h-0 overflow-y-auto pb-2">
              <Tree nodes={tree} depth={0} active={active} viewed={viewed} onPick={jump} />
            </nav>
            <p className="mt-auto border-t border-line pt-2 text-[0.6875rem] text-faint">
              <kbd className="font-mono">j</kbd>/<kbd className="font-mono">k</kbd> next and previous file, <kbd className="font-mono">v</kbd> mark viewed
            </p>
          </aside>
        )}
        <div className="min-w-0 grow space-y-3">
          {review?.canComment && (
            <p className="text-xs text-faint">
              <span className="pointer-coarse:hidden">Hover a line and press the button beside its number to comment on it.</span>
              <span className="hidden pointer-coarse:inline">Tap a line number to comment on it.</span>
            </p>
          )}
          {shownFiles.map((file) => (
            <FileSection
              key={file.path}
              file={file}
              source={source}
              wanted={wanted === file.path}
              ahead={ahead.get(file.path)}
              review={review}
              layout={layout}
              collapsed={collapsed.has(file.path)}
              viewed={viewed.has(file.path)}
              onToggle={() => toggle(file.path)}
              onViewed={(on) => markViewed(file.path, on)}
              fileBase={fileBase}
            />
          ))}
          {shownFiles.length === 0 && <p className="py-8 text-center text-sm text-muted">No file matches.</p>}
          {truncated && <p className="text-center text-sm text-muted">More files changed than one page lists: these are the first {files.length}.</p>}
        </div>
      </div>
    </div>
  );
}
