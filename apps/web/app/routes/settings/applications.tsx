import { identity } from "../../lib/services.server";

import type { Route } from "./+types/applications";
import { page } from "../../lib/meta";
import { TimeAgo } from "../../components/ui";
import { DeleteButton } from "../../components/account-settings";
import { assertSameOrigin, requireUser } from "../../lib/session.server";

export function meta(args: Route.MetaArgs) {
  return page(args, { title: "Connected applications · Settings · g1t" });
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const user = requireUser(context, request);
  return { applications: await identity.listOAuthGrants(user) };
}

export async function action({ request, context }: Route.ActionArgs) {
  assertSameOrigin(request);
  const user = requireUser(context, request);
  const form = await request.formData();
  if (form.get("intent") === "sign-out-application") {
    await identity.revokeOAuthGrant(user, String(form.get("id") ?? ""));
  }
  return null;
}

export default function ApplicationSettings({ loaderData }: Route.ComponentProps) {
  const { applications } = loaderData;
  return (
    <section id="applications" className="scroll-mt-20">
      {applications.length === 0 ? (
        <p className="text-sm text-faint">None yet.</p>
      ) : (
        <ul className="divide-y divide-line rounded-md border border-line">
          {applications.map((application) => (
            <li key={application.id} className="flex items-center gap-4 px-4 py-3">
              <div className="min-w-0">
                <p className="truncate text-sm">{application.clientName}</p>
                <p className="text-xs text-faint">
                  Connected <TimeAgo at={application.createdAt} /> · last used <TimeAgo at={application.lastUsedAt} />
                </p>
              </div>
              <DeleteButton intent="sign-out-application" id={application.id} label="Sign out" />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
