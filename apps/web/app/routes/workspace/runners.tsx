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
  const role = roleIn(getViewer(context), params.owner);
  if (!role) throw new Response(null, { status: 404 });
  const user = requireUser(context, request);
  const workspace = params.owner.toLowerCase();
  // Members see the runners; owners add, remove and group them.
  const names = role === "owner" ? (await repos.list(user, { namespace: workspace })).map((repo) => repo.name) : [];
  return { role, ...(await loadRunners({ workspace }, user, names)) };
}

export async function action({ request, params, context }: Route.ActionArgs) {
  assertSameOrigin(request);
  const user = requireUser(context, request);
  return actOnRunners({ workspace: params.owner.toLowerCase() }, user, await request.formData());
}

export default function WorkspaceRunners({ loaderData, actionData }: Route.ComponentProps) {
  const { role, ...data } = loaderData;
  return <RunnersPanel data={data} action={actionData} scope="workspace" manage={role === "owner"} />;
}
