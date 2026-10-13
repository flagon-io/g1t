import { Check, Copy } from "lucide-react";
import { Fragment, type ReactNode, useEffect, useMemo, useState } from "react";
import { Link } from "react-router";

import { MemberCard } from "./profile-card";
import { CommitChip, IssueChip } from "./ref-chip";
import { refTarget } from "../../lib/g1t-chat";
import { Button } from "../ui/button";
import { Hint } from "../ui/hint";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../ui/table";
import { type Block, type Span, blocks, onlyEmoji } from "../../lib/chat";
// The workspace's own emoji, drawn where `:name:` is written (components/emoji).
import { useEmojiContext } from "../emoji/context";
import { renderEmoji } from "../emoji/render";
import { onlyEmojiOrCustom } from "../../lib/emoji";

/** How the text's references resolve, from what the page knows. */
export type TextContext = {
  slug: string;
  /** The viewer's username: a mention of them stands out more. */
  me: string | null;
  /**
   * Who each lowercased handle is (`mentionNames`): a mention shows as
   * `@Ana Lima`, the name people know. The text keeps `@ana`.
   */
  names?: ReadonlyMap<string, string>;
  /** Channels by name, for `#name`. */
  channels: ReadonlySet<string>;
  /** The project `#123` means when no repository is named, if any. */
  project: string | null;
  /** Where a link into Code goes instead, for a member without Code access. */
  codeLink?: (href: string) => string;
};

const PILL = "rounded-sm px-1 py-px font-medium";

