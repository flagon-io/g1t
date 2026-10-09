/**
 * g1t's own blocks in the page editor, beside BlockNote's: callouts,
 * Mermaid diagrams, math, and cards for g1t things (an issue, a pull
 * request, a channel, a project, another page); and inline mentions of
 * people, agents and pages, and dates. The docs service reads the same
 * names and attributes when it writes Markdown (services/docs
 * src/markdown.ts), so keep the two in step. Browser-only: loaded with
 * the editor.
 */
import { BlockNoteSchema, createCodeBlockSpec, defaultBlockSpecs, defaultInlineContentSpecs } from "@blocknote/core";
import { createReactBlockSpec, createReactInlineContentSpec } from "@blocknote/react";
import { codeBlockOptions } from "@blocknote/code-block";
import { AlertTriangle, CheckCircle2, CircleDot, FileText, GitPullRequest, Hash, Info, OctagonAlert, Package } from "lucide-react";
import { useEffect, useId, useState, type ReactNode } from "react";

/** What an embed shows, from the site (`-/docs/api?embed=`). */
export type EmbedCard = { kind: "issue" | "pull" | "channel" | "project" | "page" | "link"; title: string; subtitle: string | null; state: string | null; href: string };

const CALLOUTS = {
  info: { icon: <Info size={16} />, ring: "border-info/30 bg-info/8", text: "text-info" },
  warning: { icon: <AlertTriangle size={16} />, ring: "border-warn/30 bg-warn/8", text: "text-warn" },
  success: { icon: <CheckCircle2 size={16} />, ring: "border-success/30 bg-success/8", text: "text-success" },
  danger: { icon: <OctagonAlert size={16} />, ring: "border-danger/30 bg-danger/8", text: "text-danger" },
} as const;

export const Callout = createReactBlockSpec(
  {
    type: "callout",
    propSchema: {
      kind: { default: "info", values: ["info", "warning", "success", "danger"] },
      backgroundColor: { default: "default" },
      textColor: { default: "default" },
    },
    content: "inline",
  },
  {
    render: ({ block, editor, contentRef }) => {
      const look = CALLOUTS[block.props.kind as keyof typeof CALLOUTS] ?? CALLOUTS.info;
      const next = { info: "warning", warning: "success", success: "danger", danger: "info" } as const;
      return (
        <div className={`my-1 flex w-full gap-2.5 rounded-lg border px-3.5 py-2.5 ${look.ring}`}>
          <button
            type="button"
            contentEditable={false}
            aria-label="Change the callout's kind"
            disabled={!editor.isEditable}
            onClick={() => editor.updateBlock(block, { props: { kind: next[block.props.kind as keyof typeof next] ?? "info" } })}
            className={`mt-0.5 shrink-0 ${look.text}`}
          >
            {look.icon}
          </button>
          <div ref={contentRef} className="min-w-0 grow" />
        </div>
      );
    },
  },
);

/** A diagram drawn from its Mermaid source, live as it is typed. */
function MermaidView({ code }: { code: string }) {
  const id = useId().replace(/[^a-zA-Z0-9]/g, "");
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const mermaid = (await import("mermaid")).default;
        mermaid.initialize({ startOnLoad: false, theme: "dark", securityLevel: "strict", fontFamily: "inherit" });
        const { svg } = await mermaid.render(`mermaid-${id}-${Date.now()}`, code || "flowchart LR\n  A --> B");
        if (!cancelled) {
          setSvg(svg);
          setError(null);
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message.split("\n")[0]! : "This diagram has an error.");
      }
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [code, id]);
  if (error) return <p className="text-xs text-danger">{error}</p>;
  if (!svg) return <p className="text-xs text-faint">Drawing…</p>;
  // Mermaid sanitizes what it draws (securityLevel "strict").
  return <div className="flex justify-center overflow-x-auto [&_svg]:max-w-full" dangerouslySetInnerHTML={{ __html: svg }} />;
}

function SourceEditor({ value, onChange, placeholder, mono = true, editable }: { value: string; onChange: (v: string) => void; placeholder: string; mono?: boolean; editable: boolean }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  if (!editable) return null;
  return (
    <textarea
      value={draft}
      placeholder={placeholder}
      spellCheck={false}
      rows={Math.min(14, Math.max(2, draft.split("\n").length))}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => draft !== value && onChange(draft)}
      onKeyDown={(e) => e.stopPropagation()}
      className={`w-full resize-y rounded-md border border-line bg-bg px-2.5 py-2 text-[0.8125rem] leading-relaxed text-fg outline-none focus:border-[var(--g1t-accent)] ${mono ? "font-mono" : ""}`}
    />
  );
}

