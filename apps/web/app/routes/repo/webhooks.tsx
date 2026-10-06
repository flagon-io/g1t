import type { Route } from "./+types/webhooks";
import { page } from "../../lib/meta";
import { RepoSettingsHeading } from "../../components/repo-settings-heading";
import { WebhooksPanel } from "../../components/webhooks";
import { actOnWebhooks, loadWebhooks } from "../../lib/webhooks.server";
import { assertSameOrigin, getViewer, requireUser } from "../../lib/session.server";
import { requireCapability, requireInsider } from "../../lib/access.server";

export function meta({ params, ...args }: Route.MetaArgs) {
  return page(args, { title: `Webhooks · ${params.owner}/${params.repo} · g1t` });
}

function ownerOf(params: { owner: string; repo: string }) {
  return { workspace: params.owner.toLowerCase(), repo: { namespace: params.owner, name: params.repo } };
}

export async function loader({ params, context, request }: Route.LoaderArgs) {
  const viewer = getViewer(context);
  // Admins; to anyone without a role here the page does not exist.
  await requireInsider(context, params, "manage_integrations");
  return loadWebhooks(ownerOf(params), viewer, request);
}

export async function action({ request, params, context }: Route.ActionArgs) {
  assertSameOrigin(request);
  const user = requireUser(context, request);
  await requireCapability(context, params, "manage_integrations");
  return actOnWebhooks(ownerOf(params), user, await request.formData());
}

export default function RepoWebhooks({ loaderData, actionData, params }: Route.ComponentProps) {
  return (
    <div>
      <RepoSettingsHeading base={`/${params.owner}/${params.repo}`} />
      <WebhooksPanel data={loaderData} action={actionData} manage scope={`${params.owner}/${params.repo}`} />
    </div>
  );
}
