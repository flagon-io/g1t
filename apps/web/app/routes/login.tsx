import { Form, Link, redirect } from "react-router";

import type { Route } from "./+types/login";
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
  return [{ title: "Sign in · g1t" }];
}

export function loader({ request, context }: Route.LoaderArgs) {
  if (getViewer(context)) throw redirect(nextPath(request));
  return null;
}

export async function action({ request }: Route.ActionArgs) {
  assertSameOrigin(request);
  const form = await request.formData();
  const result = await identity.signIn(
    String(form.get("username") ?? "").trim(),
    String(form.get("password") ?? ""),
  );
  if (!result.ok) return { error: result.error.message };
  throw redirect(nextPath(request), {
    headers: { "set-cookie": startSession(result.value.sessionToken) },
  });
}

export default function Login({ actionData }: Route.ComponentProps) {
  return (
    <AuthCard
      title="Welcome back"
      subtitle="Sign in to g1t"
      footer={
        <>
          New to g1t?{" "}
          <Link to="/register" className="text-fg underline underline-offset-4">
            Create an account
          </Link>
        </>
      }
    >
      <Form method="post" className="space-y-4">
        <Field label="Username">
          <Input name="username" autoComplete="username" required autoFocus />
        </Field>
        <Field label="Password">
          <Input
            name="password"
            type="password"
            autoComplete="current-password"
            required
          />
        </Field>
        <ErrorText>{actionData?.error}</ErrorText>
        <div className="pt-2 *:w-full">
          <Button type="submit">Sign in</Button>
        </div>
        <p className="text-center text-sm">
          <Link to="/forgot" className="text-muted hover:text-fg">
            Forgot your password?
          </Link>
        </p>
      </Form>
    </AuthCard>
  );
}
