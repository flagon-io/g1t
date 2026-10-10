import { CircleCheck, CircleX, KeyRound } from "lucide-react";
import { Form } from "react-router";

import type { Route } from "./+types/device";
import { page } from "../lib/meta";
import { Button, ErrorText, Field, Input, SubmitButton, usePending } from "../components/ui";
import { identity } from "../lib/services.server";
import { assertSameOrigin, requireUser } from "../lib/session.server";

export function meta(args: Route.MetaArgs) {
  return page(args, { title: "Connect an application · g1t" });
}

/** Where a tool sends a person to approve its sign-in. */
export async function loader({ request, context }: Route.LoaderArgs) {
  const user = requireUser(context, request);
  const code = new URL(request.url).searchParams.get("code") ?? "";
  return {
    user,
    code,
    pending: code ? await identity.deviceLookup(code) : null,
  };
}

export async function action({ request, context }: Route.ActionArgs) {
  assertSameOrigin(request);
  const user = requireUser(context, request);
  const form = await request.formData();
  const approve = form.get("decision") === "approve";
  const result = await identity.deviceResolve(
    String(form.get("code") ?? ""),
    user,
    approve,
  );
  return result.ok
    ? { done: approve ? ("approved" as const) : ("denied" as const) }
    : { error: result.error.message };
}

export default function Device({ loaderData, actionData }: Route.ComponentProps) {
  const { user, code, pending } = loaderData;
  // Either answer turns both buttons off until it is in.
  const deciding = usePending();

  if (actionData && "done" in actionData) {
    const approved = actionData.done === "approved";
    const Icon = approved ? CircleCheck : CircleX;
    return (
      <main className="mx-auto max-w-md pt-10 text-center">
        <Icon size={40} className={`mx-auto ${approved ? "text-success" : "text-muted"}`} />
        <h1 className="mt-6 text-2xl font-semibold tracking-tight">
          {approved ? "Connected" : "Request denied"}
        </h1>
        <p className="mt-2 text-muted">
          {approved
            ? "Go back to the application. It will finish signing in on its own."
            : "Nothing was given access to your account."}
        </p>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-md pt-8">
      <KeyRound size={36} className="text-accent" />
      <h1 className="mt-6 text-2xl font-semibold tracking-tight">
        Connect an application
      </h1>

      {pending ? (
        <>
          <p className="mt-2 text-muted">
            <span className="font-medium text-fg">{pending.clientName}</span>{" "}
            wants to act as{" "}
            <span className="font-mono font-medium text-fg">{user.username}</span>{" "}
            on g1t.
          </p>
          <p className="mt-6 text-sm text-muted">
            Check that this code matches the one it is showing you:
          </p>
          <p className="mt-2 rounded-xl border border-line bg-surface py-5 text-center font-mono text-3xl font-semibold tracking-[0.2em]">
            {pending.userCode}
          </p>
          <p className="mt-4 text-sm text-muted">
            Approving creates an access token with the full rights of your
            account. You can delete it in settings at any time.
          </p>
          <Form method="post" className="mt-6 flex gap-3">
            <input type="hidden" name="code" value={pending.userCode} />
            <div className="grow *:w-full">
              <SubmitButton variant="accent" name="decision" value="approve" pending="Approving…" disabled={deciding}>
                Approve
              </SubmitButton>
            </div>
            <SubmitButton variant="quiet" name="decision" value="deny" pending="Denying…" disabled={deciding}>
              Deny
            </SubmitButton>
          </Form>
        </>
      ) : (
        <>
          <p className="mt-2 text-muted">
            {code
              ? "That code is not valid or has expired. Start again from the application, or enter the code it shows."
              : "Enter the code the application is showing you."}
          </p>
          <Form method="get" className="mt-6 space-y-4">
            <Field label="Code">
              <Input
                name="code"
                placeholder="XXXX-XXXX"
                autoComplete="off"
                autoCapitalize="characters"
                required
                autoFocus
              />
            </Field>
            <div className="*:w-full">
              <Button type="submit">Continue</Button>
            </div>
          </Form>
        </>
      )}
      <ErrorText>{actionData && "error" in actionData ? actionData.error : null}</ErrorText>
    </main>
  );
}