export const Mermaid = createReactBlockSpec(
  { type: "mermaid", propSchema: { code: { default: "flowchart LR\n  A[Idea] --> B[Spec] --> C[Shipped]" } }, content: "none" },
  {
    render: ({ block, editor }) => {
      const [editing, setEditing] = useState(false);
      return (
        <div className="my-1 w-full rounded-lg border border-line bg-surface p-3" contentEditable={false}>
          <div className="mb-2 flex items-center justify-between text-[0.6875rem] font-medium tracking-wide text-faint uppercase">
            <span>Diagram</span>
            {editor.isEditable && (
              <button type="button" onClick={() => setEditing(!editing)} className="rounded px-1.5 py-0.5 normal-case hover:bg-raised hover:text-fg">
                {editing ? "Done" : "Edit source"}
              </button>
            )}
          </div>
          {editing && <SourceEditor editable value={block.props.code} placeholder="flowchart LR&#10;  A --> B" onChange={(code) => editor.updateBlock(block, { props: { code } })} />}
          <div className={editing ? "mt-3" : ""}>
            <MermaidView code={block.props.code} />
          </div>
        </div>
      );
    },
  },
);

/** A formula, typeset with KaTeX. */
function MathView({ expression, inline = false }: { expression: string; inline?: boolean }) {
  const [html, setHtml] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [{ default: katex }] = await Promise.all([import("katex"), import("katex/dist/katex.min.css")]);
      const out = katex.renderToString(expression || "\\;", { throwOnError: false, displayMode: !inline, output: "html", trust: false, strict: "ignore" });
      if (!cancelled) setHtml(out);
    })();
    return () => {
      cancelled = true;
    };
  }, [expression, inline]);
  if (html === null) return <code className="text-xs text-faint">{expression}</code>;
  // KaTeX escapes what it is given and allows no commands that run anything (trust: false).
  return <div className="overflow-x-auto text-fg" dangerouslySetInnerHTML={{ __html: html }} />;
}

export const MathBlock = createReactBlockSpec(
  { type: "math", propSchema: { expression: { default: "e^{i\\pi} + 1 = 0" } }, content: "none" },
  {
    render: ({ block, editor }) => {
      const [editing, setEditing] = useState(false);
      return (
        <div className="group/math my-1 w-full rounded-lg px-3 py-2 hover:bg-surface" contentEditable={false}>
          {editing ? (
            <SourceEditor editable value={block.props.expression} placeholder="\int_0^1 x^2\,dx" onChange={(expression) => editor.updateBlock(block, { props: { expression } })} />
          ) : null}
          <button type="button" className="block w-full text-left" disabled={!editor.isEditable} onClick={() => setEditing(!editing)} aria-label={editing ? "Done editing the formula" : "Edit the formula"}>
            <MathView expression={block.props.expression} />
          </button>
        </div>
      );
    },
  },
);

const EMBED_ICONS: Record<EmbedCard["kind"], ReactNode> = {
  issue: <CircleDot size={16} />,
  pull: <GitPullRequest size={16} />,
  channel: <Hash size={16} />,
  project: <Package size={16} />,
  page: <FileText size={16} />,
  link: <FileText size={16} />,
};

