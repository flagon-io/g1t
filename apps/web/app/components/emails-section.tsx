import { Mail, ShieldCheck } from "lucide-react";
import { Form } from "react-router";

import { type AccountEmails, type SecurityEvent, securityEventLabel } from "@g1t/contracts";

import { addressActions, backupChoices } from "../lib/emails";
import type { EmailActionData } from "../lib/emails.server";
import { ErrorText, Field, Input, SubmitButton, TimeAgo } from "./ui";
import { Badge } from "./ui/badge";
import { SelectField } from "./ui/select";
import { SwitchCard } from "./ui/switch";

/** One small form posting one intent about one address. */
function AddressButton({ intent, email, label, pending }: { intent: string; email: string; label: string; pending: string }) {
  return (
    <Form method="post">
      <input type="hidden" name="intent" value={intent} />
      <input type="hidden" name="email" value={email} />
      <SubmitButton variant="outline" pending={pending} match={{ intent, email }}>
        {label}
      </SubmitButton>
    </Form>
  );
}

/** What a waiting change does, for the line that asks for the password. */
function describe(intent: string): string {
  switch (intent) {
    case "add-email":
      return "adding";
    case "remove-email":
      return "removing";
    case "primary-email":
      return "making primary";
    default:
      return "for";
  }
}

/** Asks for the password before a sensitive change goes through. */
export function ConfirmItIsYou({ pending, hasPassword }: { pending: NonNullable<EmailActionData>["reauth"]; hasPassword: boolean }) {
  if (!pending) return null;
  return (
    <div role="alert" className="rounded-xl border border-accent/40 bg-surface p-4">
      <p className="flex items-center gap-2 text-sm font-medium">
        <ShieldCheck size={16} className="text-accent" /> Confirm it is you
      </p>
      {hasPassword ? (
        <Form method="post" className="mt-3 space-y-3">
          <p className="text-sm text-muted">
            {pending.message}
            {pending.fields.email ? (
              <>
                {" "}
                ({describe(pending.intent)} <span className="text-fg">{pending.fields.email}</span>)
              </>
            ) : null}
          </p>
          <input type="hidden" name="intent" value={pending.intent} />
          {Object.entries(pending.fields).map(([name, value]) => (
            <input key={name} type="hidden" name={name} value={value} />
          ))}
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
            <div className="grow">
              <Field label="Password">
                <Input name="password" type="password" autoComplete="current-password" required autoFocus />
              </Field>
            </div>
            <SubmitButton pending="Confirming…" match={{ intent: pending.intent }}>
              Confirm
            </SubmitButton>
          </div>
          <p className="text-xs text-faint">You will not be asked again for 10 minutes.</p>
        </Form>
      ) : (
        <p className="mt-2 text-sm text-muted">
          Your account signs in with GitHub only. Sign out, sign in with GitHub again, and make this change within 10
          minutes. Or set a password with Forgot your password on the sign-in page.
        </p>
      )}
    </div>
  );
}

/** The answer to one form's post, under that form: what went wrong, or that it worked. */
function Answer({ actionData }: { actionData: EmailActionData | undefined }) {
  return (
    <>
      <ErrorText>{actionData?.emailError}</ErrorText>
      {actionData?.emailNotice && (
        <p role="status" className="mt-2 text-sm text-muted">
          {actionData.emailNotice}
        </p>
      )}
    </>
  );
}

/**
 * A person's email addresses, in their account settings. `intent` is the
 * form that last posted, so its answer shows beside it.
 */
