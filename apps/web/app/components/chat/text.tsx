import { Fragment, type ReactNode, useMemo } from "react";
import { Link } from "react-router";

import { type Block, type Span, blocks, onlyEmoji } from "../../lib/chat";

/** How the text's references resolve, from what the page knows. */
export type TextContext = {
  slug: string;
  /** The viewer's username: a mention of them stands out more. */
  me: string | null;
  /** Handles of the workspace's agents: their mentions go to the agent. */
  agents: ReadonlySet<string>;
  /** Channels by name, for `#name`. */
  channels: ReadonlySet<string>;
  /** The project `#123` means when no repository is named, if any. */
  project: string | null;
  /** Where a link into Code goes instead, for a member without Code access. */
  codeLink?: (href: string) => string;
};

const PILL = "rounded-[4px] px-1 py-px font-medium";

function SpanView({ span, context }: { span: Span; context: TextContext }): ReactNode {
  switch (span.t) {
    case "text":
      return span.v;
    case "code":
      return <code className="rounded-[4px] border border-line bg-raised px-1 py-px font-mono text-[0.84em] text-fg-soft">{span.v}</code>;
    case "strong":
      return <strong className="font-semibold text-fg">{spans(span.c, context)}</strong>;
    case "em":
      return <em>{spans(span.c, context)}</em>;
    case "del":
      return <del className="text-muted">{spans(span.c, context)}</del>;
    case "link": {
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
      const agent = context.agents.has(name);
      const to = agent ? `/${context.slug}/-/agents/${name}` : name.includes("/") ? `/${context.slug}/-/teams/${name.split("/")[1]}` : `/u/${name}`;
      return (
        <Link
          to={to}
          className={`${PILL} transition-colors ${
            self ? "bg-warn/20 text-warn hover:bg-warn/30" : "bg-accent/15 text-accent hover:bg-accent/25"
          }`}
        >
          @{span.name}
        </Link>
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

function BlockView({ block, context }: { block: Block; context: TextContext }) {
  switch (block.t) {
    case "p":
      return <p>{lines(block.lines, context)}</p>;
    case "code":
      return (
        <pre className="my-1 overflow-x-auto rounded-md border border-line bg-bg px-3 py-2 font-mono text-[0.8125rem] leading-relaxed text-fg-soft [scrollbar-width:thin]">
          <code>{block.v}</code>
        </pre>
      );
    case "list": {
      const Tag = block.ordered ? "ol" : "ul";
      return (
        <Tag className={`my-0.5 space-y-0.5 pl-5 ${block.ordered ? "list-decimal" : "list-disc"} marker:text-faint`}>
          {block.items.map((item, index) => (
            <li key={index}>{spans(item, context)}</li>
          ))}
        </Tag>
      );
    }
    case "quote":
      return <blockquote className="border-l-2 border-line-strong pl-3 text-muted">{lines(block.lines, context)}</blockquote>;
  }
}

/** A message's text, rendered from parsed blocks: never as HTML. */
export function MessageText({ body, context }: { body: string; context: TextContext }) {
  const parsed = useMemo(() => blocks(body), [body]);
  if (onlyEmoji(body)) return <p className="text-3xl leading-tight">{body.trim()}</p>;
  return (
    <div className="space-y-1.5 text-[0.9375rem] leading-[1.55] break-words text-fg-soft">
      {parsed.map((block, index) => (
        <BlockView key={index} block={block} context={context} />
      ))}
    </div>
  );
}
