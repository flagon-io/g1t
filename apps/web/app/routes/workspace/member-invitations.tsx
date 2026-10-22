import { Check, Copy, Ellipsis, Mail, RotateCw, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link, data, useFetcher, useSearchParams } from "react-router";

import type { Invite } from "@g1t/contracts";

import type { Route } from "./+types/member-invitations";
import { page } from "../../lib/meta";
import { EmptyState, ErrorText, TimeAgo } from "../../components/ui";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card } from "../../components/ui/card";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "../../components/ui/dropdown-menu";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../components/ui/table";
import { ToggleGroup, ToggleGroupItem } from "../../components/ui/toggle-group";
import { InviteDialog } from "../../components/invite-dialog";
import { StartPlanToInvite } from "../../components/start-plan";
import { UserCard } from "../../components/user-card";
import { invitationFromForm, inviteFromForm } from "../../lib/member-invitations.server";
import {
  INVITATION_FILTERS,
  type InvitationResult,
  filterInvitations,
  invitationCounts,
  invitationFilter,
  invitationFilterOf,
  invitationTone,
  inviteLink,
  inviteState,
} from "../../lib/invites";
import { billing, identity } from "../../lib/services.server";
import { assertSameOrigin, getViewer, requireUser, roleIn } from "../../lib/session.server";

export function meta({ params, ...args }: Route.MetaArgs) {
  return page(args, { title: `Invitations · ${params.owner} · g1t` });
}

/**
 * Invitations: every invitation to join the workspace, newest first, with
 * where each stands, and the way to send one again, revoke it or copy its
 * link. Owners only; to anyone else the page does not exist.
 */
export async function loader({ params, context, request }: Route.LoaderArgs) {
  const viewer = getViewer(context);
  if (roleIn(viewer, params.owner) !== "owner") throw data(null, { status: 404 });
  const [invites, workspace, free] = await Promise.all([
    identity.workspaceInvites(params.owner, viewer),
    // Only for the workspace's name, which its address stands in for.
    identity.getWorkspace(params.owner).catch(() => null),
    billing.freeWorkspaces([params.owner]).catch(() => [] as string[]),
  ]);
  return {
    name: workspace?.name?.trim() || params.owner,
    free: free.includes(params.owner.toLowerCase()),
    invites: invites.ok ? invites.value : [],
    origin: new URL(request.url).origin,
  };
}

export async function action({ request, params, context }: Route.ActionArgs) {
  assertSameOrigin(request);
  const user = requireUser(context, request);
  const form = await request.formData();
  const changed = await invitationFromForm(user, params.owner, form);
  if (changed) return changed;
  return inviteFromForm(user, params.owner, form);
}

/** The role an invitation joins with; member when it names none. */
function roleOf(invite: Invite): string {
  return invite.role === "owner" ? "Owner" : "Member";
}

/** The person or address an invitation is for. */
function Who({ invite }: { invite: Invite }) {
  if (invite.invitee && !invite.email) {
    return (
      <UserCard username={invite.invitee}>
        <Link to={`/u/${invite.invitee}`} className="font-mono hover:text-accent">
          @{invite.invitee}
        </Link>
      </UserCard>
    );
  }
  if (invite.email) {
    return (
      <span className="inline-flex min-w-0 items-center gap-1.5">
        <Mail size={13} aria-hidden="true" className="shrink-0 text-faint" />
        <span className="truncate">{invite.email}</span>
      </span>
    );
  }
  return <span className="text-muted">Anyone with the link</span>;
}

