import { Search } from "lucide-react";
import { Link, data, redirect, useLocation } from "react-router";

import type { Invite } from "@g1t/contracts";

import type { Route } from "./+types/invites";
import { Badge, Button, EmptyState, Field, Input, Notice, PageHeader, Section, Textarea, When } from "~/components/ui";
import { text } from "~/lib/forms";
import { type InvitesTab, doneMessage, invitesHref, invitesTab, parseGrant } from "~/lib/invites";
import { identity } from "~/lib/services.server";
import { settle } from "~/lib/settle";
import { requireStaff } from "~/lib/staff";

export const meta: Route.MetaFunction = () => [{ title: "Invites · sudo" }, { name: "robots", content: "noindex, nofollow" }];

export async function loader({ request, context }: Route.LoaderArgs) {
  requireStaff(context);
  const url = new URL(request.url);
  const query = url.searchParams.get("q")?.trim() ?? "";
  const tab = invitesTab(url.searchParams.get("tab"));
  const invites = await settle(identity.invites(query || null, { toG1t: tab === "g1t" }));
  const granted = url.searchParams.get("left");
  return {
    query,
    tab,
    invites: invites.ok ? invites.value : [],
    error: invites.ok ? null : invites.error,
    done: doneMessage(url.searchParams.get("done")),
    granted: granted && url.searchParams.get("who") ? { who: url.searchParams.get("who")!, left: granted } : null,
  };
}

export async function action({ request, context }: Route.ActionArgs) {
  const staff = requireStaff(context);
  const form = await request.formData();
  const url = new URL(request.url);
  switch (text(form, "intent")) {
    case "revoke": {
      const result = await identity.revokeInvite(text(form, "id"), staff.email);
      if (!result.ok) return data({ error: result.error.message, id: text(form, "id") }, { status: 422 });
      url.searchParams.set("done", "revoked");
      throw redirect(`${url.pathname}${url.search}`);
    }
    case "grant": {
      const grant = parseGrant(form);
      if (!grant.ok) return data({ error: grant.error, id: "grant" }, { status: 422 });
      const { username, amount, note } = grant.value;
      const result = await identity.grantInvites(username, amount, note, staff.email);
      if (!result.ok) return data({ error: result.error.message, id: "grant" }, { status: 422 });
      throw redirect(invitesHref({ tab: "g1t", q: username, done: "granted", who: username, left: `${result.value.remaining} of ${result.value.limit}` }));
    }
  }
  return data({ error: "Unknown action.", id: "" }, { status: 400 });
}

type ActionData = Route.ComponentProps["actionData"];

function statusBadge(invite: Invite) {
  switch (invite.status) {
    case "pending":
      return <Badge tone="lavender">Pending</Badge>;
    case "awaiting_confirmation":
      return <Badge tone="lavender">Used{invite.redeemedBy ? ` by ${invite.redeemedBy}` : ""}, email not confirmed</Badge>;
    case "awaiting_answer":
      return <Badge tone="lavender">Waiting for an answer</Badge>;
    case "redeemed":
      return (
        <Badge tone="mint">
          {invite.chargedTo === "user" ? "Joined" : "Used"}
          {invite.redeemedBy ? ` as ${invite.redeemedBy}` : ""}
        </Badge>
      );
    case "declined":
      return <Badge>Declined</Badge>;
    case "expired":
      return <Badge>Expired</Badge>;
    case "revoked":
      return <Badge tone="danger">Revoked</Badge>;
  }
}

/** What an invite is: an invite to g1t from Invite a friend, or an invitation into a workspace or onto a repository. */
function kindOf(invite: Invite): string {
  if (invite.chargedTo === "user") return invite.workspace ? `To g1t and ${invite.workspace}` : "To g1t";
  return invite.workspace ? `Joins ${invite.workspace}` : "Repository or staff";
}

