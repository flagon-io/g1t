import type { ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import { Link } from "react-router";
import remarkGfm from "remark-gfm";

/** An anchor id for a heading, so sections can be linked to. */
function slug(children: ReactNode): string {
  const text = Array.isArray(children) ? children.join("") : String(children ?? "");
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * Renders markdown from repositories, briefs and docs. Raw HTML in the
 * source is not rendered, so untrusted content is safe to pass in.
 */
export function Markdown({ source }: { source: string }) {
  return (
    <div className="prose">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h2: ({ children }) => <h2 id={slug(children)}>{children}</h2>,
          h3: ({ children }) => <h3 id={slug(children)}>{children}</h3>,
          a({ href, children }) {
            // In-site links navigate on the client.
            return href?.startsWith("/") ? (
              <Link to={href}>{children}</Link>
            ) : (
              <a href={href} rel="noreferrer nofollow">
                {children}
              </a>
            );
          },
        }}
      >
        {source}
      </ReactMarkdown>
    </div>
  );
}
