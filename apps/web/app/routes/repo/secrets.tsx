import type { Route } from "./+types/secrets";
import { page } from "../../lib/meta";
import { SecretsPanel } from "../../components/secrets";
import { actOnSecrets, loadSecrets } from "../../lib/secrets.server";
import { assertSameOrigin, requireUser } from "../../lib/session.server";
import { requireCapability, requireInsider } from "../../lib/access.server";

export function meta({ params, ...args }: Route.MetaArgs) {
  return page(args, { title: `Environment variables · ${params.owner}/${params.repo} · g1t` });
}

const ownerOf = (params: { owner: string; repo: string }) => ({ repo: { namespace: params.owner, name: params.repo } });

export async function loader({ params, context, request }: Route.LoaderArgs) {
  // Admins; to anyone without a role here the page does not exist.
  await requireInsider(context, params, "manage_integrations");
  return loadSecrets(ownerOf(params), requireUser(context, request));
}

export async function action({ request, params, context }: Route.ActionArgs) {
  assertSameOrigin(request);
  const user = requireUser(context, request);
  await requireCapability(context, params, "manage_integrations");
  const page = `/${params.owner}/${params.repo}/settings/secrets`;
  return actOnSecrets(ownerOf(params), user, await request.formData(), page);
}

export default function RepoSecrets({ loaderData, actionData }: Route.ComponentProps) {
  return (
    <div>
      <SecretsPanel data={loaderData} action={actionData} scope="project" manage />
    </div>
  );
}
