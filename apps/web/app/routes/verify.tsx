import { CircleCheck, MailWarning } from "lucide-react";
import { redirect } from "react-router";

import type { Route } from "./+types/verify";
import { ButtonLink } from "../components/ui";
import { identity } from "../lib/services.server";
import { assertSameOrigin, requireUser } from "../lib/session.server";

export function meta({}: Route.MetaArgs) {
  return [{ title: "Confirm your email · g1t" }];
}

/** Follows the link from the confirmation email. */
export async function loader({ request }: Route.LoaderArgs) {
  const token = new URL(request.url).searchParams.get("token") ?? "";
  const result = await identity.verifyEmail(token);
  return result.ok
    ? { ok: true as const, username: result.value.username }
    : { ok: false as const, message: result.error.message };
}

/** "Resend" from the banner shown to unconfirmed accounts. */
export async function action({ request, context }: Route.ActionArgs) {
  assertSameOrigin(request);
  await identity.resendVerification(requireUser(context, request));
  throw redirect("/?sent=1");
}

export default function Verify({ loaderData }: Route.ComponentProps) {
  return (
    <main className="mx-auto max-w-md px-4 py-32 text-center">
      {loaderData.ok ? (
        <>
          <CircleCheck size={40} className="mx-auto text-accent" />
          <h1 className="mt-6 text-2xl font-semibold tracking-tight">
            Email confirmed
          </h1>
          <p className="mt-2 text-muted">
            Your account {loaderData.username} is ready. Next, create the
            workspace your repositories will live in.
          </p>
          <div className="mt-8">
            <ButtonLink to="/">Continue</ButtonLink>
          </div>
        </>
      ) : (
        <>
          <MailWarning size={40} className="mx-auto text-warn" />
          <h1 className="mt-6 text-2xl font-semibold tracking-tight">
            That link did not work
          </h1>
          <p className="mt-2 text-muted">{loaderData.message}</p>
          <p className="mt-2 text-sm text-muted">
            Sign in and use the banner at the top to send a new one.
          </p>
          <div className="mt-8">
            <ButtonLink to="/login" variant="quiet">
              Sign in
            </ButtonLink>
          </div>
        </>
      )}
    </main>
  );
}
