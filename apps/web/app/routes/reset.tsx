import { Form, Link, redirect } from "react-router";

import type { Route } from "./+types/reset";
import { page } from "../lib/meta";
import { AuthCard } from "../components/auth-card";
import { ErrorText, Field, Input, SubmitButton } from "../components/ui";
import { identity } from "../lib/services.server";
import { assertSameOrigin } from "../lib/session.server";

export function meta(args: Route.MetaArgs) {
  return page(args, { title: "Choose a new password · g1t" });
}

export function loader({ request }: Route.LoaderArgs) {
  return { token: new URL(request.url).searchParams.get("token") ?? "" };
}

export async function action({ request }: Route.ActionArgs) {
  assertSameOrigin(request);
  const form = await request.formData();
  const result = await identity.resetPassword(
    String(form.get("token") ?? ""),
    String(form.get("password") ?? ""),
  );
  if (!result.ok) return { error: result.error.message };
  throw redirect("/login?reset=1");
}

export default function Reset({ loaderData, actionData }: Route.ComponentProps) {
  return (
    <AuthCard
      title="Choose a new password"
      subtitle="You will be signed out everywhere"
      footer={
        <Link to="/login" className="text-fg underline underline-offset-4">
          Back to sign in
        </Link>
      }
    >
      <Form method="post" className="space-y-4">
        <input type="hidden" name="token" value={loaderData.token} />
        <Field label="New password" hint="At least 10 characters.">
          <Input
            name="password"
            type="password"
            autoComplete="new-password"
            required
            minLength={10}
            autoFocus
          />
        </Field>
        <ErrorText>{actionData?.error}</ErrorText>
        <div className="pt-2 *:w-full">
          <SubmitButton pending="Saving…">Set password</SubmitButton>
        </div>
      </Form>
    </AuthCard>
  );
}
