/**
 * "Set up a security policy": commits a SECURITY.md on a new branch as the
 * person asking and opens it as their pull request, then goes to it, as
 * "Set up code scanning" does with its workflow. It adds a file to the
 * repository: Push.
 */
import { redirect } from "react-router";

import type { Route } from "./+types/security-policy-setup";
import { refusal, requireWritableRepo } from "../../lib/access.server";
import { securityPolicyBranch, securityPolicyPullBody, securityPolicyTemplate } from "../../lib/security-overview";
import { advisories, repos, work } from "../../lib/services.server";
import { assertSameOrigin, requireUser } from "../../lib/session.server";

export async function action({ request, params, context }: Route.ActionArgs) {
  assertSameOrigin(request);
  const user = requireUser(context, request);
  await requireWritableRepo(context, params);
  const refused = await refusal(context, params, "push");
  if (refused) return { error: refused };
  const path = { namespace: params.owner, name: params.repo };
  const base = `/${params.owner}/${params.repo}`;
  const [branches, reporting] = await Promise.all([repos.branches(path, user), advisories.reportSettings(path, user)]);
  const branch = securityPolicyBranch(branches.ok ? branches.value.map((known) => known.name) : []);
  const committed = await repos.commitFile(path, user, {
    branch,
    path: "SECURITY.md",
    content: securityPolicyTemplate(`${params.owner}/${params.repo}`, reporting.ok && reporting.value.privateVulnerabilityReporting, base),
    message: "Add a security policy",
  });
  if (!committed.ok) return { error: committed.error.message };
  const opened = await work.openPull(user, path, {
    branch,
    title: "Add a security policy",
    body: securityPolicyPullBody("SECURITY.md"),
    agent: user.username,
    runtime: "external",
  });
  if (!opened.ok) return { error: opened.error.message };
  throw redirect(`${base}/pull/${opened.value.number}`);
}

export async function loader({ params }: Route.LoaderArgs) {
  throw redirect(`/${params.owner}/${params.repo}/security`);
}
