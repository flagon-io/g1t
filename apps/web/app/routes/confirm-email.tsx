import { CircleCheck, MailCheck } from "lucide-react";
import { Form, data } from "react-router";

import { CONFIRM_TTL_SECONDS, tidyConfirmCode } from "@g1t/contracts";

import type { Route } from "./+types/confirm-email";
import { page } from "../lib/meta";
import { ButtonLink, ErrorText, Field, Input, SubmitButton } from "../components/ui";
import { Button } from "../components/ui/button";
import { Hint } from "../components/ui/hint";
import { afterConfirming, confirmedLine } from "../lib/confirm-gate";
import { safeNext } from "../lib/next";
import { accounts, identity } from "../lib/services.server";
import { assertSameOrigin, clientOf, requireUser } from "../lib/session.server";

export function meta(args: Route.MetaArgs) {
  return page(args, { title: "Confirm your email · g1t" });
}

const MINUTES = CONFIRM_TTL_SECONDS / 60;

/**
 * The confirmation page: where a new account (or one that never confirmed
 * its address) is kept until it types the code from its email or follows
 * the link in it (lib/confirm-gate.ts sends it here from everywhere else).
 */
export async function loader({ request, context }: Route.LoaderArgs) {
  const user = requireUser(context, request);
  const next = safeNext(new URL(request.url).searchParams.get("next"));
  // Confirmed already: from a bookmark, or the page loading again right
  // after the code worked, when it shows what that did.
  if (user.verified) return { username: user.username, address: null, next, verified: true };
  const emails = await accounts.listEmails(user);
  const list = emails.ok ? emails.value.emails : [];
  // The address the code went to: the primary, or (when another account
  // confirmed that first) the oldest address still to confirm.
  const address = (list.find((email) => email.primary && !email.verified) ?? list.find((email) => !email.verified))?.email ?? null;
  return { username: user.username, address, next, verified: false };
}

export async function action({ request, context }: Route.ActionArgs) {
  assertSameOrigin(request);
  const user = requireUser(context, request);
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const next = safeNext(new URL(request.url).searchParams.get("next"));

  if (intent === "resend") {
    const sent = await identity.resendVerification(user);
    if (!sent.ok) return data({ intent, error: sent.error.message }, { status: 422 });
    return { intent, sent: true as const };
  }

  if (intent === "change") {
    const changed = await accounts.changePendingEmail(user, String(form.get("email") ?? ""));
    if (!changed.ok) return data({ intent, error: changed.error.message }, { status: 422 });
    return { intent, changed: true as const };
  }

  const typed = String(form.get("code") ?? "");
  if (!tidyConfirmCode(typed)) {
    return data({ intent: "confirm", error: "Enter the 6-digit code from the email." }, { status: 422 });
  }
  const confirmed = await accounts.confirmEmailCode(user, typed, clientOf(request));
  if (!confirmed.ok) return data({ intent: "confirm", error: confirmed.error.message }, { status: 422 });
  const done = confirmed.value;
  return {
    intent: "confirm",
    confirmed: true as const,
    line: confirmedLine(done),
    lapsed: Boolean(done.inviteLapsed),
    to: afterConfirming(next, done.joined, done.invitedTo),
  };
}

