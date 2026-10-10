import { Form, Link, data, redirect } from "react-router";

import type { Route } from "./+types/github-setup";
import { AuthCard } from "../components/auth-card";
import { GithubMark } from "../components/github";
import { ErrorText, SubmitButton } from "../components/ui";
import { INSTALL_COOKIE, cookie, installWorkspace, installationSummary, readCookie, setupChoices } from "../lib/github";
import { githubApp } from "../lib/github.server";
import { page } from "../lib/meta";
import { assertSameOrigin, requireUser, roleIn } from "../lib/session.server";

export function meta(args: Route.MetaArgs) {
  return page(args, { title: "Connecting GitHub · g1t" });
}

type Problem = { kind: "error"; error: string; workspace: string | null; link: string | null };
type Choice = {
  kind: "choose";
  installation: { id: number; account: string; summary: string };
  workspaces: { slug: string; name: string; added: boolean }[];
};

/**
 * The app's Setup URL: GitHub returns here after an installation with
 * `installation_id`, `setup_action` and the state. The installation is
 * recorded against the workspace it was started for, after integrations
 * checks with the person's own GitHub token that they can see it.
 *
 * Without g1t's state (the app was installed on GitHub directly, from
 * another browser, or the cookie was lost), the person chooses which of
 * the workspaces they own to add it to, checked the same way.
 */
export async function loader({ request, context }: Route.LoaderArgs) {
  const user = requireUser(context, request);
  const url = new URL(request.url);
  const clear = { "set-cookie": cookie(INSTALL_COOKIE, "", 0) };
  const workspace = installWorkspace(readCookie(request.headers.get("cookie"), INSTALL_COOKIE), url.searchParams.get("state"));
  const action = url.searchParams.get("setup_action");
  const installation = Number(url.searchParams.get("installation_id"));
  const problem = (error: string, at: string | null = workspace, link: string | null = null) =>
    data<Problem | Choice>({ kind: "error", error, workspace: at, link }, { headers: clear });
  // Repositories chosen again on GitHub: nothing to record, the picker
  // lists what the installation can see now.
  if (!workspace && action === "update") throw redirect("/new/github", { headers: clear });
  // An organization member asked an owner to approve: nothing to record yet.
  if (action === "request") {
    const back = workspace ? `/new/github?workspace=${encodeURIComponent(workspace)}&` : "/new/github?";
    throw redirect(`${back}requested=1`, { headers: clear });
  }
  if (!Number.isSafeInteger(installation) || installation <= 0) {
    return problem("GitHub did not say which installation was made.");
  }
  if (workspace) {
    const added = await githubApp.addInstallation(user, workspace, installation);
    if (!added.ok) return problem(added.error.message);
    throw redirect(`/new/github?workspace=${encodeURIComponent(workspace)}&installation=${installation}`, { headers: clear });
  }
  const owned = (user.workspaces ?? []).filter((membership) => membership.role === "owner");
  if (owned.length === 0) {
    return problem("Only a workspace owner can add a GitHub account. Ask an owner of your workspace to add it from Import from GitHub.", null);
  }
  const visible = await githubApp.visibleInstallations(user);
  if (!visible.ok) {
    // GitHub not linked, or its access ended: link it and come back here.
    const unlinked = visible.error.code === "not_found" || visible.error.code === "unauthenticated";
    const here = `${url.pathname}${url.search}`;
    return problem(visible.error.message, null, unlinked ? `/auth/github?link=1&next=${encodeURIComponent(here)}` : null);
  }
  const found = visible.value.find((item) => item.id === installation);
  if (!found) {
    return problem(
      "Your GitHub account cannot see that installation. Install the app from your own GitHub account or an organization you manage.",
      null,
    );
  }
  return data<Problem | Choice>(
    {
      kind: "choose",
      installation: { id: found.id, account: found.account, summary: installationSummary(found) },
      workspaces: setupChoices(owned, found),
    },
    { headers: clear },
  );
}

export async function action({ request, context }: Route.ActionArgs) {
  assertSameOrigin(request);
  const user = requireUser(context, request);
  const form = await request.formData();
  const workspace = String(form.get("workspace") ?? "").toLowerCase();
  const installation = Number(form.get("installation"));
  if (roleIn(user, workspace) !== "owner") return { error: "Only an owner of the workspace can add GitHub accounts to it." };
  if (!Number.isSafeInteger(installation) || installation <= 0) return { error: "Choose an installation to add." };
  const added = await githubApp.addInstallation(user, workspace, installation);
  if (!added.ok) return { error: added.error.message };
  throw redirect(`/new/github?workspace=${encodeURIComponent(workspace)}&installation=${installation}`);
}

export default function GithubSetup({ loaderData, actionData }: Route.ComponentProps) {
  if (loaderData.kind === "choose") {
    const { installation, workspaces } = loaderData;
    return (
      <AuthCard
        title="Add a GitHub account"
        subtitle={`Add the installation on ${installation.account} to which workspace?`}
        footer={
          <Link to="/new/github" className="text-fg underline underline-offset-4">
            Not now
          </Link>
        }
      >
        <div className="flex items-center gap-3 rounded-md border border-line px-4 py-3">
          <GithubMark className="size-5 shrink-0" />
          <div className="min-w-0">
            <p className="truncate font-mono text-sm">{installation.account}</p>
            <p className="text-xs text-faint">{installation.summary}</p>
          </div>
        </div>
        <ul className="mt-4 divide-y divide-line rounded-md border border-line">
          {workspaces.map((option) => (
            <li key={option.slug} className="flex items-center gap-3 px-4 py-2.5">
              <div className="min-w-0">
                <p className="truncate text-sm">{option.name}</p>
                {option.name !== option.slug && <p className="truncate font-mono text-xs text-faint">{option.slug}</p>}
              </div>
              <span className="ml-auto shrink-0">
                {option.added ? (
                  <Link to={`/new/github?workspace=${option.slug}&installation=${installation.id}`} className="text-sm text-muted hover:text-fg">
                    Added · Open
                  </Link>
                ) : (
                  <Form method="post">
                    <input type="hidden" name="installation" value={installation.id} />
                    <SubmitButton name="workspace" value={option.slug} pending="Adding…">
                      Add
                    </SubmitButton>
                  </Form>
                )}
              </span>
            </li>
          ))}
        </ul>
        <ErrorText>{actionData?.error}</ErrorText>
      </AuthCard>
    );
  }
  return (
    <AuthCard
      title="Connecting GitHub"
      subtitle="That did not work"
      footer={
        <Link
          to={loaderData.workspace ? `/new/github?workspace=${loaderData.workspace}` : "/new/github"}
          className="text-fg underline underline-offset-4"
        >
          Back to Import from GitHub
        </Link>
      }
    >
      <p className="text-sm text-danger" role="alert">
        {loaderData.error}
      </p>
      {loaderData.link && (
        <a
          href={loaderData.link}
          className="mt-4 inline-flex w-full items-center justify-center gap-2 rounded-md bg-fg px-3.5 py-2 text-sm font-medium text-bg hover:bg-fg-hover"
        >
          <GithubMark /> Link your GitHub account
        </a>
      )}
    </AuthCard>
  );
}
