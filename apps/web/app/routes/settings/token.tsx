import { ArrowLeft } from "lucide-react";
import { Form, Link, redirect } from "react-router";

import type { Route } from "./+types/token";
import { page } from "../../lib/meta";
import { ErrorText, SubmitButton } from "../../components/ui";
import { TokenForm } from "../../components/token-form";
import { TokenBadges, TokenMeta } from "../../components/token-list";
import { changesTo, tokenFromForm } from "../../lib/access-tokens";
import { personalToken, workspaceChoices } from "../../lib/access-tokens.server";
import { identity } from "../../lib/services.server";
import { assertSameOrigin, requireUser } from "../../lib/session.server";

// One of your access tokens: what it is, changing it, and deleting it. The
// token itself stays the same; what it reaches and may do changes from its
// next request.

export function meta({ loaderData, ...args }: Route.MetaArgs) {
  return page(args, { title: `${loaderData?.token.name ?? "Access token"} · Settings · g1t` });
}

export async function loader({ request, context, params }: Route.LoaderArgs) {
  const user = requireUser(context, request);
  const [token, workspaces] = await Promise.all([personalToken(user, params.id), workspaceChoices(user)]);
  return { token, workspaces };
}

export async function action({ request, context, params }: Route.ActionArgs) {
  assertSameOrigin(request);
  const user = requireUser(context, request);
  const form = await request.formData();
  if (form.get("intent") === "delete") {
    await identity.removeAccessToken(user, params.id);
    throw redirect("/settings/tokens");
  }
  const token = await personalToken(user, params.id);
  const input = tokenFromForm(form, { editing: true });
  if (!input.ok) return { error: input.error, saved: false };
  const change = changesTo(token, input.value);
  if (Object.keys(change).length === 0) return { error: null, saved: true };
  const updated = await identity.updateToken(user, params.id, change);
  return updated.ok ? { error: null, saved: true } : { error: updated.error.message, saved: false };
}

export default function TokenPage({ loaderData, actionData }: Route.ComponentProps) {
  const { token, workspaces } = loaderData;
  return (
    <section className="space-y-6">
      <div className="space-y-1.5">
        <Link to="/settings/tokens" className="inline-flex items-center gap-1 text-xs text-muted hover:text-fg">
          <ArrowLeft size={13} /> Access tokens
        </Link>
        <h2 className="flex flex-wrap items-center gap-2 text-lg font-semibold tracking-tight">
          {token.name}
          <TokenBadges token={token} />
        </h2>
        <TokenMeta token={token} />
      </div>
      <Form method="post" key={token.id} className="space-y-6">
        <input type="hidden" name="intent" value="save" />
        <TokenForm workspaces={workspaces} editing={token} />
        <ErrorText>{actionData?.error}</ErrorText>
        <div className="flex items-center gap-3">
          <SubmitButton pending="Saving…" match={{ intent: "save" }}>
            Save changes
          </SubmitButton>
          {actionData?.saved && <span className="text-sm text-success">Saved.</span>}
        </div>
        <p className="text-xs text-faint">
          {token.workspace
            ? `If ${token.workspace} approves tokens, widening this one asks its owners again.`
            : "The token stays the same; what it may do changes from its next request."}
        </p>
      </Form>
      <section className="rounded-xl border border-danger/30 p-4">
        <h2 className="text-sm font-medium">Delete this token</h2>
        <p className="mt-1 text-xs text-muted">Anything still using it stops working at once.</p>
        <Form method="post" className="mt-3">
          <input type="hidden" name="intent" value="delete" />
          <SubmitButton variant="danger" pending="Deleting…" match={{ intent: "delete" }}>
            Delete token
          </SubmitButton>
        </Form>
      </section>
    </section>
  );
}