export default function ConfirmEmail({ loaderData, actionData }: Route.ComponentProps) {
  const { username, address } = loaderData;
  const said = actionData as
    | { intent: string; error?: string; sent?: true; changed?: true; confirmed?: true; line?: string; lapsed?: boolean; to?: string }
    | undefined;
  const errorFor = (intent: string) => (said?.intent === intent ? (said.error ?? null) : null);

  if (said?.confirmed || loaderData.verified) {
    return (
      <main className="mx-auto flex w-full max-w-85 flex-col pt-8">
        <CircleCheck size={36} className="text-success" aria-hidden="true" />
        <h1 className="mt-6 text-2xl font-semibold tracking-tight">Email confirmed</h1>
        <p className={`mt-2 text-sm leading-6 ${said?.lapsed ? "text-fg" : "text-muted"}`} role="status">
          {said?.line ?? "Your email address is confirmed."}
        </p>
        <div className="mt-8 *:w-full">
          <ButtonLink to={said?.to ?? loaderData.next}>Continue</ButtonLink>
        </div>
      </main>
    );
  }

  return (
    <main className="mx-auto flex w-full max-w-85 flex-col pt-8">
      <h1 className="text-center text-xl font-semibold tracking-tight">Confirm your email</h1>
      <p className="mt-1 text-center text-sm text-muted">One step before you start</p>

      {address ? (
        <p className="mt-6 text-sm leading-6 text-muted">
          We sent a 6-digit code to <span className="font-medium break-all text-fg">{address}</span>. Enter it here,
          or follow the link in the email instead. Either one works.
        </p>
      ) : (
        <p className="mt-6 text-sm leading-6 text-muted">
          Your account has no address to confirm: another g1t account confirmed the one you signed up with first.
          Add the address you want to use below.
        </p>
      )}

      {said?.sent && (
        <p className="mt-4 flex items-start gap-2 rounded-lg border border-accent/30 bg-accent/5 p-3 text-sm" role="status">
          <MailCheck size={16} className="mt-0.5 shrink-0 text-accent" aria-hidden="true" />
          A new code and link are on their way. The ones before stop working.
        </p>
      )}
      {said?.changed && (
        <p className="mt-4 flex items-start gap-2 rounded-lg border border-accent/30 bg-accent/5 p-3 text-sm" role="status">
          <MailCheck size={16} className="mt-0.5 shrink-0 text-accent" aria-hidden="true" />
          Address changed. We sent a code and link there.
        </p>
      )}

      {address && (
        <Form method="post" className="mt-6 space-y-4">
          <input type="hidden" name="intent" value="confirm" />
          <Field label="Confirmation code" hint={`The code and the link work for ${MINUTES} minutes.`}>
            <Input
              name="code"
              autoComplete="one-time-code"
              inputMode="numeric"
              pattern="[0-9 -]*"
              maxLength={9}
              required
              autoFocus
              placeholder="123456"
              aria-describedby="code-error"
              style={{ fontSize: "1.5rem", letterSpacing: "0.4em", fontFamily: "var(--font-mono)", textAlign: "center" }}
            />
          </Field>
          <div id="code-error">
            <ErrorText>{errorFor("confirm")}</ErrorText>
          </div>
          <div className="*:w-full">
            <SubmitButton name="intent" value="confirm" pending="Confirming…">
              Confirm email
            </SubmitButton>
          </div>
        </Form>
      )}

      <div className="mt-8 space-y-4 border-t border-line pt-6 text-sm">
        {address && (
          <Form method="post" className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-muted">Did not get it?</span>
            <Hint label="Sends a new code and link. You can ask once a minute.">
              <SubmitButton variant="outline" name="intent" value="resend" pending="Sending…">
                Send a new code
              </SubmitButton>
            </Hint>
            {errorFor("resend") && (
              <p className="basis-full text-sm text-danger" role="alert">
                {errorFor("resend")}
              </p>
            )}
          </Form>
        )}

        <details className="group" open={!address || said?.intent === "change"}>
          <summary className="cursor-pointer list-none text-muted hover:text-fg [&::-webkit-details-marker]:hidden">
            {address ? (
              <>
                Wrong address? <span className="text-accent underline underline-offset-4">Change it</span>
              </>
            ) : (
              "Add an address"
            )}
          </summary>
          <Form method="post" className="mt-3 space-y-3">
            <input type="hidden" name="intent" value="change" />
            <Field label="Email address" hint="We send a new code and link there. The address you signed up with is removed.">
              <Input name="email" type="email" autoComplete="email" required maxLength={254} />
            </Field>
            <ErrorText>{errorFor("change")}</ErrorText>
            <SubmitButton variant="outline" name="intent" value="change" pending="Changing…">
              Use this address
            </SubmitButton>
          </Form>
        </details>
      </div>

      <Form method="post" action="/logout" className="mt-8 text-center text-sm text-muted">
        Signed in as <span className="font-mono text-fg">{username}</span> ·{" "}
        <Button type="submit" variant="link" size="inline" className="text-fg underline hover:text-accent">
          Sign out
        </Button>
      </Form>
    </main>
  );
}
