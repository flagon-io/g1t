import { AlertTriangle, Check, Copy, Info, Lightbulb, Link2, MessageSquareWarning, OctagonAlert } from "lucide-react";
import type { Root } from "hast";
import type { Components } from "react-markdown";
import { type ReactNode, createContext, isValidElement, useContext, useEffect, useMemo, useRef, useState } from "react";
import { Link, useFetcher } from "react-router";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import remarkGfm from "remark-gfm";

import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import { WeightedLru } from "../lib/content-cache";
import { type Task, taskList } from "@g1t/contracts/tasks";

import { type AlertKind, G1T_MENTION_HREF, type MarkdownRepo, rehypeAlerts, rehypeReferences, rehypeTaskLines } from "../lib/markdown-plugins";
import { markdownTree, markdownWeight, renderMarkdownTree } from "../lib/markdown-tree";
import { imageSource } from "../lib/usercontent";
import { UserCard } from "./user-card";

/** The text inside a React tree, for anchors and copying. */
function textOf(node: ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (isValidElement<{ children?: ReactNode }>(node)) return textOf(node.props.children);
  return "";
}

/** An anchor id for a heading, so sections can be linked to. */
function slug(children: ReactNode): string {
  return textOf(children)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/** What raw HTML may stay: GitHub's own allow-list, as `rehype-sanitize` ships it. */
const SCHEMA = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    // Fenced blocks say their language in a class.
    code: [...(defaultSchema.attributes?.code ?? []), ["className", /^language-./]],
  },
};

/**
 * Parsed markdown, by repository and text: parsing and the plugins are
 * nine tenths of rendering a README, and a page's markdown is rendered
 * again on every view (and on every revalidation in the browser). The tree
 * depends only on the text and the repository its references point into
 * (lib/markdown-tree.ts). A tree takes about 20 bytes a character of its
 * text, so 400,000 characters of markdown, about 8 MB, per
 * isolate or tab.
 */
const trees = new WeightedLru<{ tree: Root; weight: number }>(400_000, (entry) => entry.weight);

function treeOf(source: string, repo: MarkdownRepo | undefined, workspace: string | undefined): Root {
  const key = `${repo ? `${repo.namespace}/${repo.name}` : workspace ? `${workspace}/-` : ""}\n${source}`;
  const kept = trees.get(key);
  if (kept) return kept.tree;
  const tree = markdownTree(source, {
    remarkPlugins: [remarkGfm],
    rehypePlugins: [rehypeRaw, [rehypeSanitize, SCHEMA], rehypeAlerts, [rehypeReferences, { repo, workspace }], rehypeTaskLines],
  });
  trees.set(key, { tree, weight: markdownWeight(source) });
  return tree;
}

const ALERT: Record<AlertKind, { title: string; icon: ReactNode; tone: string }> = {
  note: { title: "Note", icon: <Info size={15} />, tone: "border-info/60 [&_.alert-title]:text-info" },
  tip: { title: "Tip", icon: <Lightbulb size={15} />, tone: "border-success/60 [&_.alert-title]:text-accent" },
  important: {
    title: "Important",
    icon: <MessageSquareWarning size={15} />,
    tone: "border-merged/60 [&_.alert-title]:text-merged",
  },
  warning: { title: "Warning", icon: <AlertTriangle size={15} />, tone: "border-warn/60 [&_.alert-title]:text-warn" },
  caution: { title: "Caution", icon: <OctagonAlert size={15} />, tone: "border-danger/60 [&_.alert-title]:text-danger" },
};

function Heading({ level, children }: { level: 1 | 2 | 3 | 4; children: ReactNode }) {
  const id = slug(children);
  const Tag = `h${level}` as const;
  return (
    <Tag id={id} className="group relative scroll-mt-[calc(var(--topbar-h)+1rem)]">
      {children}
      {id && (
        <a
          href={`#${id}`}
          aria-label="Link to this section"
          className="ml-2 inline-flex align-middle text-faint no-underline opacity-0 transition-opacity group-hover:opacity-100 hover:text-fg"
        >
          <Link2 size={14} />
        </a>
      )}
    </Tag>
  );
}

/**
 * A fenced code block: plain at once, coloured in the browser when its
 * language is known, with a button to copy it.
 */
