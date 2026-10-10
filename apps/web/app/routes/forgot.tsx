import { Form, Link } from "react-router";

import type { Route } from "./+types/forgot";
import { page } from "../lib/meta";
import { AuthCard } from "../components/auth-card";
import { ErrorText, Field, Input, SubmitButton } from "../components/ui";
import { Card } from "../components/ui/card";
import { identity } from "../lib/services.server";
import { assertSameOrigin, clientOf } from "../lib/session.server";

export function meta(args: Route.MetaArgs) {
  return page(args, { title: "Reset your password · g1t" });
}

export async function action({ request }: Route.ActionArgs) {
  assertSameOrigin(request);
  const form = await request.formData();
  try {
    await identity.requestPasswordReset(String(form.get("email") ?? ""), clientOf(request));
  } catch (error) {
    // Logged, never shown: what went wrong could say whether the address
    // has an account. The person hears only that it did not go.
    console.warn("forgot:", error);
    return { sent: false, error: "We could not send a reset link just now. Try again in a few minutes." };
  }
  return { sent: true, error: null };
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
        <Card asChild radius="lg" className="p-4 text-sm leading-6">
          <p>
            If that address belongs to an account, a reset link is on its way to
            it. It works for one hour.
          </p>
        </Card>
      ) : (
        <Form method="post" className="space-y-4">
          <Field label="Email">
            <Input name="email" type="email" autoComplete="email" required autoFocus />
          </Field>
          <ErrorText>{actionData?.error}</ErrorText>
          <div className="pt-2 *:w-full">
            <SubmitButton pending="Sending…">Send reset link</SubmitButton>
          </div>
        </Form>
      )}
    </AuthCard>
  );
}
