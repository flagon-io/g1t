import { ArrowLeft } from "lucide-react";
import { Form, Link } from "react-router";

import type { AccessToken } from "@g1t/contracts";

import type { Route } from "./+types/token-new";
import { page } from "../../lib/meta";
import { ErrorText, SubmitButton } from "../../components/ui";
import { TokenForm } from "../../components/token-form";
import { TokenCreated } from "../../components/token-list";
import { tokenFromForm } from "../../lib/access-tokens";
import { workspaceChoices } from "../../lib/access-tokens.server";
import { identity } from "../../lib/services.server";
import { assertSameOrigin, requireUser } from "../../lib/session.server";

// A new access token of yours: the one form (components/token-form.tsx).

export function meta(args: Route.MetaArgs) {
  return page(args, { title: "New access token · Settings · g1t" });
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const user = requireUser(context, request);
  return { workspaces: await workspaceChoices(user) };
}

type ActionResult = { secret: string; token: AccessToken; error: null } | { secret: null; token: null; error: string };

export async function action({ request, context }: Route.ActionArgs): Promise<ActionResult> {
  assertSameOrigin(request);
  const user = requireUser(context, request);
  const input = tokenFromForm(await request.formData());
  if (!input.ok) return { secret: null, token: null, error: input.error };
  const created = await identity.createToken(user, input.value);
  if (!created.ok) return { secret: null, token: null, error: created.error.message };
  return { secret: created.value.token, token: created.value.info, error: null };
}

export default function NewToken({ loaderData, actionData }: Route.ComponentProps) {
  return (
    <section className="space-y-6">
      <div>
        <Link to="/settings/tokens" className="inline-flex items-center gap-1 text-xs text-muted hover:text-fg">
          <ArrowLeft size={13} /> Access tokens
        </Link>
        <h2 className="mt-2 text-lg font-semibold tracking-tight">New access token</h2>
        <p className="mt-1 text-sm text-muted">It acts as you, never with more than you can do.</p>
      </div>
      {actionData?.secret ? (
        <TokenCreated secret={actionData.secret} token={actionData.token} back="/settings/tokens" />
      ) : (
        <Form method="post" className="space-y-6">
          <TokenForm workspaces={loaderData.workspaces} />
          <ErrorText>{actionData?.error}</ErrorText>
          <SubmitButton pending="Generating…">Generate token</SubmitButton>
        </Form>
      )}
    </section>
  );
}
