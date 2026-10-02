import ReactMarkdown from "react-markdown";
import { Link } from "react-router";
import remarkGfm from "remark-gfm";

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
