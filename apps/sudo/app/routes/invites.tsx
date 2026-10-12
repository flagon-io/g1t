import { Search } from "lucide-react";
import { data, redirect, useLocation } from "react-router";

import type { Invite } from "@g1t/contracts";

import type { Route } from "./+types/invites";
import { Badge, Button, EmptyState, Input, Notice, PageHeader, When } from "~/components/ui";
import { text } from "~/lib/forms";
import { doneMessage } from "~/lib/invites";
import { identity } from "~/lib/services.server";
import { settle } from "~/lib/settle";
import { requireStaff } from "~/lib/staff";

export const meta: Route.MetaFunction = () => [{ title: "Invites · sudo" }, { name: "robots", content: "noindex, nofollow" }];

export async function loader({ request, context }: Route.LoaderArgs) {
  requireStaff(context);
  const url = new URL(request.url);
  const query = url.searchParams.get("q")?.trim() ?? "";
  const invites = await settle(identity.invites(query || null));
  return {
    query,
    invites: invites.ok ? invites.value : [],
    error: invites.ok ? null : invites.error,
    done: doneMessage(url.searchParams.get("done")),
  };
}

export async function action({ request, context }: Route.ActionArgs) {
  const staff = requireStaff(context);
  const form = await request.formData();
  if (text(form, "intent") !== "revoke") return data({ error: "Unknown action.", id: "" }, { status: 400 });
  const result = await identity.revokeInvite(text(form, "id"), staff.email);
  if (!result.ok) return data({ error: result.error.message, id: text(form, "id") }, { status: 422 });
  const url = new URL(request.url);
  url.searchParams.set("done", "revoked");
  throw redirect(`${url.pathname}${url.search}`);
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
      return <Badge tone="mint">Used{invite.redeemedBy ? ` by ${invite.redeemedBy}` : ""}</Badge>;
    case "declined":
      return <Badge>Declined</Badge>;
    case "expired":
      return <Badge>Expired</Badge>;
    case "revoked":
      return <Badge tone="danger">Revoked</Badge>;
  }
}

function InviteTable({ invites, actionData }: { invites: Invite[]; actionData: ActionData }) {
  const { pathname, search } = useLocation();
  if (invites.length === 0) return <EmptyState title="No invites">Nothing matches.</EmptyState>;
  return (
    <div className="overflow-x-auto rounded-lg border border-line bg-surface">
      <table className="w-full min-w-[38rem] text-sm">
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
                  <span className="break-all">
                    {invite.email ?? (invite.invitee ? `@${invite.invitee}` : <span className="text-faint">anyone</span>)}
                  </span>
                  {invite.workspace && <span className="block text-xs text-faint">joins {invite.workspace}</span>}
                </td>
                <td className="px-4 py-2">
                  {invite.invitedBy ? (
                    <span className="font-mono">{invite.invitedBy}</span>
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

export default function Invites({ loaderData, actionData }: Route.ComponentProps) {
  const { query, invites, error, done } = loaderData;
  return (
    <main className="mx-auto max-w-6xl px-4 py-8 sm:py-10">
      <PageHeader
        title="Invites"
        description="Every invitation into a workspace or onto a repository sent to an address, newest first. Anyone may register; find an invitation here to revoke it, for instance one sent to an address that did not ask for it."
      />
      <div className="mt-5 space-y-3 empty:hidden">
        {done && <Notice tone="ok">{done}</Notice>}
        {error && <Notice tone="warn">Identity did not answer: {error}</Notice>}
      </div>
      <div className="mt-5 space-y-4">
        <form method="get" className="flex flex-wrap items-end gap-2">
          <div className="min-w-0 grow basis-60">
            <Input name="q" defaultValue={query} placeholder="A code's start (g1t-k7m2), an email, or a username" aria-label="Search" />
          </div>
          <Button type="submit" variant="quiet">
            <Search size={14} />
            Search
          </Button>
        </form>
        <InviteTable invites={invites} actionData={actionData} />
      </div>
    </main>
  );
}
