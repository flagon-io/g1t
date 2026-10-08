import { Check, MessageSquareText, Search, Ticket, X } from "lucide-react";
import { Link, data, redirect, useLocation } from "react-router";

import type { Invite, InviteTree, InviteTreeNode, WaitlistEntry } from "@g1t/contracts";

import type { Route } from "./+types/invites";
import { Badge, Button, EmptyState, Field, Input, Notice, PageHeader, Section, Select, Textarea, When } from "~/components/ui";
import { text } from "~/lib/forms";
import {
  INVITE_TABS,
  type InviteTab,
  MAX_BULK,
  MAX_NOTE,
  TAB_LABEL,
  doneMessage,
  invitesHref,
  parseGrant,
  parseIds,
  parseMintEmail,
  parseNote,
  parseTab,
  parseWaitlistStatus,
} from "~/lib/invites";
import { identity } from "~/lib/services.server";
import { settle } from "~/lib/settle";
import { requireStaff } from "~/lib/staff";

export const meta: Route.MetaFunction = () => [{ title: "Invites · sudo" }, { name: "robots", content: "noindex, nofollow" }];

export async function loader({ request, context }: Route.LoaderArgs) {
  requireStaff(context);
  const url = new URL(request.url);
  const tab = parseTab(url.searchParams.get("tab"));
  const query = url.searchParams.get("q")?.trim() ?? "";
  const status = parseWaitlistStatus(url.searchParams.get("status"));
  const name = url.searchParams.get("name")?.trim().toLowerCase() ?? "";
  const kind = url.searchParams.get("kind") === "workspace" ? "workspace" : "user";
  const done = url.searchParams.get("done");
  const selectAll = url.searchParams.get("select") === "all";
  const [waitlist, invites, tree] = await Promise.all([
    tab === "waitlist" ? settle(identity.waitlist(query || null, status === "all" ? null : status)) : null,
    tab === "invites" ? settle(identity.invites(query || null)) : null,
    tab === "tree" && name ? settle(kind === "workspace" ? identity.workspaceInvites(name) : identity.inviteTree(name)) : null,
  ]);
  return {
    tab,
    query,
    status,
    name,
    kind,
    waitlist: waitlist?.ok ? waitlist.value : [],
    invites: invites?.ok ? invites.value : [],
    tree: tree?.ok ? tree.value : null,
    error: [waitlist, invites, tree].map((result) => (result && !result.ok ? result.error : null)).find(Boolean) ?? null,
    done: doneMessage(done, url.searchParams.get("n")),
    selectAll,
  };
}

export async function action({ request, context }: Route.ActionArgs) {
  const staff = requireStaff(context);
  const form = await request.formData();
  const back = (done: string, n?: number) => {
    const url = new URL(request.url);
    url.searchParams.set("done", done);
    url.searchParams.delete("select");
    if (n) url.searchParams.set("n", String(n));
    else url.searchParams.delete("n");
    return redirect(`${url.pathname}${url.search}`);
  };
  switch (text(form, "intent")) {
    case "approve":
    case "dismiss": {
      const approve = text(form, "intent") === "approve";
      const note = parseNote(text(form, "note"));
      if (!note.ok) return data({ error: note.error, id: text(form, "id") }, { status: 422 });
      const result = await identity.decideWaitlist(text(form, "id"), approve, staff.email, approve ? note.value : null);
      if (!result.ok) return data({ error: result.error.message, id: text(form, "id") }, { status: 422 });
      throw back(approve ? "approved" : "dismissed");
    }
    case "bulk-approve":
    case "bulk-dismiss": {
      const approve = text(form, "intent") === "bulk-approve";
      const ids = parseIds(form);
      if (!ids.ok) return data({ error: ids.error, section: "bulk" }, { status: 422 });
      const note = parseNote(text(form, "note"));
      if (!note.ok) return data({ error: note.error, section: "bulk" }, { status: 422 });
      // One at a time: each mints and emails its own invite.
      const refused: string[] = [];
      let decided = 0;
      for (const id of ids.value) {
        const result = await identity.decideWaitlist(id, approve, staff.email, approve ? note.value : null);
        if (result.ok) decided += 1;
        else refused.push(result.error.message);
      }
      if (refused.length > 0) {
        const verb = approve ? "Approved" : "Dismissed";
        return data({ error: `${verb} ${decided}; ${refused.length} not: ${refused.join(" ")}`, section: "bulk" }, { status: 422 });
      }
      throw back(approve ? "approved" : "dismissed", decided);
    }
    case "revoke": {
      const result = await identity.revokeInvite(text(form, "id"), staff.email);
      if (!result.ok) return data({ error: result.error.message, id: text(form, "id") }, { status: 422 });
      throw back("revoked");
    }
    case "grant": {
      const grant = parseGrant(form);
      if (!grant.ok) return data({ error: grant.error, section: "grant" }, { status: 422 });
      const { target, name, amount, note } = grant.value;
      const result = await identity.grantInvites(target, name, amount, note, staff.email);
      if (!result.ok) return data({ error: result.error.message, section: "grant" }, { status: 422 });
      throw redirect(`${invitesHref("tree", { name, kind: target })}&done=granted`);
    }
    case "mint": {
      const email = parseMintEmail(text(form, "email"));
      if (!email.ok) return data({ error: email.error, section: "mint" }, { status: 422 });
      const result = await identity.mintInvite(email.value, staff.email);
      if (!result.ok) return data({ error: result.error.message, section: "mint" }, { status: 422 });
      // Shown once, here: staff cannot see it again.
      return { minted: result.value };
    }
  }
  return data({ error: "Unknown action." }, { status: 400 });
}