function SpanView({ span, context }: { span: Span; context: TextContext }): ReactNode {
  const emoji = useEmojiContext();
  switch (span.t) {
    case "text":
      return renderEmoji(span.v, emoji.byName, emoji.usercontent);
    case "code":
      return <code className="rounded-sm border border-line bg-raised px-1 py-px font-mono text-[0.84em] text-fg-soft">{span.v}</code>;
    case "strong":
      return <strong className="font-semibold text-fg">{spans(span.c, context)}</strong>;
    case "em":
      return <em>{spans(span.c, context)}</em>;
    case "del":
      return <del className="text-muted">{spans(span.c, context)}</del>;
    case "link": {
      // A link to an issue, a pull request or a commit here is its chip (components/chat/ref-chip.tsx).
      const target = refTarget(span.href);
      if (target?.kind === "issue" && !context.codeLink) {
        return <IssueChip slug={context.slug} repo={target.repo} number={target.number} to={target.href} label={spans(span.c, context)} kind={/\/pull\//.test(target.href) ? "pull" : "issue"} />;
      }
      if (target?.kind === "commit" && !context.codeLink) return <CommitChip href={target.href} sha={target.sha} />;
      if (span.href.startsWith("/")) {
        return (
          <Link to={context.codeLink ? context.codeLink(span.href) : span.href} className="text-accent underline-offset-2 hover:underline">
            {spans(span.c, context)}
          </Link>
        );
      }
      return (
        <a href={span.href} target="_blank" rel="noopener noreferrer nofollow ugc" className="text-accent underline-offset-2 hover:underline">
          {spans(span.c, context)}
        </a>
      );
    }
    case "mention": {
      const name = span.name.toLowerCase();
      const self = context.me != null && name === context.me.toLowerCase();
      const to = name.includes("/") ? `/${context.slug}/-/teams/${name.split("/")[1]}` : `/u/${name}`;
      const pill = `${PILL} transition-colors ${self ? "bg-warn/20 text-warn hover:bg-warn/30" : "bg-accent/15 text-accent hover:bg-accent/25"}`;
      // A person: their card. A team: its page.
      if (name.includes("/")) {
        return (
          <Link to={to} className={pill}>
            @{span.name}
          </Link>
        );
      }
      const shown = context.names?.get(name);
      return (
        <MemberCard member={{ kind: "user", name, display_name: shown }} className={`inline ${pill}`}>
          @{shown ?? span.name}
        </MemberCard>
      );
    }
    case "channel":
      return context.channels.has(span.name) ? (
        <Link to={`/${context.slug}/-/chat/${span.name}`} className={`${PILL} bg-accent/10 text-accent hover:bg-accent/20`}>
          #{span.name}
        </Link>
      ) : (
        `#${span.name}`
      );
    case "ref": {
      const repo = span.repo ? (span.repo.includes("/") ? span.repo : `${context.slug}/${span.repo}`) : context.project ? `${context.slug}/${context.project}` : null;
      const label = `${span.repo ? span.repo : ""}#${span.number}`;
      if (!repo) return <span className="font-medium text-fg-soft">{label}</span>;
      // Issues and pull requests share numbers; the issue page sends a pull on.
      const href = `/${repo}/issues/${span.number}`;
      if (!context.codeLink) return <IssueChip slug={context.slug} repo={repo} number={span.number} label={label} />;
      return (
        <Link to={context.codeLink ? context.codeLink(href) : href} className="font-medium text-accent hover:underline">
          {label}
        </Link>
      );
    }
  }
}

function spans(list: Span[], context: TextContext): ReactNode {
  return list.map((span, index) => <SpanView key={index} span={span} context={context} />);
}

function lines(list: Span[][], context: TextContext): ReactNode {
  return list.map((line, index) => (
    <Fragment key={index}>
      {index > 0 && <br />}
      {spans(line, context)}
    </Fragment>
  ));
}

/** A run of blocks, a little apart. */
function BlocksView({ list, context, className = "space-y-1.5" }: { list: Block[]; context: TextContext; className?: string }) {
  return (
    <div className={className}>
      {list.map((block, index) => (
        <BlockView key={index} block={block} context={context} />
      ))}
    </div>
  );
}

function ListItem({ item, context }: { item: Block[]; context: TextContext }) {
  // An item of one paragraph is its lines; one with more holds its blocks.
  if (item.length === 1 && item[0]!.t === "p") return <li className="pl-0.5">{lines(item[0]!.lines, context)}</li>;
  return (
    <li className="pl-0.5">
      <BlocksView list={item} context={context} className="space-y-1" />
    </li>
  );
}

function BlockView({ block, context }: { block: Block; context: TextContext }) {
  switch (block.t) {
    case "p":
      return <p>{lines(block.lines, context)}</p>;
    case "heading":
      // Chat, not a document: a heading is a bold line with room above it, the top two a touch larger.
      return <p className={`pt-1.5 font-semibold tracking-[-0.005em] text-fg first:pt-0 ${block.level <= 2 ? "text-base" : ""}`}>{spans(block.c, context)}</p>;
    case "table":
      return <TableView block={block} context={context} />;
    case "hr":
      return <hr className="my-2 border-line" />;
    case "code":
      return <CodeBlock language={block.lang} code={block.v} />;
    case "list": {
      const Tag = block.ordered ? "ol" : "ul";
      return (
        <Tag start={block.ordered && block.start !== 1 ? block.start : undefined} className={`space-y-0.5 pl-5 ${block.ordered ? "list-decimal" : "list-disc"} marker:text-faint`}>
          {block.items.map((item, index) => (
            <ListItem key={index} item={item} context={context} />
          ))}
        </Tag>
      );
    }
    case "quote":
      return (
        <blockquote className="border-l-2 border-line-strong pl-3 text-muted">
          <BlocksView list={block.c} context={context} className="space-y-1" />
        </blockquote>
      );
  }
}

/**
 * A table, as the theme draws tables in rendered Markdown: a quiet header
 * row, lines between rows, and its columns aligned as written. A wide one
 * scrolls sideways inside the message, never the page, and takes focus so
 * it can be scrolled from the keyboard.
 */
function TableView({ block, context }: { block: Extract<Block, { t: "table" }>; context: TextContext }) {
  const align = (index: number) => block.align[index] ?? undefined;
  return (
    <Table frameProps={{ role: "region", "aria-label": "Table", tabIndex: 0, className: "my-1 rounded-lg border border-line" }} className="min-w-max text-[0.8125rem] leading-snug sm:min-w-full">
      <TableHeader>
        <TableRow>
          {block.head.map((cell, index) => (
            <TableHead key={index} scope="col" style={{ textAlign: align(index) }}>
              {spans(cell, context)}
            </TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {block.rows.map((row, at) => (
          <TableRow key={at}>
            {row.map((cell, index) => (
              <TableCell key={index} style={{ textAlign: align(index) }} className={align(index) === "right" ? "whitespace-nowrap tabular-nums" : "max-w-lg"}>
                {spans(cell, context)}
              </TableCell>
            ))}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

type Token = { content: string; color?: string };

/**
 * Fenced code: plain at once, coloured once the highlighter has loaded
 * when its language is one g1t knows (lib/shiki.ts), with a copy button.
 * The colours are tokens drawn as text, never HTML.
 */
export function CodeBlock({ language, code, title = null, bar = false }: { language: string | null; code: string; title?: string | null; bar?: boolean }) {
  // The colours as last worked out, for the code they were worked out for:
  // while an answer streams in, the code grows, and what is new shows plain
  // after what is already coloured until the next pass, never flickering.
  const [painted, setPainted] = useState<{ code: string; rows: Token[][] } | null>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!language || code.length > 20_000) return setPainted(null);
    let cancelled = false;
    void import("../../lib/shiki")
      .then(async ({ getHighlighter, languageNamed, tokenRows }) => {
        const lang = languageNamed(language);
        if (!lang) return null;
        return tokenRows(await getHighlighter(), code, lang);
      })
      .then((tokens) => {
        if (!cancelled) setPainted(tokens ? { code, rows: tokens } : null);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [language, code]);
  const rows = painted && code.startsWith(painted.code) ? painted.rows : null;
  const rest = rows ? code.slice(painted!.code.length) : code;
  const copy = (
    <Hint label={copied ? "Copied" : "Copy code"}>
      <Button
        type="button"
        aria-label="Copy code"
        onClick={() => {
          void navigator.clipboard?.writeText(code).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          });
        }}
        variant={bar ? "ghost" : "outline"}
        size="icon"
        className={bar ? "size-6 text-faint hover:text-fg" : "size-6 bg-raised text-muted"}
      >
        {copied ? <Check size={12} className="text-success" /> : <Copy size={12} />}
      </Button>
    </Hint>
  );
  const body = (
    <code>
      {rows?.map((row, index) => (
        <span key={index} className={index < rows.length - 1 || !rest ? "block min-h-lh" : undefined}>
          {row.map((token, at) => (
            <span key={at} style={token.color ? { color: token.color } : undefined}>
              {token.content}
            </span>
          ))}
        </span>
      ))}
      {rest}
    </code>
  );
  // In g1t's answers: a bar over the code with its file name or language, and Copy always there.
  if (bar) {
    return (
      <div className="my-1 overflow-hidden rounded-lg border border-line bg-bg">
        <div className="flex h-8 items-center gap-2 border-b border-line bg-surface pr-1 pl-3">
          <span className="min-w-0 grow truncate font-mono text-[0.6875rem] text-muted">{title ?? language ?? "text"}</span>
          {copy}
        </div>
        <pre className="max-h-112 overflow-auto px-3 py-2 font-mono text-[0.8125rem] leading-relaxed text-fg-soft scrollbar-thin">{body}</pre>
      </div>
    );
  }
  return (
    <div className="group/code relative my-1">
      <pre className="overflow-x-auto rounded-md border border-line bg-bg px-3 py-2 pointer-coarse:pr-10 font-mono text-[0.8125rem] leading-relaxed text-fg-soft scrollbar-thin">{body}</pre>
      <div className="absolute top-1.5 right-1.5 flex items-center gap-2 opacity-0 transition-opacity group-hover/code:opacity-100 focus-within:opacity-100 pointer-coarse:opacity-100">
        {language && <span className="font-mono text-[0.6875rem] text-faint pointer-coarse:hidden">{language}</span>}
        {copy}
      </div>
    </div>
  );
}

/** A message's text, rendered from parsed blocks: never as HTML. */
export function MessageText({ body, context }: { body: string; context: TextContext }) {
  const parsed = useMemo(() => blocks(body), [body]);
  const emoji = useEmojiContext();
  if (onlyEmoji(body)) return <p className="text-3xl leading-tight">{body.trim()}</p>;
  if (onlyEmojiOrCustom(body, emoji.byName)) return <p className="text-3xl leading-tight">{renderEmoji(body.trim(), emoji.byName, emoji.usercontent, 32)}</p>;
  return (
    <div className="space-y-1.5 text-[0.9375rem] leading-[1.55] wrap-break-word text-fg-soft">
      {parsed.map((block, index) => (
        <BlockView key={index} block={block} context={context} />
      ))}
    </div>
  );
}
