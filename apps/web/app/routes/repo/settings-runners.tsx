import type { Route } from "./+types/settings-runners";
import { page } from "../../lib/meta";
import { RepoSettingsHeading } from "../../components/repo-settings-heading";
import { RunnersPanel } from "../../components/runners";
import { actOnRunners, loadRunners } from "../../lib/runners.server";
import { assertSameOrigin, requireUser } from "../../lib/session.server";
import { requireCapability, requireInsider } from "../../lib/access.server";

export function meta({ params, ...args }: Route.MetaArgs) {
  return page(args, { title: `Runners · ${params.owner}/${params.repo} · g1t` });
}

const ownerOf = (params: { owner: string; repo: string }) => ({ repo: { namespace: params.owner, name: params.repo } });

export async function loader({ params, context, request }: Route.LoaderArgs) {
  // Admins; to anyone without a role here the page does not exist.
  await requireInsider(context, params, "manage_integrations");
  return loadRunners(ownerOf(params), requireUser(context, request));
}

export async function action({ request, params, context }: Route.ActionArgs) {
  assertSameOrigin(request);
  const user = requireUser(context, request);
  await requireCapability(context, params, "manage_integrations");
  return actOnRunners(ownerOf(params), user, await request.formData());
}

export default function RepoRunners({ loaderData, actionData, params }: Route.ComponentProps) {
  return (
    <div>
      <RepoSettingsHeading base={`/${params.owner}/${params.repo}`} />
      <RunnersPanel data={loaderData} action={actionData} scope="project" manage />
    </div>
  );
}
