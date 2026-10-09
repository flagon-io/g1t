import { Plus } from "lucide-react";
import { Link, redirect } from "react-router";

import type { Route } from "./+types/tokens";
import { page } from "../../lib/meta";
import { ButtonLink, EmptyState } from "../../components/ui";
import { TokenList } from "../../components/token-list";
import { currentTokensPath } from "../../lib/access-tokens";
import { identity } from "../../lib/services.server";
import { requireUser } from "../../lib/session.server";

// Your access tokens: one list, each a link to its page. Tokens used to
// come in two kinds, on two tabs (`?tab=classic`, `?edit=<id>`); those
// addresses lead here and to a token's page now.

export function meta(args: Route.MetaArgs) {
  return page(args, { title: "Access tokens · Settings · g1t" });
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const moved = currentTokensPath("/settings/tokens", url.searchParams);
  if (moved) throw redirect(moved, 301);
  const user = requireUser(context, request);
  const tokens = await identity.listAccessTokens(user);
  return { tokens, workspaces: (user.workspaces ?? []).map((membership) => membership.slug) };
}

export default function TokenSettings({ loaderData }: Route.ComponentProps) {
  const { tokens, workspaces } = loaderData;
  return (
    <section className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="max-w-lg text-sm text-muted">
          Each token has permissions, a level for each resource, and reaches all your workspaces, one of them, or only your
          account. It never does more than you can.
        </p>
        <ButtonLink to="/settings/tokens/new">
          <Plus size={15} />
          New token
        </ButtonLink>
      </div>
      {tokens.length === 0 ? (
        <EmptyState title="No access tokens yet">
          Make one for git over HTTPS, the API, the MCP server or an agent.
        </EmptyState>
      ) : (
        <TokenList tokens={tokens} href={(token) => `/settings/tokens/${token.id}`} />
      )}
      {workspaces.length > 0 && (
        <p className="text-xs text-faint">
          For CI and integrations that work for a team, use a workspace's own tokens, which keep working when you leave:{" "}
          {workspaces.map((slug, i) => (
            <span key={slug}>
              {i > 0 && ", "}
              <Link to={`/${slug}/-/tokens`} className="font-mono text-muted underline underline-offset-4 hover:text-fg">
                {slug}
              </Link>
            </span>
          ))}
          .
        </p>
      )}
    </section>
  );
}
