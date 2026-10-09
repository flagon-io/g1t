import { Link } from "react-router";

import { connectorsFor } from "@g1t/contracts/connectors";

import type { Route } from "./+types/integrations";
import { ConnectorDirectory } from "../../components/connectors";
import type { ConnectedState } from "../../lib/connectors";
import { githubSignIn } from "../../lib/github.server";
import { page } from "../../lib/meta";
import { identity } from "../../lib/services.server";
import { requireUser } from "../../lib/session.server";

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
  const [github, grants] = await Promise.all([
    githubSignIn.account(user).catch(() => null),
    identity.listOAuthGrants(user).catch(() => []),
  ]);
  const connected: Record<string, ConnectedState> = {};
  if (github?.account) {
    connected.github = {
      detail: `Linked to @${github.account.login}`,
      problem: github.account.authorized ? null : "Access ended: link it again to import repositories.",
      manage: null,
    };
  }
  if (grants.length > 0) {
    connected.mcp = {
      detail: grants.length === 1 ? grants[0]!.clientName : `${grants.length} applications`,
      problem: null,
      manage: null,
    };
  }
  const workspaces = (user.workspaces ?? []).map((membership) => ({ slug: membership.slug, name: membership.name ?? membership.slug }));
  return { connected, workspaces };
}

export default function PersonalIntegrations({ loaderData }: Route.ComponentProps) {
  const { connected, workspaces } = loaderData;
  return (
    <div>
      <ConnectorDirectory
        scope="personal"
        views={connectorsFor("personal")}
        connected={connected}
        workspace={null}
        canManage
        nav="chips"
      />
      {workspaces.length > 0 && (
        <p className="mt-10 border-t border-line pt-5 text-sm text-muted">
          Tools the whole team shares are connected for each workspace:{" "}
          {workspaces.map((workspace, index) => (
            <span key={workspace.slug}>
              {index > 0 && ", "}
              <Link to={`/${workspace.slug}/-/integrations`} className="text-accent hover:underline">
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
