import { CircleCheck, MailWarning } from "lucide-react";
import { redirect } from "react-router";

import type { Route } from "./+types/verify";
import { page } from "../lib/meta";
import { ButtonLink } from "../components/ui";
import { CONFIRM_PATH, afterConfirming, confirmedLine } from "../lib/confirm-gate";
import { identity } from "../lib/services.server";
import { assertSameOrigin, getViewer, requireUser } from "../lib/session.server";

export function meta(args: Route.MetaArgs) {
  return page(args, { title: "Confirm your email · g1t" });
}

/**
 * Follows the link from the confirmation email, signed in or not: the same
 * email's code does the same on /confirm-email.
 */
export async function loader({ request, context }: Route.LoaderArgs) {
  const token = new URL(request.url).searchParams.get("token") ?? "";
  const viewer = getViewer(context);
  const result = await identity.verifyEmail(token);
  if (!result.ok) return { ok: false as const, message: result.error.message, signedIn: viewer != null };
  const done = result.value;
  // An address added to an account in use goes back to settings; a new
  // account's first goes on to the workspace its invite joined, or home.
  const added = viewer?.verified === true;
  return {
    ok: true as const,
    username: done.username,
    added,
    line: confirmedLine(done),
    lapsed: Boolean(done.inviteLapsed),
    to: afterConfirming("/", done.joined, done.invitedTo),
    signedIn: viewer != null,
  };
}

/** An old form's "resend": the confirmation page sends new codes now. */
export async function action({ request, context }: Route.ActionArgs) {
  assertSameOrigin(request);
  await identity.resendVerification(requireUser(context, request));
  throw redirect(CONFIRM_PATH);
}

export default function Verify({ loaderData }: Route.ComponentProps) {
  return (
    <main className="mx-auto max-w-md pt-10 text-center">
      {loaderData.ok ? (
        <>
          <CircleCheck size={40} className="mx-auto text-success" />
          <h1 className="mt-6 text-2xl font-semibold tracking-tight">
            Email confirmed
          </h1>
          {loaderData.added ? (
            <>
              <p className="mt-2 text-muted">
                The address is confirmed on {loaderData.username}. You can make it
                your primary address in your settings.
              </p>
              <div className="mt-8">
                <ButtonLink to="/settings/emails">Back to settings</ButtonLink>
              </div>
            </>
          ) : (
            <>
              <p className={`mt-2 ${loaderData.lapsed ? "text-fg" : "text-muted"}`} role="status">
                {loaderData.line} Your account {loaderData.username} is ready.
              </p>
              <div className="mt-8">
                <ButtonLink to={loaderData.signedIn ? loaderData.to : `/login?next=${encodeURIComponent(loaderData.to)}`}>
                  {loaderData.signedIn ? "Continue" : "Sign in"}
                </ButtonLink>
              </div>
            </>
          )}
        </>
      ) : (
        <>
          <MailWarning size={40} className="mx-auto text-warn" />
          <h1 className="mt-6 text-2xl font-semibold tracking-tight">
            That link did not work
          </h1>
          <p className="mt-2 text-muted">{loaderData.message}</p>
          <p className="mt-2 text-sm text-muted">
            Links work once, for an hour, and a newer email replaces them.
            {loaderData.signedIn
              ? " Enter the code from your latest email, or send a new one."
              : " Sign in to enter the code from the email, or to send a new one."}
          </p>
          <div className="mt-8">
            <ButtonLink to={loaderData.signedIn ? CONFIRM_PATH : `/login?next=${encodeURIComponent(CONFIRM_PATH)}`} variant="quiet">
              {loaderData.signedIn ? "Enter a code" : "Sign in"}
            </ButtonLink>
          </div>
        </>
      )}
    </main>
  );
}
