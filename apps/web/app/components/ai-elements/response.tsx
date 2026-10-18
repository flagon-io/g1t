/**
 * AI Elements' MessageResponse (registry.ai-sdk.dev/message.json): g1t's
 * answers drawn with Streamdown, which keeps half-written Markdown readable
 * while it streams (an open code fence, a table still coming, a link
 * without its end). One renderer for every place g1t answers: the top
 * bar's Ask and its direct message in Chat.
 *
 * What g1t adds: work items, pull requests and commits as chips with their
 * card on hover (`owner/repo#12`, `#12` in the page's repository or the workspace, a hash,
 * a link to one, a full link to this site), people as their card, code in
 * chat's own block (highlighted, with its language and Copy), tables that
 * scroll inside the message, and task lists. Raw HTML is never drawn, and
 * images come only from this site and its usercontent origin: anything
 * else is shown as a link, so an answer can never load a stranger's
 * address on its own.
 */
import { Check, Image as ImageIcon } from "lucide-react";
import { type ComponentProps, type ReactNode, isValidElement, memo, useMemo } from "react";
import { Link } from "react-router";
import { Streamdown, defaultRehypePlugins, type Components } from "streamdown";
import type { PluggableList } from "unified";

import { cn } from "../../lib/cn";
import { useAddresses } from "../../lib/addresses";
import { refTarget } from "../../lib/g1t-chat";
import { type MarkdownRepo, rehypeReferences } from "../../lib/markdown-plugins";
import { CodeBlock } from "../chat/text";
import { MemberCard } from "../chat/profile-card";
import { CommitChip, PageChip, RefChip } from "../chat/ref-chip";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../ui/table";

/** The text inside a React tree: a code block's source. */
function textOf(node: ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (isValidElement<{ children?: ReactNode }>(node)) return textOf(node.props.children);
  return "";
}

export type ResponseContext = {
  /** The workspace: where reference cards are asked for. */
  slug: string;
  /** The repository a bare `#12` or a hash means, from the page asked about. */
  repo?: MarkdownRepo | null;
};

