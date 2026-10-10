import type { Route } from "./+types/runners";
import { page } from "../../lib/meta";
import { RunnersPage } from "../../components/runners-page";
import { actOnRunners, loadRunnersPage } from "../../lib/runners.server";
import { repos } from "../../lib/services.server";
import { assertSameOrigin, getViewer, requireUser, roleIn } from "../../lib/session.server";

export function meta({ params, ...args }: Route.MetaArgs) {
  return page(args, { title: `Runners · ${params.owner} · g1t` });
}

/**
 * Runners, in Workspace mode: the machines the workspace's agents and
 * workflow jobs run on, g1t's cloud and its own side by side, with what
 * each is running, this month's time and how to add one. The workspace's
 * machines and their tokens are its owners'.
 */
export async function loader({ params, context, request }: Route.LoaderArgs) {
  if (roleIn(getViewer(context), params.owner) !== "owner") throw new Response(null, { status: 404 });
  const user = requireUser(context, request);
  const workspace = params.owner.toLowerCase();
  // One round: the repositories (for choosing a group's) beside everything else.
  const [list, data] = await Promise.all([repos.list(user, { namespace: workspace }), loadRunnersPage(workspace, user)]);
  return { slug: workspace, ...data, repositories: list.map((repo) => repo.name) };
}

export async function action({ request, params, context }: Route.ActionArgs) {
  assertSameOrigin(request);
  if (roleIn(getViewer(context), params.owner) !== "owner") throw new Response(null, { status: 404 });
  const user = requireUser(context, request);
  return actOnRunners({ workspace: params.owner.toLowerCase() }, user, await request.formData());
}

export default function WorkspaceRunners({ loaderData, actionData }: Route.ComponentProps) {
  return <RunnersPage data={loaderData} action={actionData} slug={loaderData.slug} />;
}
