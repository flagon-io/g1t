import type { Route } from "./+types/webhooks";
import { WebhooksPanel } from "../../components/webhooks";
import { actOnWebhooks, loadWebhooks } from "../../lib/webhooks.server";
import { assertSameOrigin, getViewer, requireUser, roleIn } from "../../lib/session.server";

export function meta({ params }: Route.MetaArgs) {
  return [{ title: `Webhooks · ${params.owner} · g1t` }];
}

export async function loader({ params, context, request }: Route.LoaderArgs) {
  const viewer = getViewer(context);
  const role = roleIn(viewer, params.owner);
  if (!role) throw new Response(null, { status: 404 });
  const owner = { workspace: params.owner.toLowerCase() };
  return { role, ...(await loadWebhooks(owner, viewer, request)) };
}

export async function action({ request, params, context }: Route.ActionArgs) {
  assertSameOrigin(request);
  const user = requireUser(context, request);
  return actOnWebhooks({ workspace: params.owner.toLowerCase() }, user, await request.formData());
}

export default function WorkspaceWebhooks({ loaderData, actionData, params }: Route.ComponentProps) {
  const { role, ...data } = loaderData;
  return (
    <WebhooksPanel
      data={data}
      action={actionData}
      manage={role === "owner"}
      scope={`every repository in ${params.owner}`}
    />
  );
}