function CodeBlock({ language, code }: { language: string | null; code: string }) {
  const [html, setHtml] = useState<string[] | null>(null);
  const [copied, setCopied] = useState(false);
  const block = useRef<HTMLPreElement>(null);
  useEffect(() => {
    if (!language) return;
    let cancelled = false;
    const element = block.current;
    if (!element) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry?.isIntersecting) return;
        observer.disconnect();
        void import("../lib/shiki")
          .then(async ({ getHighlighter, languageNamed, linesToHtml }) => {
            const lang = languageNamed(language);
            if (!lang) return null;
            return linesToHtml(await getHighlighter(), code, lang);
          })
          .then((lines) => {
            if (!cancelled && lines) setHtml(lines);
          })
          .catch(() => {});
      },
      { rootMargin: "400px 0px" },
    );
    observer.observe(element);
    return () => {
      cancelled = true;
      observer.disconnect();
    };
  }, [language, code]);
  return (
    <div className="group relative">
      <pre ref={block}>
        <code>{html ? html.map((line, index) => <span key={index} className="block" dangerouslySetInnerHTML={{ __html: line || " " }} />) : code}</code>
      </pre>
      <div className="absolute top-2 right-2 flex items-center gap-2 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100 pointer-coarse:opacity-100">
        {language && <span className="font-mono text-[0.6875rem] text-faint">{language}</span>}
        <Button
          type="button"
          aria-label="Copy"
          onClick={() => {
            void navigator.clipboard?.writeText(code).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            });
          }}
          variant="outline"
          size="inline"
          className="bg-raised p-1.5 text-muted"
        >
          {copied ? <Check size={13} className="text-success" /> : <Copy size={13} />}
        </Button>
      </div>
    </div>
  );
}

function isExternal(href: string) {
  return /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("//");
}

/**
 * Renders markdown the way people expect from a forge: GitHub flavoured
 * markdown (tables, task lists, footnotes, strikethrough, autolinks), the
 * HTML GitHub allows, alerts, highlighted code, heading anchors, and
 * references (`#12`, `owner/repo#12`, `workspace#12`, `@name`, commit
 * hashes) read in `repo`, or in `workspace` for a workspace's own text
 * (lib/refs.ts). Anything an author writes is sanitized, so untrusted
 * content is safe to pass in.
 */
export function Markdown({
  source,
  repo,
  workspace,
  base,
  rawBase,
  checkable = false,
}: {
  source: string;
  /** The repository the text belongs to, for its references. */
  repo?: MarkdownRepo;
  /** The workspace the text belongs to when it is no repository's (a work item's), for its references. */
  workspace?: string;
  /** Where relative links point, e.g. `/acme/web/blob/main/docs` for a file's own folder. */
  base?: string;
  /**
   * Where relative images point: the same folder's raw files, e.g.
   * `/acme/web/raw/<commit>/docs`, under `/acme/web/raw/<commit>`. An image
   * path starting with `/` is from the repository's root.
   */
  rawBase?: string;
  /**
   * Whether the viewer may tick the boxes of its task lists: a click posts
   * `check-task` to the page's action, with the box's number (`task`), its
   * text as shown (`expected`) and `checked`, 1 or empty.
   */
  checkable?: boolean;
}) {
  // The same text renders to the same elements with the same components, so
  // a page that revalidates (a live refresh) leaves the text as it is
  // rather than mounting it again and reloading its pictures. The
  // components never change: where links and pictures point comes from
  // context, so a new commit (a README's pictures are that commit's files)
  // updates their addresses in place rather than replacing every element.
  const tree = useMemo(() => treeOf(source, repo, workspace), [source, repo?.namespace, repo?.name, workspace]);
  const rendered = useMemo(() => renderMarkdownTree(tree, COMPONENTS), [tree]);
  const bases = useMemo(() => ({ base, rawBase }), [base, rawBase]);
  const [refusal, setRefusal] = useState<string | null>(null);
  const boxes = useMemo(() => (checkable ? { tasks: taskList(source), report: setRefusal } : null), [checkable, source]);
  return (
    <MarkdownBases.Provider value={bases}>
      <TaskBoxes.Provider value={boxes}>
        {/* A long word or address breaks rather than widening the page. */}
        <div className="prose wrap-break-word">{rendered}</div>
        {boxes && refusal && (
          <p role="alert" className="mt-3 text-xs text-danger">
            {refusal}
          </p>
        )}
      </TaskBoxes.Provider>
    </MarkdownBases.Provider>
  );
}

/** Where a document's relative links (`base`) and pictures (`rawBase`) point. */
const MarkdownBases = createContext<{ base?: string; rawBase?: string }>({});

/**
 * The boxes of the text's task lists the viewer may tick, and where a
 * refusal is said; null when they only show.
 */
const TaskBoxes = createContext<{ tasks: Task[]; report: (message: string | null) => void } | null>(null);

/**
 * A task list's box. One the viewer may tick is found by its list item's
 * line among the boxes the work service counts, posted at once, and shown
 * changed before the page has it; a refusal puts it back and says why
 * under the text. Each box posts on its own, so ticking several quickly
 * sends each.
 */
function TaskBox({ checked, line }: { checked: boolean; line?: number }) {
  const boxes = useContext(TaskBoxes);
  const task = boxes && line ? boxes.tasks.find((one) => one.line === line) : undefined;
  if (!boxes || !task) {
    return (
      <Checkbox
        checked={checked}
        disabled
        aria-label={checked ? "Done" : "Not done"}
        className="mr-1.5 inline-flex translate-y-0.5 disabled:cursor-default disabled:opacity-100"
      />
    );
  }
  return <CheckableBox checked={checked} task={task} report={boxes.report} />;
}

