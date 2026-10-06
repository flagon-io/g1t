import { ArrowLeft } from "lucide-react";
import { Form, Link, data, redirect } from "react-router";

import { securityEventLabel } from "@g1t/contracts";

import type { Route } from "./+types/user";
import { Badge, Button, EmptyState, Field, Input, Notice, PageHeader, Section, When } from "~/components/ui";
import { accountsAdmin } from "~/lib/services.server";
import { settle } from "~/lib/settle";
import { requireStaff } from "~/lib/staff";

export const meta: Route.MetaFunction = ({ params }) => [
  { title: `${params.username} · sudo` },
  { name: "robots", content: "noindex, nofollow" },
];

export async function loader({ params, request, context }: Route.LoaderArgs) {
  requireStaff(context);
  const result = await settle(accountsAdmin.user(params.username));
  if (result.ok && !result.value) throw data("No such account.", { status: 404 });
  return {
    user: result.ok ? result.value : null,
    error: result.ok ? null : result.error,
    removed: new URL(request.url).searchParams.get("removed"),
  };
}

/** Removes an address: the reason is required, recorded and shown to the person. */
export async function action({ params, request, context }: Route.ActionArgs) {
  const staff = requireStaff(context);
  const form = await request.formData();
  const email = String(form.get("email") ?? "").trim();
  const reason = String(form.get("reason") ?? "").trim();
  if (!reason) return data({ error: "Say why. The person sees the reason in their security log.", email }, { status: 422 });
  const result = await accountsAdmin.removeEmail(params.username, email, reason, staff.email);
  if (!result.ok) return data({ error: result.error.message, email }, { status: 422 });
  throw redirect(`/users/${encodeURIComponent(params.username)}?removed=${encodeURIComponent(email)}`);
}

export default function User({ loaderData, actionData }: Route.ComponentProps) {
  const { user, error, removed } = loaderData;
  if (!user) {
    return (
      <main className="mx-auto max-w-4xl px-4 py-8 sm:py-10">
        <Notice tone="error">Could not load the account: {error}</Notice>
      </main>
    );
  }
  return (
    <main className="mx-auto max-w-4xl px-4 py-8 sm:py-10">
      <Link to="/workspaces" className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-fg">
        <ArrowLeft size={14} /> Workspaces
      </Link>
      <PageHeader
        title={user.username}
        description={
          <>
            Account <span className="font-mono">{user.id}</span>, made <When at={user.createdAt} />.{" "}
            {user.privateEmail ? "Keeps its address private on commits." : "Shows its primary address on commits."}
          </>
        }
      />
      {removed && (
        <div className="mt-5">
          <Notice tone="ok">Removed {removed}. The person was told, with the reason.</Notice>
        </div>
      )}

      <Section
        id="emails"
        title="Email addresses"
        description="Remove an address someone else needs, or one that is compromised. Never the last confirmed one; removing the primary makes the oldest other confirmed address primary."
        className="mt-6"
      >
        <ul className="divide-y divide-line rounded-md border border-line">
          {user.emails.map((email) => (
            <li key={email.email} className="space-y-3 px-4 py-3">
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span className="font-mono break-all">{email.email}</span>
                {email.primary && <Badge tone="lavender">Primary</Badge>}
                {email.backup && <Badge>Backup</Badge>}
                {email.verified ? <Badge tone="mint">Confirmed</Badge> : <Badge tone="warn">Unconfirmed</Badge>}
                <span className="text-xs text-faint">
                  added <When at={email.createdAt} />
                </span>
              </div>
              <Form method="post" className="flex flex-col gap-2 sm:flex-row sm:items-end">
                <input type="hidden" name="email" value={email.email} />
                <div className="grow">
                  <Field label="Reason (the person sees it)">
                    <Input
                      name="reason"
                      required
                      maxLength={200}
                      placeholder="Another account needs this address"
                    />
                  </Field>
                </div>
                <Button variant="danger" type="submit">
                  Remove
                </Button>
              </Form>
              {actionData?.email === email.email && actionData.error && <Notice tone="error">{actionData.error}</Notice>}
            </li>
          ))}
        </ul>
      </Section>

      <Section id="log" title="Security log" description="What happened to the account's addresses and password, newest first." className="mt-6">
        {user.log.length === 0 ? (
          <EmptyState title="Nothing yet" />
        ) : (
          <ul className="divide-y divide-line text-sm">
            {user.log.map((event, at) => (
              <li key={`${event.createdAt}:${at}`} className="flex flex-col gap-1 py-2 sm:flex-row sm:justify-between sm:gap-4">
                <span className="min-w-0 break-words">
                  {securityEventLabel(event)}
                  {event.staff && (
                    <span className="text-muted">
                      {" "}
                      · by {event.staff}
                      {event.reason ? `: ${event.reason}` : ""}
                    </span>
                  )}
                </span>
                <span className="shrink-0 text-xs text-faint">
                  <When at={event.createdAt} time />
                </span>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </main>
  );
}
