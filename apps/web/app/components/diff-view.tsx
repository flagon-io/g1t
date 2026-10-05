import {
  ChevronDown,
  ChevronRight,
  Columns2,
  FileDiff as FileIcon,
  FileMinus,
  FilePlus,
  Folder,
  MessageSquarePlus,
  Rows3,
  Search,
} from "lucide-react";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Form, Link } from "react-router";

import type { Comment, Comparison, DiffLine } from "@g1t/contracts";

import type {
  HighlightedComparison,
  HighlightedFile,
  HighlightedLine,
} from "../lib/diff";
import { Markdown } from "./markdown";
import { Avatar, Button, EmptyState, Textarea, TimeAgo } from "./ui";

const ROW_STYLES: Record<DiffLine["kind"], string> = {
  context: "",
  add: "bg-accent/[0.09]",
  delete: "bg-danger/[0.09]",
};

const GUTTER_STYLES: Record<DiffLine["kind"], string> = {
  context: "text-faint",
  add: "bg-accent/[0.14] text-accent/70",
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

/** `+12 −3` with a five-block bar. */
export function Stat({ additions, deletions }: { additions: number; deletions: number }) {
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

function fileIcon(status: HighlightedFile["status"]) {
  return status === "added" ? FilePlus : status === "deleted" ? FileMinus : FileIcon;
}

function fileTone(status: HighlightedFile["status"]) {
  return status === "added" ? "text-accent" : status === "deleted" ? "text-danger" : "text-faint";
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

/** A line's text, highlighted when the server could. */
function Code({ line }: { line: HighlightedLine | null }) {
  if (!line) return null;
  if (line.html != null) {
    return <span dangerouslySetInnerHTML={{ __html: line.html || " " }} />;
  }
  return <>{line.text || " "}</>;
}

/** The comments on a line and, when open, the box to add one. */
function Thread({
  path,
  line,
  comments,
  open,
  onClose,
}: {
  path: string;
  line: number;
  comments: Comment[];
  open: boolean;
  onClose: () => void;
}) {
  return (
    <div className="max-w-2xl space-y-2">
      {comments.map((comment) => (
        <LineComment key={comment.id} comment={comment} />
      ))}
      {open && (
        <Form method="post" className="space-y-2 font-sans" onSubmit={onClose}>
          <input type="hidden" name="action" value="comment" />
          <input type="hidden" name="path" value={path} />
          <input type="hidden" name="line" value={line} />
          <Textarea name="body" rows={3} required autoFocus placeholder={`Comment on line ${line}`} />
          <div className="flex gap-2">
            <Button type="submit">Comment</Button>
            <Button variant="quiet" type="button" onClick={onClose}>
              Cancel
            </Button>
          </div>
        </Form>
      )}
    </div>
  );
}

function CommentButton({ line, onClick }: { line: number; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label={`Comment on line ${line}`}
      onClick={onClick}
      className="absolute top-0 -right-2.5 z-10 hidden size-5 items-center justify-center rounded bg-accent text-bg group-hover:flex focus-visible:flex"
    >
      <MessageSquarePlus size={12} />
    </button>
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
                    <td className={`w-12 px-2 text-right select-none ${GUTTER_STYLES[line.kind]}`}>
                      {line.old}
                    </td>
                    <td className={`relative w-12 px-2 text-right select-none ${GUTTER_STYLES[line.kind]}`}>
                      {line.new}
                      {canComment && line.new != null && (
                        <CommentButton line={line.new} onClick={() => setWriting(open ? null : line.new)} />
                      )}
                    </td>
                    <td className={`w-5 text-center select-none ${fileToneFor(line.kind)}`}>
                      {MARKERS[line.kind]}
                    </td>
                    <td className="pr-4 whitespace-pre">
                      <Code line={line} />
                    </td>
                  </tr>
                  {(here.length > 0 || open) && line.new != null && (
                    <tr>
                      <td colSpan={4} className="border-y border-line bg-surface p-3">
                        <Thread
                          path={file.path}
                          line={line.new}
                          comments={here}
                          open={open}
                          onClose={() => setWriting(null)}
                        />
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
  return kind === "add" ? "text-accent" : kind === "delete" ? "text-danger" : "text-faint";
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
                        <Thread
                          path={file.path}
                          line={line}
                          comments={here}
                          open={open}
                          onClose={() => setWriting(null)}
                        />
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

function FileSection({
  file,
  review,
  layout,
  collapsed,
  viewed,
  onToggle,
  onViewed,
  fileBase,
}: {
  file: HighlightedFile;
  review?: LineReview;
  layout: Layout;
  collapsed: boolean;
  viewed: boolean;
  onToggle: () => void;
  onViewed: (viewed: boolean) => void;
  /** Where the file can be read as of the change, e.g. `/acme/web/blob/<hash>`. */
  fileBase?: string;
}) {
  const Icon = fileIcon(file.status);
  const comments = review?.comments.filter((comment) => comment.path === file.path) ?? [];
  const shown = new Set(file.hunks.flatMap((hunk) => hunk.lines.map((line) => line.new)));
  // Made against an earlier version of the change, on a line no longer in it.
  const outdated = comments.filter((comment) => comment.line == null || !shown.has(comment.line));
  // Shown plain at once, and highlighted in the browser when it comes near
  // the screen: the page never waits for colours.
  const section = useRef<HTMLElement>(null);
  const [highlighted, setHighlighted] = useState<HighlightedFile | null>(null);
  useEffect(() => {
    setHighlighted(null);
    const element = section.current;
    if (!element || collapsed) return;
    let cancelled = false;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry?.isIntersecting) return;
        observer.disconnect();
        void import("../lib/shiki")
          .then(({ highlightFile }) => highlightFile(file))
          .then((result) => {
            if (!cancelled && result) setHighlighted(result);
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
  }, [file, collapsed]);
  const props = { file: highlighted ?? file, comments, canComment: review?.canComment ?? false };
  return (
    <section
      ref={section}
      id={`file-${file.path}`}
      data-diff-file={file.path}
      className="scroll-mt-28 rounded-xl border border-line"
    >
      <header
        className={`sticky top-16 z-20 flex items-center gap-2.5 border-line bg-surface/95 px-3 py-2 backdrop-blur ${
          collapsed ? "rounded-xl" : "rounded-t-xl border-b"
        }`}
      >
        <button
          type="button"
          onClick={onToggle}
          aria-label={collapsed ? `Show ${file.path}` : `Hide ${file.path}`}
          aria-expanded={!collapsed}
          className="rounded p-0.5 text-faint hover:bg-raised hover:text-fg"
        >
          {collapsed ? <ChevronRight size={15} /> : <ChevronDown size={15} />}
        </button>
        <Icon size={15} className={fileTone(file.status)} />
        <button
          type="button"
          onClick={onToggle}
          className={`min-w-0 grow truncate text-left font-mono text-[0.8125rem] ${viewed ? "text-muted" : ""}`}
        >
          {file.path}
        </button>
        {comments.length > 0 && (
          <span className="flex items-center gap-1 text-xs text-muted">
            <MessageSquarePlus size={12} />
            {comments.length}
          </span>
        )}
        <Stat additions={file.additions} deletions={file.deletions} />
        {fileBase && file.status !== "deleted" && (
          <span className="hidden items-center gap-0.5 text-xs sm:flex">
            <Link to={`${fileBase}/${file.path}`} className="rounded px-1.5 py-0.5 text-muted hover:bg-raised hover:text-fg">
              View
            </Link>
            <Link
              to={`${fileBase}/${file.path}?blame=1`}
              className="rounded px-1.5 py-0.5 text-muted hover:bg-raised hover:text-fg"
            >
              Blame
            </Link>
          </span>
        )}
        <label
          className={`ml-1 flex cursor-pointer items-center gap-1.5 rounded-md border px-2 py-0.5 text-xs transition-colors select-none ${
            viewed ? "border-accent/40 bg-accent/10 text-accent" : "border-line text-muted hover:text-fg"
          }`}
        >
          <input
            type="checkbox"
            checked={viewed}
            onChange={(event) => onViewed(event.target.checked)}
            className="accent-accent"
          />
          Viewed
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
          {file.binary ? (
            <p className="px-4 py-6 text-sm text-muted">Binary or large file; its contents are not shown.</p>
          ) : file.hunks.length === 0 ? (
            <p className="px-4 py-6 text-sm text-muted">No line changes{file.status === "added" ? ": an empty file" : ""}.</p>
          ) : (
            <div className="overflow-x-auto">
              {layout === "split" ? <SplitRows {...props} /> : <UnifiedRows {...props} />}
            </div>
          )}
        </div>
      )}
    </section>
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
      let child = node.children.find((c) => c.name === part && !c.file === (index < parts.length - 1));
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
    const children = current.children
      .map(squash)
      .sort((a, b) => Number(!!a.file) - Number(!!b.file) || a.name.localeCompare(b.name));
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
              <p
                className="flex items-center gap-1.5 truncate py-1 font-mono text-xs text-faint"
                style={{ paddingLeft: depth * 12 + 8 }}
              >
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
                {file.additions > 0 && <span className="text-accent">+{file.additions}</span>}
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
}: {
  comparison: Comparison;
  review?: LineReview;
  /** What to say when nothing changed. */
  empty?: React.ReactNode;
  /** Where each file can be read as of the change, to link to it. */
  fileBase?: string;
}) {
  const { files, truncated } = comparison;
  const [layout, setLayout] = useState<Layout>("unified");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [viewed, setViewed] = useState<Set<string>>(new Set());
  const [active, setActive] = useState<string | null>(files[0]?.path ?? null);
  const [filter, setFilter] = useState("");
  const filterInput = useRef<HTMLInputElement>(null);
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
    return words.length === 0
      ? files
      : files.filter((file) => words.every((word) => file.path.toLowerCase().includes(word)));
  }, [files, filter]);
  const tree = useMemo(() => treeOf(shownFiles), [shownFiles]);

  const jump = useCallback((path: string) => {
    setCollapsed((previous) => {
      if (!previous.has(path)) return previous;
      const next = new Set(previous);
      next.delete(path);
      return next;
    });
    setActive(path);
    requestAnimationFrame(() =>
      document.getElementById(`file-${path}`)?.scrollIntoView({ behavior: "smooth", block: "start" }),
    );
  }, []);

  // The file at the top of the screen is the current one.
  useEffect(() => {
    const sections = [...document.querySelectorAll<HTMLElement>("[data-diff-file]")];
    if (sections.length === 0) return;
    const observer = new IntersectionObserver(
      (entries) => {
        const top = entries
          .filter((entry) => entry.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
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
      <EmptyState title="No changes">
        {empty ?? "Nothing has been pushed to this pull request yet, or it matches the branch it would merge into."}
      </EmptyState>
    );
  }
  const additions = files.reduce((sum, file) => sum + file.additions, 0);
  const deletions = files.reduce((sum, file) => sum + file.deletions, 0);
  const allCollapsed = files.every((file) => collapsed.has(file.path));
  return (
    <div>
      <div className="sticky top-16 z-30 -mx-1 mb-3 flex flex-wrap items-center gap-x-4 gap-y-2 bg-bg/90 px-1 py-2 backdrop-blur">
        <span className="text-sm text-muted">
          <span className="font-medium text-fg">{files.length}</span> {files.length === 1 ? "file" : "files"}
        </span>
        <Stat additions={additions} deletions={deletions} />
        <span className="flex items-center gap-2 text-xs text-muted">
          <span className="h-1.5 w-20 overflow-hidden rounded-full bg-line">
            <span
              className="block h-full rounded-full bg-accent transition-all"
              style={{ width: `${(viewed.size / files.length) * 100}%` }}
            />
          </span>
          {viewed.size}/{files.length} viewed
        </span>
        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            onClick={() => setCollapsed(allCollapsed ? new Set() : new Set(files.map((file) => file.path)))}
            className="rounded-md px-2 py-1 text-xs text-muted hover:bg-raised hover:text-fg"
          >
            {allCollapsed ? "Expand all" : "Collapse all"}
          </button>
          <div className="flex rounded-md border border-line p-0.5" role="radiogroup" aria-label="Layout">
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
                aria-checked={layout === value}
                onClick={() => changeLayout(value)}
                className={`flex items-center gap-1.5 rounded px-2 py-0.5 text-xs transition-colors ${
                  layout === value ? "bg-raised text-fg" : "text-muted hover:text-fg"
                }`}
              >
                {icon}
                {label}
              </button>
            ))}
          </div>
        </div>
      </div>
      <div className="flex gap-4">
        {files.length > 1 && (
          <aside className="sticky top-28 hidden max-h-[calc(100vh-8rem)] w-60 shrink-0 flex-col self-start xl:flex">
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
              <kbd className="absolute top-1/2 right-2 -translate-y-1/2 rounded border border-line px-1 font-mono text-[0.625rem] text-faint">
                t
              </kbd>
            </div>
            <nav className="mt-2 min-h-0 overflow-y-auto pb-2">
              <Tree nodes={tree} depth={0} active={active} viewed={viewed} onPick={jump} />
            </nav>
            <p className="mt-auto border-t border-line pt-2 text-[0.6875rem] text-faint">
              <kbd className="font-mono">j</kbd>/<kbd className="font-mono">k</kbd> next and previous file,{" "}
              <kbd className="font-mono">v</kbd> mark viewed
            </p>
          </aside>
        )}
        <div className="min-w-0 grow space-y-3">
          {review?.canComment && (
            <p className="text-xs text-faint">Hover a line and press the button beside its number to comment on it.</p>
          )}
          {shownFiles.map((file) => (
            <FileSection
              key={file.path}
              file={file}
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
          {truncated && <p className="text-center text-sm text-muted">This change is too large to show in full.</p>}
        </div>
      </div>
    </div>
  );
}
