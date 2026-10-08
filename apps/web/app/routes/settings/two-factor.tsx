import { KeyRound, ShieldAlert, ShieldCheck, Smartphone } from "lucide-react";
import { useState } from "react";
import { Form } from "react-router";

import type { Route } from "./+types/two-factor";
import { ConfirmItIsYou } from "../../components/emails-section";
import { QrCode } from "../../components/qr-code";
import { CopyLine, ErrorText, Field, Input, SubmitButton, TimeAgo } from "../../components/ui";
import { Badge } from "../../components/ui/badge";
import { githubSignIn } from "../../lib/github.server";
import { page } from "../../lib/meta";
import { accounts } from "../../lib/services.server";
import { assertSameOrigin, requireUser } from "../../lib/session.server";
import { TWO_FACTOR_INTENTS, twoFactorAction } from "../../lib/two-factor.server";

export function meta(args: Route.MetaArgs) {
  return page(args, { title: "Two-factor authentication · Settings · g1t" });
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const user = requireUser(context, request);
  const [status, github] = await Promise.all([
    accounts.twoFactorStatus(user).catch(() => null),
    githubSignIn.account(user).catch(() => null),
  ]);
  return {
    status: status?.ok ? status.value : null,
    hasPassword: github?.hasPassword ?? true,
  };
}

export async function action({ request, context }: Route.ActionArgs) {
  assertSameOrigin(request);
  const user = requireUser(context, request);
  const form = await request.formData();
  if ((TWO_FACTOR_INTENTS as readonly string[]).includes(String(form.get("intent")))) {
    return (await twoFactorAction(user, form, request)) ?? null;
  }
  return null;
}

/** A base32 secret in groups of four, as people type it. */
function grouped(secret: string): string {
  return secret.match(/.{1,4}/g)?.join(" ") ?? secret;
}

/** The six digits an app shows, typed. */
function CodeInput({ label = "Code from your app", recovery = false }: { label?: string; recovery?: boolean }) {
  return (
    <Field label={label} hint={recovery ? "Or a recovery code, such as k7m2q-9xw4d." : undefined}>
      <Input
        name="code"
        required
        autoComplete="one-time-code"
        inputMode={recovery ? "text" : "numeric"}
        pattern={recovery ? undefined : "[0-9 ]{6,7}"}
        maxLength={recovery ? 20 : 7}
        placeholder={recovery ? "123456" : "123 456"}
      />
    </Field>
  );
}

/** Recovery codes, shown once, with a way to keep them. */
function RecoveryCodes({ codes }: { codes: string[] }) {
  const [copied, setCopied] = useState(false);
  return (
    <section className="rounded-xl border border-warn/40 bg-surface p-4" aria-labelledby="recovery-codes">
      <h2 id="recovery-codes" className="flex items-center gap-2 text-sm font-medium">
        <KeyRound size={16} className="text-warn" /> Save your recovery codes
      </h2>
      <p className="mt-1 text-sm text-muted">
        Each one signs you in once if you lose your phone. They are shown only now: keep them in your password manager.
      </p>
      <ul className="mt-4 grid grid-cols-2 gap-2 font-mono text-sm sm:grid-cols-5">
        {codes.map((code) => (
          <li key={code} className="rounded-md border border-line bg-bg px-2 py-1.5 text-center">
            {code}
          </li>
        ))}
      </ul>
      <button
        type="button"
        className="mt-4 text-sm text-accent underline underline-offset-4"
        onClick={() => {
          void navigator.clipboard.writeText(codes.join("\n"));
          setCopied(true);
        }}
      >
        {copied ? "Copied" : "Copy all"}
      </button>
    </section>
  );
}

