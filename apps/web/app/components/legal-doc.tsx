/**
 * The renderer for the policies, which are written in Markdown under
 * app/content/policies so that counsel can read and mark them up as plain
 * text. The frame of a trust page is in trust-page.tsx.
 */
import { type ReactNode, isValidElement } from "react";
import ReactMarkdown from "react-markdown";
import { Link } from "react-router";
import remarkGfm from "remark-gfm";

function textOf(node: ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (isValidElement<{ children?: ReactNode }>(node)) return textOf(node.props.children);
  return "";
}

/** A heading's anchor: "8. Paying for g1t" is `paying-for-g1t`. */
export function anchor(children: ReactNode): string {
  return textOf(children)
    .toLowerCase()
    .replace(/^\d+\.\s*/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/** The headings of a policy, for its contents list. */
export function outline(markdown: string): { id: string; title: string }[] {
  return [...markdown.matchAll(/^## (.+)$/gm)].map((match) => ({ id: anchor(match[1]), title: match[1] }));
}

export { TrustPage } from "./trust-page";

/** A Markdown policy. Links to g1t stay in the app; others are plain. */
export function PolicyText({ source }: { source: string }) {
  return (
    <div className="prose max-w-3xl">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h2: ({ children }) => (
            <h2 id={anchor(children)} className="scroll-mt-20">
              {children}
            </h2>
          ),
          h3: ({ children }) => (
            <h3 id={anchor(children)} className="scroll-mt-20">
              {children}
            </h3>
          ),
          a: ({ href = "", children }) =>
            href.startsWith("/") ? <Link to={href}>{children}</Link> : <a href={href}>{children}</a>,
          table: ({ children }) => (
            <div className="overflow-x-auto">
              <table>{children}</table>
            </div>
          ),
        }}
      >
        {source}
      </ReactMarkdown>
    </div>
  );
}

/** "On this page", for the side of a long page. */
export function Contents({ items }: { items: { id: string; title: string }[] }) {
  if (items.length < 3) return null;
  return (
    <nav aria-label="On this page" className="lg:sticky lg:top-20">
      <p className="text-xs font-medium tracking-wider text-faint uppercase">On this page</p>
      <ol className="mt-3 space-y-1.5 border-l border-line text-sm">
        {items.map((item) => (
          <li key={item.id}>
            <a href={`#${item.id}`} className="-ml-px block border-l border-transparent pl-3 text-muted hover:border-line-strong hover:text-fg">
              {item.title.replace(/^\d+\.\s*/, "")}
            </a>
          </li>
        ))}
      </ol>
    </nav>
  );
}