type ActionData = Route.ComponentProps["actionData"];

function errorFor(actionData: ActionData, key: { id?: string; section?: string }): string | null {
  if (!actionData || !("error" in actionData)) return null;
  if (key.id && "id" in actionData && actionData.id === key.id) return actionData.error;
  if (key.section && "section" in actionData && actionData.section === key.section) return actionData.error;
  return null;
}

function statusBadge(invite: Invite) {
  switch (invite.status) {
    case "pending":
      return <Badge tone="lavender">Pending</Badge>;
    case "redeemed":
      return <Badge tone="mint">Used{invite.redeemedBy ? ` by ${invite.redeemedBy}` : ""}</Badge>;
    case "expired":
      return <Badge>Expired</Badge>;
    case "revoked":
      return <Badge tone="danger">Revoked</Badge>;
  }
}

function SearchForm({ tab, query, placeholder, extra }: { tab: InviteTab; query: string; placeholder: string; extra?: React.ReactNode }) {
  return (
    <form method="get" className="flex flex-wrap items-end gap-2">
      <input type="hidden" name="tab" value={tab} />
      <div className="min-w-0 grow basis-60">
        <Input name="q" defaultValue={query} placeholder={placeholder} aria-label="Search" />
      </div>
      {extra}
      <Button type="submit" variant="quiet">
        <Search size={14} />
        Search
      </Button>
    </form>
  );
}

/** A note for the invite email, folded away until wanted. */
function NoteField({ form, label }: { form?: string; label: string }) {
  return (
    <details className="group/note">
      <summary className="inline-flex cursor-pointer list-none items-center gap-1.5 text-xs text-muted select-none hover:text-fg [&::-webkit-details-marker]:hidden">
        <MessageSquareText size={13} />
        {label}
      </summary>
      <div className="mt-2">
        <Textarea
          name="note"
          form={form}
          rows={2}
          maxLength={MAX_NOTE}
          placeholder="Optional. Goes in the invite email as a note from the g1t team."
          aria-label="Note for the invite email"
        />
      </div>
    </details>
  );
}

/** Who decided, when, what they wrote, and whether the invite was used. */
function Decision({ entry }: { entry: WaitlistEntry }) {
  if (!entry.decidedBy) return null;
  return (
    <div className="space-y-1.5">
      <p className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-faint">
        {entry.status === "invited" ? "Approved" : "Dismissed"} by <span className="font-mono text-muted">{entry.decidedBy}</span>
        <When at={entry.decidedAt} />
        {entry.status === "invited" &&
          (entry.joinedAs ? <Badge tone="mint">Joined as @{entry.joinedAs}</Badge> : <Badge>Invite not used yet</Badge>)}
      </p>
      {entry.note && (
        <p className="text-xs text-muted">
          Note sent: <span className="whitespace-pre-line text-fg-soft">{entry.note}</span>
        </p>
      )}
    </div>
  );
}