/** The ⋯ menu on one invitation: copy its link, send it again, revoke it. */
function InvitationMenu({ invite, origin, onDone }: { invite: Invite; origin: string; onDone: (result: InvitationResult) => void }) {
  const fetcher = useFetcher<InvitationResult>();
  const [copied, setCopied] = useState(false);
  const pending = invitationFilterOf(invite.status) === "pending";
  const resendable = invite.status === "pending";
  const link = invite.code ? inviteLink(invite.code, origin) : null;
  const working = fetcher.state !== "idle";
  // What the service answered, once, to the page.
  const answered = fetcher.state === "idle" ? fetcher.data : undefined;
  const told = useRef<InvitationResult | undefined>(undefined);
  useEffect(() => {
    if (!answered || told.current === answered) return;
    told.current = answered;
    onDone(answered);
  }, [answered, onDone]);
  if (!pending && !link) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          aria-label={`Manage the invitation for ${invite.email ?? invite.invitee ?? invite.hint}`}
          variant="ghost"
          size="inline"
          className="p-1.5 text-faint max-sm:p-2.5"
          disabled={working}
        >
          <Ellipsis size={16} />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuItem
          disabled={!link}
          onSelect={(event) => {
            event.preventDefault();
            if (!link) return;
            void navigator.clipboard?.writeText(link).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            });
          }}
        >
          {copied ? <Check /> : <Copy />}
          {copied ? "Copied" : link ? "Copy link" : "No link to copy"}
        </DropdownMenuItem>
        <DropdownMenuItem disabled={!resendable} onSelect={() => fetcher.submit({ action: "resend-invite", id: invite.id }, { method: "post" })}>
          <RotateCw />
          {resendable ? "Send again" : "Already in their hands"}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          disabled={!pending}
          className="text-danger"
          onSelect={() => fetcher.submit({ action: "revoke-invite", id: invite.id }, { method: "post" })}
        >
          <X />
          Revoke
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export default function WorkspaceInvitations({ loaderData, params }: Route.ComponentProps) {
  const { name, free, invites, origin } = loaderData;
  const [search, setSearch] = useSearchParams();
  const filter = invitationFilter(search.get("state"));
  const counts = invitationCounts(invites);
  const shown = filterInvitations(invites, filter);
  const [notice, setNotice] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const done = (result: InvitationResult) => {
    const who = invites.find((invite) => invite.id === result.id);
    const whom = who?.email ?? (who?.invitee ? `@${who.invitee}` : "the invitation");
    if ("error" in result) setNotice({ tone: "error", text: result.error });
    else setNotice({ tone: "ok", text: result.done === "revoked" ? `Revoked the invitation for ${whom}.` : `Sent the invitation for ${whom} again.` });
  };
  const choose = (value: string) => {
    const next = new URLSearchParams(search);
    if (value && value !== "all") next.set("state", value);
    else next.delete("state");
    setSearch(next, { replace: true, preventScrollReset: true });
  };
  return (
    <div className="max-w-4xl">
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <ToggleGroup type="single" variant="outline" value={filter} onValueChange={(value) => value && choose(value)} aria-label="Which invitations">
          {INVITATION_FILTERS.map((entry) => (
            <ToggleGroupItem key={entry.key} value={entry.key}>
              {entry.label}
              <span className="text-faint tabular-nums">{counts[entry.key]}</span>
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        {!free && (
          <div className="ml-auto">
            <InviteDialog
              name={name}
              action={`/${params.owner}/-/settings/members/invitations`}
              onInvited={(who) => setNotice({ tone: "ok", text: `Invitation to join ${name} sent to ${who}. They join once they accept.` })}
            />
          </div>
        )}
      </div>
      {free && (
        <div className="mb-4">
          <StartPlanToInvite workspace={params.owner} owner />
        </div>
      )}
      {shown.length === 0 ? (
        <EmptyState
          title={filter === "all" ? "No invitations yet" : `No ${INVITATION_FILTERS.find((entry) => entry.key === filter)?.label.toLowerCase()} invitations`}
        >
          {filter === "all"
            ? `Invite someone and the invitation is listed here until they answer, and after.`
            : "Choose All to see every invitation sent to join the workspace."}
        </EmptyState>
      ) : (
        <Card tone="plain" className="overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Who</TableHead>
                <TableHead>Invited by</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Sent</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="w-10">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {shown.map((invite) => {
                const state = inviteState(invite);
                return (
                  <TableRow key={invite.id}>
                    <TableCell className="max-w-64 align-middle text-sm">
                      <Who invite={invite} />
                    </TableCell>
                    <TableCell className="align-middle text-sm whitespace-nowrap text-muted">
                      {invite.invitedBy ? (
                        <UserCard username={invite.invitedBy}>
                          <Link to={`/u/${invite.invitedBy}`} className="font-mono hover:text-accent">
                            {invite.invitedBy}
                          </Link>
                        </UserCard>
                      ) : (
                        "g1t"
                      )}
                    </TableCell>
                    <TableCell className="align-middle text-sm whitespace-nowrap text-muted">{roleOf(invite)}</TableCell>
                    <TableCell className="align-middle text-sm whitespace-nowrap text-muted">
                      <TimeAgo at={invite.createdAt} />
                    </TableCell>
                    <TableCell className="align-middle">
                      <Badge tone={invitationTone(invite.status)} size="md" className="max-w-56 truncate">
                        {state.label}
                      </Badge>
                      {invitationFilterOf(invite.status) === "pending" && (
                        <span className="ml-2 text-xs whitespace-nowrap text-faint">until {invite.expiresAt.slice(0, 10)}</span>
                      )}
                    </TableCell>
                    <TableCell className="align-middle text-right">
                      <InvitationMenu invite={invite} origin={origin} onDone={done} />
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </Card>
      )}
      <p className="mt-2 text-xs text-faint">
        An invitation works for 30 days. One nobody used by then shows as Expired; g1t does not yet know whether its email was delivered.
      </p>
      {notice &&
        (notice.tone === "ok" ? (
          <p className="mt-3 text-sm text-muted" role="status">
            {notice.text}
          </p>
        ) : (
          <ErrorText>{notice.text}</ErrorText>
        ))}
    </div>
  );
}