function CheckableBox({ checked, task, report }: { checked: boolean; task: Task; report: (message: string | null) => void }) {
  const fetcher = useFetcher<{ error?: string | null } | null>();
  const refused = fetcher.state === "idle" ? fetcher.data?.error : null;
  useEffect(() => {
    if (refused) report(refused);
  }, [refused, report]);
  const pending = fetcher.formData;
  return (
    <Checkbox
      checked={pending ? pending.get("checked") === "1" : checked}
      aria-label={task.text}
      className="mr-1.5 inline-flex translate-y-0.5 cursor-pointer"
      onCheckedChange={(value) => {
        report(null);
        fetcher.submit(
          { action: "check-task", task: String(task.number), expected: task.text, checked: value === true ? "1" : "" },
          { method: "post", preventScrollReset: true },
        );
      }}
    />
  );
}

/** A link: a reference or mention within the site, an anchor, an address elsewhere, or a file beside the document. */
function MarkdownLink({ href = "", children, node }: { href?: string; children?: ReactNode; node?: { properties?: unknown } }) {
  const { base } = useContext(MarkdownBases);
  const ref = (node?.properties as { dataRef?: string } | undefined)?.dataRef;
  if (ref === "mention") {
    // `@name` may be a person (with a card) or a workspace (none).
    const name = href === G1T_MENTION_HREF ? "g1t" : href.replace(/^\//, "");
    return (
      <UserCard username={name}>
        <Link to={href} prefetch="intent" className="font-medium">
          {children}
        </Link>
      </UserCard>
    );
  }
  if (ref) {
    return (
      <Link to={href} prefetch="intent" className={ref === "commit" ? "font-mono text-[0.9em]" : ref === "mention" ? "font-medium" : ""}>
        {children}
      </Link>
    );
  }
  if (href.startsWith("#")) return <a href={href}>{children}</a>;
  if (isExternal(href)) {
    return (
      <a href={href} rel="noreferrer nofollow ugc" target="_blank">
        {children}
      </a>
    );
  }
  // A link within the site, or relative to the document's folder.
  const to = href.startsWith("/") || !base ? href : `${base}/${href.replace(/^\.\//, "")}`;
  return <Link to={to}>{children}</Link>;
}

/** A picture; a relative one is the document's commit's file. */
function MarkdownImage({ src, alt, width, height }: { src?: unknown; alt?: string; width?: string | number; height?: string | number }) {
  const { rawBase } = useContext(MarkdownBases);
  const at = typeof src === "string" ? imageSource(src, rawBase) : undefined;
  // The size the author gave (`<img width="120">`, common in READMEs) is kept,
  // so the picture's place is held before it loads and the text does not jump.
  return <img src={at} alt={alt ?? ""} width={width} height={height} loading="lazy" className="inline max-w-full rounded" />;
}

/**
 * How each element is drawn, made once: a component that is the same on
 * every render keeps the elements it drew, where a new one (even an
 * identical function) has React take them down and put them back.
 */
const COMPONENTS: Components = {
  h1: ({ children }) => <Heading level={1}>{children}</Heading>,
  h2: ({ children }) => <Heading level={2}>{children}</Heading>,
  h3: ({ children }) => <Heading level={3}>{children}</Heading>,
  h4: ({ children }) => <Heading level={4}>{children}</Heading>,
  a: MarkdownLink,
  blockquote({ children, node }) {
    const kind = (node?.properties as { dataAlert?: AlertKind } | undefined)?.dataAlert;
    if (!kind || !ALERT[kind]) return <blockquote>{children}</blockquote>;
    const alert = ALERT[kind];
    return (
      <div className={`markdown-alert border-l-2 py-1 pl-4 ${alert.tone}`}>
        <p className="alert-title flex items-center gap-2 text-sm font-medium">
          {alert.icon}
          {alert.title}
        </p>
        <div className="mt-1 [&>*+*]:mt-3">{children}</div>
      </div>
    );
  },
  pre({ children }) {
    const code = Array.isArray(children) ? children[0] : children;
    if (isValidElement<{ className?: string; children?: ReactNode }>(code)) {
      const language = /language-([\w+-]+)/.exec(code.props.className ?? "")?.[1] ?? null;
      return <CodeBlock language={language} code={textOf(code.props.children).replace(/\n$/, "")} />;
    }
    return <pre>{children}</pre>;
  },
  // A wide table scrolls on its own, inside the text, not the page.
  table: ({ children }) => (
    <div className="overflow-x-auto">
      <table className="max-sm:[&_td]:min-w-32 max-sm:[&_th]:whitespace-nowrap">{children}</table>
    </div>
  ),
  input({ type, checked, node }) {
    // Task list boxes: ticked where the page lets the viewer (TaskBox). A
    // box written as HTML has no line, and only shows.
    const line = (node?.properties as { dataTaskLine?: number } | undefined)?.dataTaskLine;
    return type === "checkbox" ? <TaskBox checked={checked === true} line={line} /> : null;
  },
  img: MarkdownImage,
};
