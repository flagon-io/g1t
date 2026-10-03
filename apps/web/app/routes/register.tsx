import { Form, Link, redirect } from "react-router";

import type { Route } from "./+types/register";
import { AuthCard } from "../components/auth-card";
import { Button, ErrorText, Field, Input } from "../components/ui";
import { identity } from "../lib/services.server";
import {
  assertSameOrigin,
  getViewer,
  nextPath,
  startSession,
} from "../lib/session.server";

export function meta({}: Route.MetaArgs) {
  return [{ title: "Create an account · g1t" }];
}

export function loader({ request, context }: Route.LoaderArgs) {
  if (getViewer(context)) throw redirect(nextPath(request));
  return null;
}

export async function action({ request }: Route.ActionArgs) {
  assertSameOrigin(request);
  const form = await request.formData();
  const result = await identity.register(
    String(form.get("username") ?? ""),
    String(form.get("email") ?? ""),
    String(form.get("password") ?? ""),
  );
  if (!result.ok) return { error: result.error.message };
  throw redirect(nextPath(request), {
    headers: { "set-cookie": startSession(result.value.sessionToken) },
  });
}

export default function Register({ actionData }: Route.ComponentProps) {
  return (
    <AuthCard
      title="Create your account"
      subtitle="Git for AI scale"
      footer={
        <>
          Already have an account?{" "}
          <Link to="/login" className="text-fg underline underline-offset-4">
            Sign in
          </Link>
        </>
      }
    >
      <Form method="post" className="space-y-4">
        <Field
          label="Username"
          hint="Lowercase letters, digits and hyphens. It is how you sign in and how others see you."
        >
          <Input
            name="username"
            autoComplete="username"
            required
            autoFocus
            maxLength={39}
            pattern="[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9]))*"
          />
        </Field>
        <Field label="Email">
          <Input name="email" type="email" autoComplete="email" required />
        </Field>
        <Field label="Password" hint="At least 10 characters.">
          <Input
            name="password"
            type="password"
            autoComplete="new-password"
            required
            minLength={10}
          />
        </Field>
        <ErrorText>{actionData?.error}</ErrorText>
        <div className="pt-2 *:w-full">
          <Button type="submit">Create account</Button>
        </div>
      </Form>
    </AuthCard>
  );
}
