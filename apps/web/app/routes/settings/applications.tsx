import { identity } from "../../lib/services.server";
import { Form, redirect, useSearchParams } from "react-router";

import type { Route } from "./+types/applications";
import { page } from "../../lib/meta";
import { ButtonLink, ErrorText, SubmitButton, TimeAgo } from "../../components/ui";
import { DeleteButton } from "../../components/account-settings";
import { AccessSummary, ScopeChecklist } from "../../components/token-scopes";
import { grantFromForm } from "../../lib/token-scopes";
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
  const id = String(form.get("id") ?? "");
  switch (form.get("intent")) {
    case "sign-out-application":
      await identity.revokeOAuthGrant(user, id);
      return null;
    case "update-application": {
      const grant = grantFromForm(form);
      if (!grant.ok) return { editing: id, error: grant.error };
      const updated = await identity.updateOAuthGrant(user, id, grant.value);
      if (!updated.ok) return { editing: id, error: updated.error.message };
      throw redirect("/settings/applications");
    }
  }
  return null;
}

export default function ApplicationSettings({ loaderData, actionData }: Route.ComponentProps) {
  const { applications } = loaderData;
  const [params] = useSearchParams();
  const editing = actionData?.editing ?? params.get("edit");
  return (
    <section id="applications" className="scroll-mt-20">
      {applications.length === 0 ? (
        <p className="text-sm text-faint">None yet.</p>
      ) : (
        <ul className="divide-y divide-line rounded-md border border-line">
          {applications.map((application) => {
            const legacy = application.legacy && application.scopes === null;
            const open = editing === application.id;
            return (
              <li key={application.id} className="px-4 py-3">
                <div className="flex flex-wrap items-start gap-x-4 gap-y-2">
                  <div className="min-w-0 grow basis-60">
                    <p className="truncate text-sm font-medium">{application.clientName}</p>
                    <p className="text-xs text-faint">
                      Connected <TimeAgo at={application.createdAt} /> · last used{" "}
                      <TimeAgo at={application.lastUsedAt} />
                    </p>
                    <AccessSummary holder={application} />
                    {legacy && (
                      <p className="mt-1.5 text-xs text-warn">
                        Signed in before applications asked for scopes, so it can do everything you can.
                        Narrow it to what it needs.
                      </p>
                    )}
                  </div>
                  <div className="ml-auto flex shrink-0 items-center gap-2">
                    {!open && (
                      <ButtonLink variant="quiet" to={`?edit=${application.id}`} preventScrollReset>
                        Change access
                      </ButtonLink>
                    )}
                    <DeleteButton intent="sign-out-application" id={application.id} label="Sign out" pending="Signing out…" />
                  </div>
                </div>
                {open && (
                  <Form method="post" className="mt-4 space-y-5 border-t border-line pt-4">
                    <input type="hidden" name="intent" value="update-application" />
                    <input type="hidden" name="id" value={application.id} />
                    <p className="text-sm text-muted">
                      {application.clientName} stays signed in. What it may do changes at once, and its
                      next refresh keeps the change.
                    </p>
                    <ScopeChecklist initial={application.scopes} />
                    {actionData?.editing === application.id && <ErrorText>{actionData.error}</ErrorText>}
                    <div className="flex gap-2">
                      <SubmitButton pending="Saving…" match={{ intent: "update-application", id: application.id }}>
                        Save access
                      </SubmitButton>
                      <ButtonLink variant="quiet" to="." preventScrollReset>
                        Cancel
                      </ButtonLink>
                    </div>
                  </Form>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
