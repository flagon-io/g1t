import { Link, data, redirect } from "react-router";

import type { Route } from "./+types/github-setup";
import { AuthCard } from "../components/auth-card";
import { INSTALL_COOKIE, cookie, installWorkspace, readCookie } from "../lib/github";
import { githubApp } from "../lib/github.server";
import { page } from "../lib/meta";
import { requireUser } from "../lib/session.server";

export function meta(args: Route.MetaArgs) {
  return page(args, { title: "Connecting GitHub · g1t" });
}

/**
 * The app's Setup URL: GitHub returns here after an installation with
 * `installation_id`, `setup_action` and the state. The installation is
 * recorded against the workspace it was started for, after integrations
 * checks with the person's own GitHub token that they can see it.
 */
export async function loader({ request, context }: Route.LoaderArgs) {
  const user = requireUser(context, request);
  const url = new URL(request.url);
  const clear = { "set-cookie": cookie(INSTALL_COOKIE, "", 0) };
  const workspace = installWorkspace(readCookie(request.headers.get("cookie"), INSTALL_COOKIE), url.searchParams.get("state"));
  const action = url.searchParams.get("setup_action");
  const installation = Number(url.searchParams.get("installation_id"));
  // Repositories chosen again on GitHub: nothing to record, the picker
  // lists what the installation can see now.
  if (!workspace && action === "update") throw redirect("/new/github", { headers: clear });
  if (!workspace) {
    return data(
      { error: "This installation did not start from g1t in this browser. Start again from New project.", workspace: null },
      { headers: clear },
    );
  }
  const back = `/new/github?workspace=${encodeURIComponent(workspace)}`;
  // An organization member asked an owner to approve: nothing to record yet.
  if (action === "request") throw redirect(`${back}&requested=1`, { headers: clear });
  if (!Number.isSafeInteger(installation) || installation <= 0) {
    return data({ error: "GitHub did not say which installation was made.", workspace }, { headers: clear });
  }
  const added = await githubApp.addInstallation(user, workspace, installation);
  if (!added.ok) return data({ error: added.error.message, workspace }, { headers: clear });
  throw redirect(`${back}&installation=${installation}`, { headers: clear });
}

export default function GithubSetup({ loaderData }: Route.ComponentProps) {
  return (
    <AuthCard
      title="Connecting GitHub"
      subtitle="That did not work"
      footer={
        <Link
          to={loaderData.workspace ? `/new/github?workspace=${loaderData.workspace}` : "/new"}
          className="text-fg underline underline-offset-4"
        >
          Back to New project
        </Link>
      }
    >
      <p className="text-sm text-danger" role="alert">
        {loaderData.error}
      </p>
    </AuthCard>
  );
}
