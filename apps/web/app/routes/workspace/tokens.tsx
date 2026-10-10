import { Plus } from "lucide-react";
import { Link, redirect } from "react-router";

import type { Route } from "./+types/tokens";
import { page } from "../../lib/meta";
import { useAddresses } from "../../lib/addresses";
import { ButtonLink, CopyLine, EmptyState } from "../../components/ui";
import { Card } from "../../components/ui/card";
import { TokenList } from "../../components/token-list";
import { currentTokensPath } from "../../lib/access-tokens";
import { identity } from "../../lib/services.server";
import { getViewer, roleIn, unwrap } from "../../lib/session.server";

// A workspace's own access tokens: they belong to the workspace, act as it,
// and keep working when the member who made one leaves. The same tokens as
// a person's (components/token-form.tsx), owned by the workspace.

export function meta({ params, ...args }: Route.MetaArgs) {
  return page(args, { title: `Access tokens · ${params.owner} · g1t` });
}

export async function loader({ request, params, context }: Route.LoaderArgs) {
  const slug = params.owner.toLowerCase();
  const moved = currentTokensPath(`/${slug}/-/tokens`, new URL(request.url).searchParams);
  if (moved) throw redirect(moved, 301);
  const viewer = getViewer(context);
  return {
    slug,
    role: roleIn(viewer, params.owner),
    tokens: unwrap(await identity.listWorkspaceTokens(params.owner, viewer)),
  };
}

export default function WorkspaceTokens({ loaderData }: Route.ComponentProps) {
  const { slug, role, tokens } = loaderData;
  const { site, api } = useAddresses();
  // With git, the token is the password in the clone address, after the scheme.
  const [scheme, rest] = site.split("://");
  const owner = role === "owner";
  return (
    <div className="grid gap-10 lg:grid-cols-[1fr_20rem]">
      <div className="min-w-0 space-y-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <p className="max-w-lg text-sm text-muted">
            Each token has permissions, a level for each resource, and reaches all of {slug}'s repositories or the ones
            chosen.
          </p>
          {owner && (
            <ButtonLink to={`/${slug}/-/tokens/new`}>
              <Plus size={15} />
              New token
            </ButtonLink>
          )}
        </div>
        {tokens.length === 0 ? (
          <EmptyState title="No access tokens yet">
            {owner ? "Make one and give it to whatever needs to act for this workspace." : "An owner can make one."}
          </EmptyState>
        ) : (
          <TokenList tokens={tokens} href={(token) => `/${slug}/-/tokens/${token.id}`} />
        )}
        {!owner && <p className="text-sm text-muted">Only owners can make, change or delete a workspace's tokens.</p>}
      </div>

      <aside className="space-y-5 text-sm">
        <Card asChild className="p-5">
          <section>
            <h3 className="font-medium">What a token can do</h3>
            <ul className="mt-2 list-disc space-y-1.5 pl-4 text-muted">
              <li>
                What its permissions allow, in this workspace only, with Write on its repositories, as a member: push, open
                and merge pull requests, manage issues. Admin only with Repositories: admin.
              </li>
              <li>
                It acts as <span className="font-mono text-fg">{slug}</span>, so what it does is shown as the workspace's
                doing.
              </li>
              <li>It keeps working when the person who made it leaves.</li>
              <li>It cannot manage people, tokens or other workspaces.</li>
            </ul>
          </section>
        </Card>
        {owner && (
          <Card asChild tone="plain" className="p-5">
            <section>
              <h3 className="font-medium">Your members' own tokens</h3>
              <p className="mt-2 text-muted">
                Which personal tokens may reach {slug}, how long they may last, and approving the ones made for it:{" "}
                <Link to={`/${slug}/-/personal-access-tokens`} className="text-fg underline underline-offset-4">
                  Personal access tokens
                </Link>
                .
              </p>
            </section>
          </Card>
        )}
        <section>
          <h3 className="font-medium">Using one</h3>
          <p className="mt-2 text-muted">With git, as the password:</p>
          <div className="mt-2">
            <CopyLine prompt text={`git clone ${scheme}://${slug}:$G1T_TOKEN@${rest}/${slug}/<repo>.git`} />
          </div>
          <p className="mt-4 text-muted">With the API and the MCP server:</p>
          <div className="mt-2">
            <CopyLine prompt text={`curl -H "Authorization: Bearer $G1T_TOKEN" ${api}/user`} />
          </div>
        </section>
      </aside>
    </div>
  );
}