export function EmailsSection({
  data,
  actionData,
  intent,
  hasPassword,
}: {
  data: AccountEmails | null;
  actionData: EmailActionData | undefined;
  intent?: string;
  hasPassword: boolean;
}) {
  if (!data) return null;
  const answerFor = (one: string) => (intent === one ? actionData : undefined);
  const elsewhere = intent === "backup-email" || intent === "email-privacy";
  const backups = backupChoices(data.emails);
  const backup = data.emails.find((email) => email.backup);
  const full = data.emails.length >= data.limit;
  return (
    <section id="emails" className="scroll-mt-20">
      {actionData?.reauth && (
        <div className="mb-4">
          <ConfirmItIsYou pending={actionData.reauth} hasPassword={hasPassword} />
        </div>
      )}

      <ul className="divide-y divide-line rounded-md border border-line">
        {data.emails.map((email) => {
          const can = addressActions(email, data.emails);
          return (
            <li key={email.email} className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center">
              <div className="flex min-w-0 grow items-start gap-3">
                <Mail size={16} className="mt-0.5 shrink-0 text-faint" />
                <div className="min-w-0">
                  <p className="truncate text-sm">{email.email}</p>
                  <p className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-faint">
                    {email.primary && <Badge size="md">Primary</Badge>}
                    {email.backup && <Badge size="md">Backup</Badge>}
                    {email.verified ? (
                      <span>
                        Confirmed {email.verifiedAt ? <TimeAgo at={email.verifiedAt} /> : null}
                      </span>
                    ) : (
                      <span className="text-warn">Unconfirmed: check your inbox for the link</span>
                    )}
                  </p>
                </div>
              </div>
              <div className="flex shrink-0 flex-wrap gap-2 sm:justify-end">
                {can.resend && <AddressButton intent="resend-email" email={email.email} label="Resend link" pending="Sending…" />}
                {can.makePrimary && <AddressButton intent="primary-email" email={email.email} label="Make primary" pending="Saving…" />}
                {can.remove && <AddressButton intent="remove-email" email={email.email} label="Remove" pending="Removing…" />}
              </div>
            </li>
          );
        })}
      </ul>

      {/* Keyed on the list, so an address once added leaves the field empty. */}
      <Form key={data.emails.length} method="post" className="mt-4">
        <input type="hidden" name="intent" value="add-email" />
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <div className="grow">
            <Field label="Add an email address">
              <Input name="email" type="email" autoComplete="email" placeholder="you@example.com" required disabled={full} />
            </Field>
          </div>
          <SubmitButton pending="Adding…" match={{ intent: "add-email" }} disabled={full}>
            Add
          </SubmitButton>
        </div>
        <p className="mt-1.5 text-xs text-faint">
          {full ? `You have ${data.limit} addresses, the most an account can have.` : "g1t sends it a link to confirm it."}
        </p>
      </Form>
      <Answer actionData={elsewhere ? undefined : actionData} />

      <div className="mt-8">
        <h2 className="font-medium">Backup address</h2>
        <p className="mt-1 text-sm text-muted">
          Security notices, such as a new address or a changed password, go to your primary and to this address.
        </p>
        <Form method="post" className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-end">
          <input type="hidden" name="intent" value="backup-email" />
          <div className="block grow">
            <SelectField
              name="backup"
              aria-label="Backup address"
              defaultValue={backup?.email ?? ""}
              disabled={backups.length === 0}
              className="h-auto py-2"
              options={[{ value: "", label: "Primary address only" }, ...backups.map((email) => ({ value: email.email, label: email.email }))]}
            />
          </div>
          <SubmitButton variant="outline" pending="Saving…" match={{ intent: "backup-email" }} disabled={backups.length === 0}>
            Save
          </SubmitButton>
        </Form>
        <Answer actionData={answerFor("backup-email")} />
        {backups.length === 0 && (
          <p className="mt-2 text-xs text-faint">Add and confirm a second address to choose a backup.</p>
        )}
      </div>

      <div className="mt-8">
        <h2 className="font-medium">Privacy</h2>
        <Form method="post" className="mt-3 space-y-3">
          <input type="hidden" name="intent" value="email-privacy" />
          <SwitchCard name="private" defaultChecked={data.privateEmail} title="Keep my email address private">
            Merges and other commits g1t makes for you on the web, or an agent makes for you, use{" "}
            <span className="font-mono text-fg [overflow-wrap:anywhere]">{data.noreply}</span> instead of your primary address.
          </SwitchCard>
          <SwitchCard name="block" defaultChecked={data.blockPrivatePushes} title="Block pushes that expose my email">
            While your address is private, a push is refused if a commit in it has one of your confirmed
            addresses as its author or committer. Commit with your noreply address instead.
          </SwitchCard>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-xs text-faint">
              Commits g1t makes for you now carry <span className="font-mono [overflow-wrap:anywhere]">{data.commitEmail}</span>.
            </p>
            <SubmitButton variant="outline" pending="Saving…" match={{ intent: "email-privacy" }}>
              Save
            </SubmitButton>
          </div>
        </Form>
        <Answer actionData={answerFor("email-privacy")} />
      </div>
    </section>
  );
}

/** What happened to the account's security, newest first. */
export function SecurityLogSection({ log }: { log: SecurityEvent[] }) {
  return (
    <section id="security-log" className="scroll-mt-20">
      {log.length === 0 ? (
        <p className="text-sm text-faint">Nothing yet.</p>
      ) : (
        <ul className="divide-y divide-line rounded-md border border-line">
          {log.map((event, at) => (
            <li key={`${event.createdAt}:${at}`} className="flex flex-col gap-1 px-4 py-3 sm:flex-row sm:items-center sm:gap-4">
              <p className="min-w-0 grow truncate text-sm">
                {securityEventLabel(event)}
                {event.byStaff && <span className="text-muted"> · by g1t staff{event.reason ? `: ${event.reason}` : ""}</span>}
              </p>
              <p className="shrink-0 text-xs text-faint">
                <TimeAgo at={event.createdAt} />
              </p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
