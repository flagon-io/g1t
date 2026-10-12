import { Form, data, redirect } from "react-router";

import type { Route } from "./+types/blocked-domains";
import { Button, EmptyState, Field, Input, Notice, PageHeader, Section, When } from "~/components/ui";
import { text } from "~/lib/forms";
import { identity } from "~/lib/services.server";
import { settle } from "~/lib/settle";
import { requireStaff } from "~/lib/staff";
import { parseReason } from "~/lib/suspension";

export const meta: Route.MetaFunction = () => [{ title: "Blocked domains · sudo" }, { name: "robots", content: "noindex, nofollow" }];

export async function loader({ request, context }: Route.LoaderArgs) {
  requireStaff(context);
  const domains = await settle(identity.blockedDomains());
  const done = new URL(request.url).searchParams.get("done");
  return {
    domains: domains.ok ? domains.value : [],
    error: domains.ok ? null : domains.error,
    done: done === "blocked" ? "Blocked. No new account can sign up with an address there." : done === "unblocked" ? "Unblocked." : null,
  };
}

export async function action({ request, context }: Route.ActionArgs) {
  const staff = requireStaff(context);
  const form = await request.formData();
  const block = text(form, "intent") === "block";
  const reason = block ? parseReason(text(form, "reason")) : { ok: true as const, value: "" };
  if (!reason.ok) return data({ error: reason.error }, { status: 422 });
  const result = await identity.blockDomain(text(form, "domain"), block, reason.value, staff.email);
  if (!result.ok) return data({ error: result.error.message }, { status: 422 });
  throw redirect(`/blocked-domains?done=${block ? "blocked" : "unblocked"}`);
}

export default function BlockedDomains({ loaderData, actionData }: Route.ComponentProps) {
  const { domains, error, done } = loaderData;
  return (
    <main className="mx-auto max-w-4xl px-4 py-8 sm:py-10">
      <PageHeader
        title="Blocked domains"
        description="Email domains no new account may sign up with, with a password or GitHub, and that no account may add. Each domain's subdomains are blocked too. Accounts already there are not touched: suspend them one at a time from their page."
      />
      <div className="mt-5 space-y-3 empty:hidden">
        {done && <Notice tone="ok">{done}</Notice>}
        {error && <Notice tone="warn">Identity did not answer: {error}</Notice>}
        {actionData && "error" in actionData && <Notice tone="error">{actionData.error}</Notice>}
      </div>
      <Section id="block" title="Block a domain" className="mt-6">
        <Form method="post" className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)_auto] sm:items-end">
          <Field label="Domain">
            <Input name="domain" required maxLength={253} placeholder="spam.example" spellCheck={false} autoCapitalize="none" />
          </Field>
          <Field label="Why">
            <Input name="reason" required maxLength={500} placeholder="e.g. Throwaway addresses used for sign-up abuse" />
          </Field>
          <Button type="submit" name="intent" value="block" variant="danger">
            Block
          </Button>
        </Form>
      </Section>
      <Section id="list" title="Blocked" className="mt-6">
        {domains.length === 0 ? (
          <EmptyState title="None blocked">Every domain can sign up.</EmptyState>
        ) : (
          <ul className="space-y-2">
            {domains.map((domain) => (
              <li key={domain.domain} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line bg-surface px-3 py-2 text-sm">
                <span className="min-w-0">
                  <span className="font-mono">{domain.domain}</span>
                  <span className="block text-xs text-faint">
                    {domain.reason} · {domain.blockedBy} · <When at={domain.createdAt} />
                  </span>
                </span>
                <Form method="post">
                  <input type="hidden" name="domain" value={domain.domain} />
                  <Button type="submit" name="intent" value="unblock" variant="quiet">
                    Unblock
                  </Button>
                </Form>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </main>
  );
}
