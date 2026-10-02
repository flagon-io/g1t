import { Form, Link } from "react-router";

import type { Route } from "./+types/forgot";
import { AuthCard } from "../components/auth-card";
import { Button, Field, Input } from "../components/ui";
import { identity } from "../lib/services.server";
import { assertSameOrigin } from "../lib/session.server";

export function meta({}: Route.MetaArgs) {
  return [{ title: "Reset your password · g1t" }];
}

export async function action({ request }: Route.ActionArgs) {
  assertSameOrigin(request);
  const form = await request.formData();
  await identity.requestPasswordReset(String(form.get("email") ?? ""));
  return { sent: true };
}

export default function Forgot({ actionData }: Route.ComponentProps) {
  return (
    <AuthCard
      title="Forgot your password?"
      subtitle="We will email you a link"
      footer={
        <Link to="/login" className="text-fg underline underline-offset-4">
          Back to sign in
        </Link>
      }
    >
      {actionData?.sent ? (
        <p className="rounded-lg border border-line bg-surface p-4 text-sm leading-6">
          If that address has an account, a reset link is on its way. It works
          for one hour.
        </p>
      ) : (
        <Form method="post" className="space-y-4">
          <Field label="Email">
            <Input name="email" type="email" autoComplete="email" required autoFocus />
          </Field>
          <div className="pt-2 *:w-full">
            <Button type="submit">Send reset link</Button>
          </div>
        </Form>
      )}
    </AuthCard>
  );
}
