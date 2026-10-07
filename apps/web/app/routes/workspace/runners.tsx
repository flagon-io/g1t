import type { Route } from "./+types/runners";
import { page } from "../../lib/meta";
import { RunnersPanel } from "../../components/runners";
import { actOnRunners, loadRunners } from "../../lib/runners.server";
import { repos } from "../../lib/services.server";
import { assertSameOrigin, getViewer, requireUser, roleIn } from "../../lib/session.server";

export function meta({ params, ...args }: Route.MetaArgs) {
  return page(args, { title: `Runners · ${params.owner} · g1t` });
}

export async function loader({ params, context, request }: Route.LoaderArgs) {
  // The workspace's own machines and their tokens: owners only.
  if (roleIn(getViewer(context), params.owner) !== "owner") throw new Response(null, { status: 404 });
  const user = requireUser(context, request);
  const workspace = params.owner.toLowerCase();
  const names = (await repos.list(user, { namespace: workspace })).map((repo) => repo.name);
  return loadRunners({ workspace }, user, names);
}

export async function action({ request, params, context }: Route.ActionArgs) {
  assertSameOrigin(request);
  if (roleIn(getViewer(context), params.owner) !== "owner") throw new Response(null, { status: 404 });
  const user = requireUser(context, request);
  return actOnRunners({ workspace: params.owner.toLowerCase() }, user, await request.formData());
}

export default function WorkspaceRunners({ loaderData, actionData }: Route.ComponentProps) {
  return <RunnersPanel data={loaderData} action={actionData} scope="workspace" manage />;
}