/** The card for a g1t address, asked of the site as the reader (so it shows only what they may see). */
function EmbedView({ url, title }: { url: string; title: string }) {
  const [card, setCard] = useState<EmbedCard | null | "missing">(null);
  useEffect(() => {
    let cancelled = false;
    const workspace = window.location.pathname.split("/")[1] ?? "";
    fetch(`/${workspace}/-/docs/api?embed=${encodeURIComponent(url)}`, { headers: { accept: "application/json" } })
      .then((r) => r.json() as Promise<{ ok: boolean; value?: EmbedCard }>)
      .then((r) => !cancelled && setCard(r.ok && r.value ? r.value : "missing"))
      .catch(() => !cancelled && setCard("missing"));
    return () => {
      cancelled = true;
    };
  }, [url]);
  const shown = card && card !== "missing" ? card : null;
  const state = shown?.state ?? null;
  const tone = state === "open" ? "text-success" : state === "merged" ? "text-merged" : state === "closed" ? "text-danger" : "text-[var(--g1t-muted)]";
  return (
    <a
      href={shown?.href ?? url}
      contentEditable={false}
      className="my-1 flex w-full items-center gap-3 rounded-lg border border-line bg-surface px-3.5 py-2.5 no-underline transition-colors hover:border-line-strong hover:bg-raised"
    >
      <span className={`shrink-0 ${tone}`}>{EMBED_ICONS[shown?.kind ?? "link"]}</span>
      <span className="min-w-0 grow">
        <span className="block truncate text-sm font-medium text-fg">{shown?.title ?? (title || url)}</span>
        <span className="block truncate text-xs text-faint">{card === null ? "Loading…" : card === "missing" ? "You can't see this, or it's gone." : shown?.subtitle}</span>
      </span>
      {state && <span className={`shrink-0 rounded-full px-2 py-0.5 text-[0.6875rem] font-medium capitalize ring-1 ring-current/30 ${tone}`}>{state}</span>}
    </a>
  );
}

export const Embed = createReactBlockSpec(
  { type: "embed", propSchema: { url: { default: "" }, title: { default: "" }, kind: { default: "link" } }, content: "none" },
  {
    render: ({ block, editor }) => {
      const [draft, setDraft] = useState("");
      if (!block.props.url) {
        if (!editor.isEditable) return <div contentEditable={false} />;
        return (
          <form
            contentEditable={false}
            className="my-1 flex w-full gap-2 rounded-lg border border-dashed border-line p-2"
            onSubmit={(e) => {
              e.preventDefault();
              const url = draft.trim();
              if (url) editor.updateBlock(block, { props: { url } });
            }}
          >
            <input
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => e.stopPropagation()}
              placeholder="Paste the address of an issue, pull request, channel, project or page"
              className="min-w-0 grow bg-transparent px-1.5 text-sm text-fg outline-none placeholder:text-faint"
            />
            <button type="submit" className="rounded-md bg-raised px-2.5 py-1 text-xs font-medium text-fg hover:bg-line">
              Embed
            </button>
          </form>
        );
      }
      return <EmbedView url={block.props.url} title={block.props.title} />;
    },
  },
);

/** A person, agent or page, inline. */
export const Mention = createReactInlineContentSpec(
  {
    type: "mention",
    propSchema: { kind: { default: "user" }, id: { default: "" }, name: { default: "" }, href: { default: "" } },
    content: "none",
  },
  {
    render: ({ inlineContent }) => {
      const p = inlineContent.props;
      if (p.kind === "page") {
        return (
          <a href={p.href || "#"} className="rounded px-0.5 font-medium text-[var(--g1t-accent)] no-underline hover:underline">
            <FileText size={13} className="mr-0.5 inline -translate-y-px" aria-hidden="true" />
            {p.name || "Untitled"}
          </a>
        );
      }
      return <span className={`rounded px-1 py-px font-medium ${p.kind === "agent" ? "bg-[color-mix(in_srgb,var(--g1t-accent)_15%,transparent)] text-[var(--g1t-accent)]" : "bg-info/12 text-info"}`}>@{p.name}</span>;
    },
  },
);

/** A date, inline. */
export const DateChip = createReactInlineContentSpec(
  { type: "date", propSchema: { date: { default: "" } }, content: "none" },
  {
    render: ({ inlineContent }) => {
      const at = new Date(`${inlineContent.props.date}T12:00:00`);
      const label = Number.isNaN(at.getTime()) ? inlineContent.props.date : at.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", year: "numeric" });
      return <span className="rounded bg-raised px-1 py-px text-[0.9em] text-fg-soft">{label}</span>;
    },
  },
);

export const schema = BlockNoteSchema.create({
  blockSpecs: {
    ...defaultBlockSpecs,
    codeBlock: createCodeBlockSpec(codeBlockOptions),
    callout: Callout(),
    mermaid: Mermaid(),
    math: MathBlock(),
    embed: Embed(),
  },
  inlineContentSpecs: { ...defaultInlineContentSpecs, mention: Mention, date: DateChip },
});

export type DocSchema = typeof schema;
export type DocEditorInstance = typeof schema.BlockNoteEditor;