export default function TwoFactorSettings({ loaderData, actionData }: Route.ComponentProps) {
  const { status, hasPassword } = loaderData;
  const setup = actionData?.setup;
  if (!status) {
    return <p className="text-sm text-muted">Two-factor authentication could not be loaded just now. Try again in a moment.</p>;
  }
  return (
    <div className="space-y-6">
      {actionData?.reauth && <ConfirmItIsYou pending={actionData.reauth} hasPassword={hasPassword} />}
      {actionData?.codes && <RecoveryCodes codes={actionData.codes} />}
      {actionData?.notice && !actionData.codes && (
        <p role="status" className="text-sm text-muted">
          {actionData.notice}
        </p>
      )}

      {status.required_by.length > 0 && !status.enabled && (
        <div role="alert" className="flex gap-3 rounded-xl border border-warn/40 bg-surface p-4 text-sm">
          <ShieldAlert size={16} className="mt-0.5 shrink-0 text-warn" />
          <p>
            <span className="font-medium">{status.required_by.join(", ")}</span>{" "}
            {status.required_by.length === 1 ? "requires" : "require"} two-factor authentication. You cannot use{" "}
            {status.required_by.length === 1 ? "it" : "them"} until you turn it on here.
          </p>
        </div>
      )}

      {status.enabled ? (
        <>
          <section className="rounded-xl border border-line bg-surface p-4">
            <div className="flex flex-wrap items-center gap-3">
              <ShieldCheck size={18} className="text-success" />
              <h2 className="grow text-sm font-medium">Authenticator app</h2>
              <Badge tone="success">On</Badge>
            </div>
            <p className="mt-2 text-sm text-muted">
              Signing in with your password asks for a code from your app too. Git over HTTPS takes an access token,
              never your password.
              {status.enabled_at && (
                <>
                  {" "}
                  Turned on <TimeAgo at={status.enabled_at} />.
                </>
              )}
            </p>
            <p className="mt-2 text-sm text-muted">
              {status.recovery_codes_left} of 10 recovery codes left.
            </p>
            <Form method="post" className="mt-4">
              <input type="hidden" name="intent" value="two-factor-codes" />
              <SubmitButton variant="quiet" match={{ intent: "two-factor-codes" }} pending="Making codes…">
                Make new recovery codes
              </SubmitButton>
            </Form>
          </section>

          <section className="rounded-xl border border-line p-4">
            <h2 className="text-sm font-medium">Turn off two-factor authentication</h2>
            <p className="mt-1 text-sm text-muted">
              {status.required_by.length > 0
                ? `You would lose access to ${status.required_by.join(", ")} until you turn it on again.`
                : "Your account is safer with it on."}
            </p>
            <Form method="post" className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-end">
              <input type="hidden" name="intent" value="two-factor-disable" />
              <div className="grow sm:max-w-56">
                <CodeInput recovery />
              </div>
              <SubmitButton variant="danger" match={{ intent: "two-factor-disable" }} pending="Turning off…">
                Turn off
              </SubmitButton>
            </Form>
            <ErrorText>{actionData?.error}</ErrorText>
          </section>
        </>
      ) : setup ? (
        <section className="rounded-xl border border-line bg-surface p-4">
          <h2 className="flex items-center gap-2 text-sm font-medium">
            <Smartphone size={16} className="text-accent" /> Set up your authenticator app
          </h2>
          <ol className="mt-4 space-y-5 text-sm">
            <li>
              <p className="text-muted">1. Scan this with an authenticator app, such as 1Password, Google Authenticator or Authy.</p>
              <div className="mt-3 inline-block rounded-lg bg-white p-2">
                <QrCode value={setup.uri} label="QR code for your authenticator app" />
              </div>
              <p className="mt-3 text-muted">Or enter this key by hand:</p>
              <div className="mt-2 max-w-sm">
                <CopyLine text={grouped(setup.secret)} />
              </div>
            </li>
            <li>
              <p className="text-muted">2. Enter the six-digit code your app shows.</p>
              <Form method="post" className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-end">
                <input type="hidden" name="intent" value="two-factor-enable" />
                <input type="hidden" name="secret" value={setup.secret} />
                <input type="hidden" name="uri" value={setup.uri} />
                <div className="grow sm:max-w-56">
                  <CodeInput />
                </div>
                <SubmitButton match={{ intent: "two-factor-enable" }} pending="Checking…">
                  Turn on
                </SubmitButton>
              </Form>
              <ErrorText>{actionData?.error}</ErrorText>
            </li>
          </ol>
        </section>
      ) : (
        <section className="rounded-xl border border-line bg-surface p-4">
          <div className="flex flex-wrap items-center gap-3">
            <Smartphone size={18} className="text-faint" />
            <h2 className="grow text-sm font-medium">Authenticator app</h2>
            <Badge>Off</Badge>
          </div>
          <p className="mt-2 text-sm text-muted">
            A code from an app on your phone, asked for each time you sign in with your password, so a stolen password
            is not enough.
          </p>
          <Form method="post" className="mt-4">
            <input type="hidden" name="intent" value="two-factor-start" />
            <SubmitButton match={{ intent: "two-factor-start" }} pending="Starting…">
              Set up
            </SubmitButton>
          </Form>
          <ErrorText>{actionData?.error}</ErrorText>
        </section>
      )}
    </div>
  );
}