function Waitlist({
  entries,
  query,
  status,
  selectAll,
  actionData,
}: {
  entries: WaitlistEntry[];
  query: string;
  status: string;
  selectAll: boolean;
  actionData: ActionData;
}) {
  const { pathname, search } = useLocation();
  const waiting = entries.filter((entry) => entry.status === "waiting");
  const params = new URLSearchParams(search);
  params.set("select", "all");
  const selectHref = `${pathname}?${params}`;
  params.delete("select");
  const clearHref = `${pathname}?${params}`;
  const bulkError = errorFor(actionData, { section: "bulk" });
  return (
    <div className="space-y-4">
      <SearchForm
        tab="waitlist"
        query={query}
        placeholder="Email or what they said"
        extra={
          <div className="w-full sm:w-40">
            <Select name="status" defaultValue={status} aria-label="Status">
              <option value="waiting">Waiting</option>
              <option value="invited">Invited</option>
              <option value="dismissed">Dismissed</option>
              <option value="all">All</option>
            </Select>
          </div>
        }
      />
      {waiting.length > 0 && (
        // Ticked rows belong to this form through their `form` attribute:
        // sudo runs no script, so choosing several is plain HTML.
        <form
          id="bulk"
          method="post"
          action={`${pathname}${search}`}
          className="space-y-3 rounded-lg border border-line bg-raised/40 px-4 py-3 sm:px-5"
        >
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <p className="text-sm">
              <span className="font-medium">{waiting.length} waiting</span>
              <span className="text-muted"> · tick some, or </span>
              {selectAll ? (
                <a href={clearHref} className="text-accent hover:underline">
                  clear
                </a>
              ) : (
                <a href={selectHref} className="text-accent hover:underline">
                  tick all {Math.min(waiting.length, MAX_BULK)}
                </a>
              )}
            </p>
            <div className="ml-auto flex flex-wrap gap-2">
              <Button type="submit" name="intent" value="bulk-dismiss" variant="quiet">
                <X size={14} />
                Dismiss ticked
              </Button>
              <Button type="submit" name="intent" value="bulk-approve" variant="lavender">
                <Check size={14} />
                Approve and invite ticked
              </Button>
            </div>
          </div>
          <NoteField form="bulk" label="Add a note to every invite" />
          {bulkError && <Notice tone="error">{bulkError}</Notice>}
        </form>
      )}
      {entries.length === 0 ? (
        <EmptyState title={status === "waiting" ? "Nobody waiting" : "Nothing here"}>
          People who ask for access on g1t.sh/register show up here, newest first.
        </EmptyState>
      ) : (
        <ul className="divide-y divide-line rounded-lg border border-line bg-surface">
          {entries.map((entry, index) => {
            const error = errorFor(actionData, { id: entry.id });
            const open = entry.status === "waiting";
            return (
              <li key={entry.id} id={entry.id} className="scroll-mt-20 px-4 py-3 sm:px-5">
                <div className="flex gap-3">
                  {open && (
                    <input
                      type="checkbox"
                      form="bulk"
                      name="ids"
                      value={entry.id}
                      defaultChecked={selectAll && index < MAX_BULK}
                      aria-label={`Tick ${entry.email}`}
                      className="mt-1 size-4 shrink-0 accent-[var(--color-accent)]"
                    />
                  )}
                  <div className="min-w-0 grow space-y-2">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <span className="font-mono text-sm break-all">{entry.email}</span>
                      {entry.status === "invited" && <Badge tone="mint">Invited</Badge>}
                      {entry.status === "dismissed" && <Badge>Dismissed</Badge>}
                      <span className="text-xs text-faint">
                        asked <When at={entry.createdAt} />
                        {entry.updatedAt !== entry.createdAt && (
                          <>
                            , again <When at={entry.updatedAt} />
                          </>
                        )}
                      </span>
                    </div>
                    {entry.about ? (
                      <blockquote className="border-l-2 border-line-strong pl-3 text-sm break-words whitespace-pre-line text-fg-soft">{entry.about}</blockquote>
                    ) : (
                      <p className="text-xs text-faint italic">Did not say what they will build.</p>
                    )}
                    <Decision entry={entry} />
                    {open && (
                      <form method="post" action={`${pathname}${search}#${entry.id}`} className="space-y-2">
                        <input type="hidden" name="id" value={entry.id} />
                        <div className="flex flex-wrap items-start justify-between gap-2">
                          <NoteField label="Add a note to the invite" />
                          <div className="ml-auto flex gap-2">
                            <Button type="submit" name="intent" value="dismiss" variant="quiet">
                              <X size={14} />
                              Dismiss
                            </Button>
                            <Button type="submit" name="intent" value="approve" variant="lavender">
                              <Check size={14} />
                              Approve and invite
                            </Button>
                          </div>
                        </div>
                      </form>
                    )}
                    {error && <Notice tone="error">{error}</Notice>}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function InviteTable({ invites, actionData, revoke = true }: { invites: Invite[]; actionData: ActionData; revoke?: boolean }) {
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
            const error = errorFor(actionData, { id: invite.id });
            return (
              <tr key={invite.id} id={invite.id} className="scroll-mt-20 border-t border-line align-top">
                <td className="px-4 py-2 font-mono text-xs whitespace-nowrap">{invite.hint}…</td>
                <td className="px-4 py-2">
                  <span className="break-all">{invite.email ?? <span className="text-faint">anyone</span>}</span>
                  {invite.workspace && <span className="block text-xs text-faint">joins {invite.workspace}</span>}
                </td>
                <td className="px-4 py-2">
                  {invite.invitedBy ? (
                    <Link to={invitesHref("tree", { name: invite.invitedBy })} className="font-mono hover:underline">
                      {invite.invitedBy}
                    </Link>
                  ) : (
                    <span className="text-xs text-muted">staff{invite.staff ? ` · ${invite.staff}` : ""}</span>
                  )}
                  <span className="block text-xs text-faint">
                    {invite.chargedTo === "workspace" ? "workspace's invites" : invite.chargedTo === "user" ? "own invites" : "free"}
                  </span>
                </td>
                <td className="px-4 py-2">
                  {statusBadge(invite)}
                  {error && <p className="mt-1 text-xs text-danger">{error}</p>}
                </td>
                <td className="px-4 py-2 text-xs whitespace-nowrap text-muted">
                  <When at={invite.createdAt} />
                </td>
                <td className="px-4 py-2 text-right">
                  {revoke && invite.status === "pending" && (
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

function GrantAndMint({ actionData }: { actionData: ActionData }) {
  const minted = actionData && "minted" in actionData ? actionData.minted : null;
  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <Section title="Grant invites" description="More invites for a person, or for a workspace whose owners share them. A negative number takes some back.">
        <form method="post" className="space-y-3">
          <input type="hidden" name="intent" value="grant" />
          <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)] gap-3">
            <Field label="To">
              <Select name="target" defaultValue="user">
                <option value="user">Person</option>
                <option value="workspace">Workspace</option>
              </Select>
            </Field>
            <Field label="Username or slug">
              <Input name="name" required maxLength={40} placeholder="ada" />
            </Field>
          </div>
          <Field label="Invites" hint="Up to 1000 at a time.">
            <Input name="amount" required inputMode="numeric" placeholder="10" />
          </Field>
          <Field label="Why" hint="Kept with the grant.">
            <Textarea name="note" rows={2} maxLength={500} required placeholder="e.g. Launch partner bringing their team." />
          </Field>
          {errorFor(actionData, { section: "grant" }) && <Notice tone="error">{errorFor(actionData, { section: "grant" })}</Notice>}
          <div className="flex justify-end">
            <Button type="submit" variant="lavender">
              Grant
            </Button>
          </div>
        </form>
      </Section>
      <Section title="Mint an invite" description="An invite that uses nobody's allowance. With an email, it is sent there and only that address can use it.">
        <form method="post" className="space-y-3">
          <input type="hidden" name="intent" value="mint" />
          <Field label="Email (optional)">
            <Input name="email" type="email" maxLength={254} placeholder="Anyone with the code" />
          </Field>
          {errorFor(actionData, { section: "mint" }) && <Notice tone="error">{errorFor(actionData, { section: "mint" })}</Notice>}
          {minted?.code && (
            <Notice tone="ok">
              <p>{minted.email ? `Sent to ${minted.email}. ` : ""}Copy it now; it is not shown again.</p>
              <p className="mt-1 font-mono text-xs break-all text-fg">https://g1t.sh/invite/{minted.code}</p>
            </Notice>
          )}
          <div className="flex justify-end">
            <Button type="submit">
              <Ticket size={14} />
              Mint
            </Button>
          </div>
        </form>
      </Section>
    </div>
  );
}

function Nodes({ nodes }: { nodes: InviteTreeNode[] }) {
  if (nodes.length === 0) return null;
  return (
    <ul className="space-y-1 border-l border-line pl-4">
      {nodes.map((node) => (
        <li key={node.username}>
          <Link to={invitesHref("tree", { name: node.username })} className="font-mono text-sm hover:underline">
            {node.username}
          </Link>{" "}
          <span className="text-xs text-faint">
            joined <When at={node.joinedAt} />
          </span>
          <div className="mt-1">
            <Nodes nodes={node.invited} />
          </div>
        </li>
      ))}
    </ul>
  );
}

function Tree({ tree, name, kind, actionData }: { tree: InviteTree | null; name: string; kind: string; actionData: ActionData }) {
  return (
    <div className="space-y-4">
      <form method="get" className="flex flex-wrap items-end gap-2">
        <input type="hidden" name="tab" value="tree" />
        <div className="w-full sm:w-40">
          <Select name="kind" defaultValue={kind} aria-label="Kind">
            <option value="user">Person</option>
            <option value="workspace">Workspace</option>
          </Select>
        </div>
        <div className="min-w-0 grow basis-60">
          <Input name="name" defaultValue={name} placeholder="Username or workspace slug" aria-label="Name" />
        </div>
        <Button type="submit" variant="quiet">
          Look up
        </Button>
      </form>
      {name && !tree && <EmptyState title={`No ${kind === "workspace" ? "workspace" : "account"} named ${name}`} />}
      {tree && (
        <div className="grid gap-5 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
          <Section title={tree.username} description={kind === "workspace" ? "A workspace's shared invites" : "Where they came from, and whom they brought"}>
            <dl className="space-y-2 text-sm">
              {kind !== "workspace" && (
                <div>
                  <dt className="text-xs text-faint">Invited by</dt>
                  <dd className="font-mono">
                    {tree.invitedBy.length > 0
                      ? tree.invitedBy.map((username, index) => (
                          <span key={username}>
                            {index > 0 && <span className="text-faint"> ← </span>}
                            <Link to={invitesHref("tree", { name: username })} className="hover:underline">
                              {username}
                            </Link>
                          </span>
                        ))
                      : tree.staff
                        ? `staff (${tree.staff})`
                        : "nobody: made without an invite"}
                  </dd>
                </div>
              )}
              <div>
                <dt className="text-xs text-faint">Allowance</dt>
                <dd>
                  {tree.allowance.limit == null
                    ? `No limit · ${tree.allowance.used} out`
                    : `${tree.allowance.used} of ${tree.allowance.limit} used · ${tree.allowance.remaining} left`}
                </dd>
              </div>
              {tree.grants.length > 0 && (
                <div>
                  <dt className="text-xs text-faint">Grants</dt>
                  <dd>
                    <ul className="space-y-1">
                      {tree.grants.map((grant) => (
                        <li key={grant.createdAt} className="text-xs">
                          <span className="tabular font-medium">{grant.amount > 0 ? `+${grant.amount}` : grant.amount}</span> by{" "}
                          <span className="font-mono">{grant.grantedBy}</span> <When at={grant.createdAt} />
                          {grant.note && <span className="block text-muted">{grant.note}</span>}
                        </li>
                      ))}
                    </ul>
                  </dd>
                </div>
              )}
              {kind !== "workspace" && (
                <div>
                  <dt className="mb-1 text-xs text-faint">Invited</dt>
                  <dd>{tree.invited.length > 0 ? <Nodes nodes={tree.invited} /> : <span className="text-muted">Nobody yet</span>}</dd>
                </div>
              )}
            </dl>
          </Section>
          <div className="min-w-0">
            <h3 className="mb-2 text-sm font-medium">Invites</h3>
            <InviteTable invites={tree.invites} actionData={actionData} />
          </div>
        </div>
      )}
    </div>
  );
}

export default function Invites({ loaderData, actionData }: Route.ComponentProps) {
  const { tab, query, status, waitlist, invites, tree, name, kind, error, done, selectAll } = loaderData;
  return (
    <main className="mx-auto max-w-6xl px-4 py-8 sm:py-10">
      <PageHeader
        title="Invites"
        description="g1t.sh is invite-only. Approve people from the waitlist, find and revoke invites, grant more to a person or a workspace, and trace who brought whom."
      />
      <nav aria-label="Invites" className="mt-5 flex flex-wrap gap-2">
        {INVITE_TABS.map((value) => (
          <Link
            key={value}
            to={invitesHref(value)}
            aria-current={value === tab ? "page" : undefined}
            className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs whitespace-nowrap transition-colors ${
              value === tab ? "border-accent/50 bg-accent/10 text-accent" : "border-line text-muted hover:border-line-strong hover:text-fg"
            }`}
          >
            {TAB_LABEL[value]}
          </Link>
        ))}
      </nav>
      <div className="mt-5 space-y-3 empty:hidden">
        {done && <Notice tone="ok">{done}</Notice>}
        {error && <Notice tone="warn">Identity did not answer: {error}</Notice>}
      </div>
      <div className="mt-5">
        {tab === "waitlist" && (
          <Waitlist entries={waitlist} query={query} status={status} selectAll={selectAll} actionData={actionData} />
        )}
        {tab === "invites" && (
          <div className="space-y-4">
            <SearchForm tab="invites" query={query} placeholder="A code's start (g1t-k7m2), an email, or a username" />
            <InviteTable invites={invites} actionData={actionData} />
          </div>
        )}
        {tab === "grant" && <GrantAndMint actionData={actionData} />}
        {tab === "tree" && <Tree tree={tree} name={name} kind={kind} actionData={actionData} />}
      </div>
    </main>
  );
}
