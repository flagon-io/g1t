import { Link } from "react-router";

import { connectorsFor } from "@g1t/contracts/connectors";

import type { Route } from "./+types/integrations";
import { ConnectorDirectory } from "../../components/connectors";
import type { ConnectedState } from "../../lib/connectors";
import { githubSignIn } from "../../lib/github.server";
import { page } from "../../lib/meta";
import { identity } from "../../lib/services.server";
import { requireUser } from "../../lib/session.server";
import { Unavailable } from "../../components/boundary";
import { isFailed, part } from "../../lib/partial";

export function meta(args: Route.MetaArgs) {
  return page(args, { title: "Integrations · Settings · g1t" });
}

/**
 * Your own integrations: the connector directory's personal side, with
 * what you have connected (GitHub sign-in, applications on the MCP server).
 * Each is still set up on its own settings page.
 */
export async function loader({ request, context }: Route.LoaderArgs) {
  const user = requireUser(context, request);
  // What is connected marks the directory's tiles; one that could not be
  // read is said above it, so a tile is never shown unconnected when it
  // may well be connected.
  const [github, grants] = await Promise.all([
    part(githubSignIn.account(user), "Your GitHub link"),
    part(identity.listOAuthGrants(user), "Applications on the MCP server"),
  ]);
  const unread = [github, grants].filter(isFailed).map((failed) => failed.what);
  const connected: Record<string, ConnectedState> = {};
  if (!isFailed(github) && github?.account) {
    connected.github = {
      detail: `Linked to @${github.account.login}`,
      problem: github.account.authorized ? null : "Access ended: link it again to import repositories.",
      manage: null,
    };
  }
  if (!isFailed(grants) && grants.length > 0) {
    connected.mcp = {
      detail: grants.length === 1 ? grants[0]!.clientName : `${grants.length} applications`,
      problem: null,
      manage: null,
    };
  }
  const workspaces = (user.workspaces ?? []).map((membership) => ({ slug: membership.slug, name: membership.name ?? membership.slug }));
  return { connected, workspaces, unread };
}

export default function PersonalIntegrations({ loaderData }: Route.ComponentProps) {
  const { connected, workspaces, unread } = loaderData;
  return (
    <div>
      {unread.length > 0 && (
        <div className="mb-4 space-y-1">
          {unread.map((what) => (
            <Unavailable key={what} what={what} compact />
          ))}
        </div>
      )}
      <ConnectorDirectory scope="personal" views={connectorsFor("personal")} connected={connected} workspace={null} canManage nav="chips" />
      {workspaces.length > 0 && (
        <p className="mt-10 border-t border-line pt-5 text-sm text-muted">
          Tools the whole team shares are connected for each workspace:{" "}
          {workspaces.map((workspace, index) => (
            <span key={workspace.slug}>
              {index > 0 && ", "}
              <Link to={`/${workspace.slug}/-/settings/integrations`} className="text-accent hover:underline">
                {workspace.name}
              </Link>
            </span>
          ))}
          .
        </p>
      )}
    </div>
  );
}