function components(context: ResponseContext, origin: string, usercontent: string): Components {
  return {
    a: ({ href = "", children, node: _node, ...props }) => {
      const ref = (props as Record<string, unknown>)["data-ref"];
      if (ref === "mention") {
        const name = textOf(children).replace(/^@/, "").toLowerCase();
        if (name === "g1t") return <span className="font-medium text-accent">@g1t</span>;
        return (
          <MemberCard member={{ kind: "user", name }} className="inline rounded-sm bg-accent/15 px-1 py-px font-medium text-accent hover:bg-accent/25">
            @{name}
          </MemberCard>
        );
      }
      const target = refTarget(href, origin);
      if (target?.kind === "item" || target?.kind === "pull" || target?.kind === "ref") {
        const label = textOf(children);
        const where = target.kind === "item" ? target.workspace : target.repo;
        // A bare link (its text is the address) shows as the reference it is.
        const shown = /^https?:\/\/|^\//.test(label) ? `${where}#${target.number}` : children;
        const [namespace = "", name = ""] = where.split("/");
        const scope = target.kind === "item" ? { workspace: target.workspace } : { repo: { namespace, name } };
        return <RefChip slug={context.slug} scope={scope} number={target.number} to={target.href} label={shown} kind={target.kind === "ref" ? undefined : target.kind} />;
      }
      if (target?.kind === "commit") return <CommitChip href={target.href} sha={target.sha} />;
      if (target?.kind === "page") {
        const label = textOf(children);
        if (/^https?:\/\//.test(label)) return <PageChip href={target.href}>{target.href}</PageChip>;
        return (
          <Link to={target.href} className="text-accent underline-offset-2 hover:underline">
            {children}
          </Link>
        );
      }
      return (
        <a href={href} target="_blank" rel="noopener noreferrer nofollow ugc" className="text-accent underline-offset-2 hover:underline">
          {children}
        </a>
      );
    },
    code: ({ className, children, node }) => {
      const language = /language-([\w+#.-]+)/.exec(className ?? "")?.[1] ?? null;
      // ```ts title="collaborators.ts": the file it is, over the code.
      const meta = String(node?.properties?.metastring ?? "");
      const title = /title=["']([^"']+)["']/.exec(meta)?.[1] ?? null;
      return <CodeBlock language={language} code={textOf(children).replace(/\n$/, "")} title={title} bar />;
    },
    // Streamdown's own `pre` marks the code inside it as a block, which is what sends it to `code` above.
    inlineCode: ({ children }) => <code className="rounded-sm border border-line bg-raised px-1 py-px font-mono text-[0.84em] text-fg-soft">{children}</code>,
    img: ({ src, alt }) => {
      const address = typeof src === "string" ? src : "";
      const ours = (address.startsWith("/") && !address.startsWith("//")) || address.startsWith(`${usercontent}/`) || address.startsWith(`${origin}/`);
      if (ours) return <img src={address} alt={alt ?? ""} loading="lazy" className="my-1 max-h-96 max-w-full rounded-lg border border-line" />;
      return (
        <a href={address} target="_blank" rel="noopener noreferrer nofollow ugc" className="inline-flex items-center gap-1 text-accent underline-offset-2 hover:underline">
          <ImageIcon size={13} />
          {alt || "Image"}
        </a>
      );
    },
    table: ({ children }) => (
      <Table frameProps={{ role: "region", "aria-label": "Table", tabIndex: 0, className: "my-2 rounded-lg border border-line" }} className="min-w-max text-[0.8125rem] leading-snug sm:min-w-full">
        {children}
      </Table>
    ),
    thead: ({ children }) => <TableHeader>{children}</TableHeader>,
    tbody: ({ children }) => <TableBody>{children}</TableBody>,
    tr: ({ children }) => <TableRow>{children}</TableRow>,
    th: ({ children, style }) => (
      <TableHead scope="col" style={style}>
        {children}
      </TableHead>
    ),
    td: ({ children, style }) => (
      <TableCell style={style} className="max-w-lg">
        {children}
      </TableCell>
    ),
    // Chat, not a document: headings are bold lines with room above them, the top two a touch larger.
    h1: ({ children }) => <p className="pt-2 text-base font-semibold text-fg first:pt-0">{children}</p>,
    h2: ({ children }) => <p className="pt-2 text-base font-semibold text-fg first:pt-0">{children}</p>,
    h3: ({ children }) => <p className="pt-1.5 font-semibold text-fg first:pt-0">{children}</p>,
    h4: ({ children }) => <p className="pt-1.5 font-semibold text-fg first:pt-0">{children}</p>,
    h5: ({ children }) => <p className="pt-1 font-semibold text-fg first:pt-0">{children}</p>,
    h6: ({ children }) => <p className="pt-1 font-semibold text-fg first:pt-0">{children}</p>,
    p: ({ children }) => <p>{children}</p>,
    strong: ({ children }) => <strong className="font-semibold text-fg">{children}</strong>,
    ul: ({ children, className }) => <ul className={cn("space-y-1 pl-5 marker:text-faint", className?.includes("contains-task-list") ? "list-none pl-1" : "list-disc")}>{children}</ul>,
    ol: ({ children, start }) => (
      <ol start={start} className="list-decimal space-y-1 pl-5 marker:text-faint">
        {children}
      </ol>
    ),
    li: ({ children }) => <li className="pl-0.5 [&>ol]:mt-1 [&>ul]:mt-1">{children}</li>,
    blockquote: ({ children }) => <blockquote className="border-l-2 border-line-strong pl-3 text-muted">{children}</blockquote>,
    hr: () => <hr className="my-3 border-line" />,
    input: ({ checked, type }) =>
      type === "checkbox" ? (
        <span aria-label={checked ? "Done" : "Not done"} className={cn("mr-1.5 inline-flex size-3.5 translate-y-0.5 items-center justify-center rounded-sm border", checked ? "border-accent bg-accent text-bg" : "border-line-strong")}>
          {checked && <Check size={10} strokeWidth={3} />}
        </span>
      ) : null,
  };
}

type ResponseProps = Omit<ComponentProps<typeof Streamdown>, "components" | "children"> & {
  children: string;
  context: ResponseContext;
  /** Still being written: half-written Markdown is finished off as it shows, and a caret follows the words. */
  streaming?: boolean;
};

/** An answer from g1t, drawn as it streams and once it is done. */
export const MessageResponse = memo(
  function MessageResponse({ children, context, streaming = false, className, ...props }: ResponseProps) {
    const { site, usercontent } = useAddresses();
    const origin = useMemo(() => {
      try {
        return new URL(site).origin;
      } catch {
        return "";
      }
    }, [site]);
    const drawn = useMemo(() => components(context, origin, usercontent), [context, origin, usercontent]);
    const rehype = useMemo<PluggableList>(() => [...Object.values(defaultRehypePlugins), [rehypeReferences, { repo: context.repo ?? undefined, workspace: context.slug }]], [context.repo, context.slug]);
    return (
      <Streamdown
        mode={streaming ? "streaming" : "static"}
        isAnimating={streaming}
        caret={streaming ? "block" : undefined}
        parseIncompleteMarkdown
        skipHtml
        controls={false}
        linkSafety={{ enabled: false }}
        components={drawn}
        rehypePlugins={rehype}
        className={cn("space-y-2.5 text-[0.9375rem] leading-[1.6] wrap-break-word text-fg-soft", className)}
        {...props}
      >
        {children}
      </Streamdown>
    );
  },
  (before, after) => before.children === after.children && before.streaming === after.streaming && before.context === after.context,
);