function InviteTable({ invites, actionData }: { invites: Invite[]; actionData: ActionData }) {
  const { pathname, search } = useLocation();
  if (invites.length === 0) return <EmptyState title="No invites">Nothing matches.</EmptyState>;
  return (
    <div className="overflow-x-auto rounded-lg border border-line bg-surface">
      <table className="w-full min-w-152 text-sm">
        <thead>
          <tr className="text-left text-xs text-faint">
            <th className="px-4 py-2 font-medium">Code</th>
            <th className="px-4 py-2 font-medium">For</th>
            <th className="px-4 py-2 font-medium">From</th>
            <th className="px-4 py-2 font-medium">State</th>
            <th className="px-4 py-2 font-medium">Made</th>
            <th className="px-4 py-2" />
          </tr>
        </thead>
        <tbody>
          {invites.map((invite) => {
            const error = actionData && "id" in actionData && actionData.id === invite.id ? actionData.error : null;
            return (
              <tr key={invite.id} id={invite.id} className="scroll-mt-20 border-t border-line align-top">
                <td className="px-4 py-2 font-mono text-xs whitespace-nowrap">{invite.hint}…</td>
                <td className="px-4 py-2">
                  <span className="break-all">{invite.email ?? (invite.invitee ? `@${invite.invitee}` : <span className="text-faint">anyone</span>)}</span>
                  <span className="block text-xs text-faint">{kindOf(invite)}</span>
                </td>
                <td className="px-4 py-2">
                  {invite.invitedBy ? (
                    <Link to={`/users/${invite.invitedBy}`} className="font-mono hover:text-accent">
                      {invite.invitedBy}
                    </Link>
                  ) : (
                    <span className="text-xs text-muted">staff{invite.staff ? ` · ${invite.staff}` : ""}</span>
                  )}
                </td>
                <td className="px-4 py-2">
                  {statusBadge(invite)}
                  {error && <p className="mt-1 text-xs text-danger">{error}</p>}
                </td>
                <td className="px-4 py-2 text-xs whitespace-nowrap text-muted">
                  <When at={invite.createdAt} />
                </td>
                <td className="px-4 py-2 text-right">
                  {invite.status === "pending" && (
                    <form method="post" action={`${pathname}${search}#${invite.id}`}>
                      <input type="hidden" name="id" value={invite.id} />
                      <Button type="submit" name="intent" value="revoke" variant="danger">
                        Revoke
                      </Button>
                    </form>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** More invites to g1t for one person, or fewer. */
function Grant({ actionData }: { actionData: ActionData }) {
  const error = actionData && "id" in actionData && actionData.id === "grant" ? actionData.error : null;
  return (
    <Section
      title="Grant invites to g1t"
      description="Everyone has 20. Give a person more, or take some back with a negative number; kept with why and who granted them."
    >
      <form method="post" className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_8rem]">
        <input type="hidden" name="intent" value="grant" />
        <Field label="Username">
          <Input name="username" required maxLength={40} placeholder="ada" />
        </Field>
        <Field label="Invites" hint="Up to 1000.">
          <Input name="amount" required inputMode="numeric" placeholder="10" />
        </Field>
        <Field label="Why" className="sm:col-span-2">
          <Textarea name="note" rows={2} maxLength={500} required placeholder="e.g. Bringing her whole meetup." />
        </Field>
        {error && (
          <div className="sm:col-span-2">
            <Notice tone="error">{error}</Notice>
          </div>
        )}
        <div className="flex justify-end sm:col-span-2">
          <Button type="submit" variant="lavender">
            Grant
          </Button>
        </div>
      </form>
    </Section>
  );
}

const TABS: { value: InvitesTab; label: string }[] = [
  { value: "all", label: "Every invite" },
  { value: "g1t", label: "Invites to g1t" },
];

export default function Invites({ loaderData, actionData }: Route.ComponentProps) {
  const { query, tab, invites, error, done, granted } = loaderData;
  return (
    <main className="mx-auto max-w-7xl px-4 py-8 sm:py-10">
      <PageHeader
        title="Invites"
        description="Every invite, newest first: invitations into a workspace or onto a repository, and invites to g1t that people send their friends with Invite a friend. While g1t.sh is in private preview, a new account needs one; people without one ask on Access requests. Find one here to revoke it, for instance one sent to an address that did not ask for it."
      />
      <div className="mt-5 space-y-3 empty:hidden">
        {done && <Notice tone="ok">{granted ? `${done} @${granted.who} has ${granted.left} invites left.` : done}</Notice>}
        {error && <Notice tone="warn">Identity did not answer: {error}</Notice>}
      </div>
      <nav aria-label="Which invites" className="mt-6 flex gap-1 overflow-x-auto border-b border-line">
        {TABS.map((entry) => {
          const current = tab === entry.value;
          return (
            <Link
              key={entry.value}
              to={invitesHref({ tab: entry.value === "all" ? null : entry.value, q: query })}
              aria-current={current ? "page" : undefined}
              className={`-mb-px flex shrink-0 items-center gap-2 border-b-2 px-3 py-2 text-sm whitespace-nowrap ${
                current ? "border-accent font-medium text-fg" : "border-transparent text-muted hover:text-fg"
              }`}
            >
              {entry.label}
            </Link>
          );
        })}
      </nav>
      <div className="mt-4 space-y-4">
        <form method="get" className="flex flex-wrap items-end gap-2">
          {tab !== "all" && <input type="hidden" name="tab" value={tab} />}
          <div className="min-w-0 grow basis-60">
            <Input name="q" defaultValue={query} placeholder="A code's start (g1t-k7m2), an email, or a username" aria-label="Search" />
          </div>
          <Button type="submit" variant="quiet">
            <Search size={14} />
            Search
          </Button>
        </form>
        <InviteTable invites={invites} actionData={actionData} />
        {tab === "g1t" && <Grant actionData={actionData} />}
      </div>
    </main>
  );
}
