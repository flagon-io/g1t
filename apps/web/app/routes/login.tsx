import { env } from "cloudflare:workers";
import { Form, redirect } from "react-router";

import type { Route } from "./+types/login";
import { Button, ErrorText, Field, Input } from "../components/ui";
import {
  assertSameOrigin,
  getViewer,
  startSession,
} from "../lib/session.server";

export function meta({}: Route.MetaArgs) {
  return [{ title: "Sign in · g1t" }];
}

/** Only same-site paths, so `next` cannot redirect off g1t. */
function nextPath(request: Request): string {
  const next = new URL(request.url).searchParams.get("next") ?? "/";
  return next.startsWith("/") && !next.startsWith("//") ? next : "/";
}

export function loader({ request, context }: Route.LoaderArgs) {
  if (getViewer(context)) throw redirect(nextPath(request));
  return null;
}

export async function action({ request }: Route.ActionArgs) {
  assertSameOrigin(request);
  const form = await request.formData();
  const username = String(form.get("username") ?? "").trim();
  const password = String(form.get("password") ?? "");
  const result = await env.IDENTITY.signIn(username, password);
  if (!result.ok) return { error: result.error.message };
  throw redirect(nextPath(request), {
    headers: { "set-cookie": startSession(result.value.sessionToken) },
  });
}

export default function Login({ actionData }: Route.ComponentProps) {
  return (
    <main className="mx-auto max-w-sm px-4 pt-32">
      <h1 className="text-xl font-semibold">Welcome to g1t</h1>
      <p className="text-xl text-muted">Many attempts. One ships.</p>
      <Form method="post" className="mt-10 space-y-4">
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
      </Form>
    </main>
  );
}
