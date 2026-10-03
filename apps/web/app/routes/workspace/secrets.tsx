import type { Route } from "./+types/secrets";
import { SecretsPanel } from "../../components/secrets";
import { actOnSecrets, loadSecrets } from "../../lib/secrets.server";
import { assertSameOrigin, getViewer, requireUser, roleIn } from "../../lib/session.server";

export function meta({ params }: Route.MetaArgs) {
  return [{ title: `Secrets and variables · ${params.owner} · g1t` }];
}

export async function loader({ params, context, request }: Route.LoaderArgs) {
  const role = roleIn(getViewer(context), params.owner);
  if (!role) throw new Response(null, { status: 404 });
  return { role, ...(await loadSecrets({ workspace: params.owner.toLowerCase() }, requireUser(context, request))) };
}

export async function action({ request, params, context }: Route.ActionArgs) {
  assertSameOrigin(request);
  const user = requireUser(context, request);
  return actOnSecrets({ workspace: params.owner.toLowerCase() }, user, await request.formData());
}

export default function WorkspaceSecrets({ loaderData, actionData }: Route.ComponentProps) {
  const { role, ...data } = loaderData;
  // Every repository reads a workspace's, so only its owners change them.
  return <SecretsPanel data={data} action={actionData} scope="workspace" manage={role === "owner"} />;
}
