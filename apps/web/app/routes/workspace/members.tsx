import { ArrowUpRight, Check, Ellipsis, Mail, Search, ShieldAlert, ShieldCheck, Users } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { Form, Link, data, redirect, useSearchParams, useSubmit } from "react-router";

import { type Member, ORG_ROLES, ORG_ROLE_LABELS, ORG_ROLE_SUMMARIES, type OrgRole, REPO_ROLE_LABELS } from "@g1t/contracts";

import type { Route } from "./+types/members";
import { page } from "../../lib/meta";
import { EmptyState, ErrorText, SubmitButton } from "../../components/ui";
import { Badge } from "../../components/ui/badge";
import { PersonStatusEmoji, WithPresence } from "../../components/presence";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../../components/ui/alert-dialog";
import { Avatar } from "../../components/ui/avatar";
import { Button } from "../../components/ui/button";
import { Card } from "../../components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../../components/ui/dropdown-menu";
import { Hint } from "../../components/ui/hint";
import { Input } from "../../components/ui/input";
import { SelectField } from "../../components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../components/ui/tabs";
import { InviteDialog } from "../../components/invite-dialog";
import { StartPlanToInvite } from "../../components/start-plan";
import { UserCard } from "../../components/user-card";
import { inviteFromForm } from "../../lib/member-invitations.server";
import { filterMembers, invitationFilterOf, memberFilters } from "../../lib/invites";
import { billing, identity } from "../../lib/services.server";
import { assertSameOrigin, getViewer, requireUser, roleIn, unwrap } from "../../lib/session.server";
import { forgetWorkspace } from "../../lib/workspace-choice";
import { Unavailable } from "../../components/boundary";
import { isFailed, part, type Failed } from "../../lib/partial";

export function meta({ params, ...args }: Route.MetaArgs) {
  return page(args, { title: `Members · ${params.owner} · g1t` });
}

/**
 * Members: who is in the workspace, their roles, and for owners the way to
 * invite someone (a dialog) and the outside collaborators. Invitations
 * have a page of their own, next door; the base permission and the
 * member privileges are under Permissions.
 */
export async function loader({ params, context }: Route.LoaderArgs) {
  const viewer = getViewer(context);
  const role = roleIn(viewer, params.owner);
  // Who is in a workspace is its members' business; anyone else, including
  // someone a repository is shared with, gets nothing here.
  if (!role) throw data(null, { status: 404 });
  const owner = role === "owner";
  const [members, workspace, outside, teams, free, invites] = await Promise.all([
    // The members are what the page is about. The rest is beside them, and
    // each part says so in its place when it cannot be read.
    identity.listMembers(params.owner, viewer),
    // Only for the workspace's name, which its address stands in for.
    identity.getWorkspace(params.owner).catch(() => null),
    owner ? part(identity.outsideCollaborators(viewer, params.owner), "Outside collaborators") : null,
    // Each member's teams, as the viewer may see them.
    part(identity.teamMemberships(viewer, params.owner), "Each member's teams"),
    // A free workspace adds no one until it starts the plan; identity
    // refuses it either way, so a failure here only hides the note.
    billing.freeWorkspaces([params.owner]).catch(() => [] as string[]),
    // How many invitations wait, for the line that leads to them.
    owner ? part(identity.workspaceInvites(params.owner, viewer), "Invitations") : null,
  ]);
  return {
    role,
    name: workspace?.name?.trim() || params.owner,
    free: free.includes(params.owner.toLowerCase()),
    members: unwrap(members),
    outside: isFailed(outside) ? outside : outside?.ok ? outside.value : [],
    teams: Object.fromEntries((!isFailed(teams) && teams.ok ? teams.value : []).map((person) => [person.username, person.teams])),
    teamsFailed: isFailed(teams) ? teams : null,
    /** Null when how many wait could not be read: the line still leads to them. */
    pendingInvitations: isFailed(invites) ? null : invites?.ok ? invites.value.filter((invite) => invitationFilterOf(invite.status) === "pending").length : 0,
    me: viewer?.username ?? null,
  };
}

export async function action({ request, params, context }: Route.ActionArgs) {
  assertSameOrigin(request);
  const user = requireUser(context, request);
  const form = await request.formData();
  const target = String(form.get("member") ?? "").trim();
  // Owner or member, and the roles that add to a member.
  if (form.get("action") === "role") {
    const role = form.get("role") === "owner" ? "owner" : "member";
    const result = await identity.updateMember(user, params.owner, target, { role });
    return result.ok ? { changed: target } : { error: result.error.message, row: target };
  }
  if (form.get("action") === "org-roles") {
    const roles = String(form.get("org_roles") ?? "")
      .split(",")
      .filter((role): role is OrgRole => (ORG_ROLES as readonly string[]).includes(role));
    const result = await identity.updateMember(user, params.owner, target, { org_roles: roles });
    return result.ok ? { changed: target } : { error: result.error.message, row: target };
  }
  if (form.get("action") === "transfer") {
    const result = await identity.transferOwnership(user, params.owner, target);
    return result.ok ? { transferred: target } : { error: result.error.message, row: target };
  }
  if (form.get("action") === "leave") {
    const result = await identity.leaveWorkspace(user, params.owner);
    if (!result.ok) return { error: result.error.message, leaving: true };
    const secure = new URL(request.url).protocol === "https:";
    throw redirect("/", { headers: { "Set-Cookie": forgetWorkspace(secure) } });
  }
  if (form.get("action") === "remove") {
    const result = await identity.removeMember(user, params.owner, target);
    return result.ok ? null : { error: result.error.message, converting: false };
  }
  // Inviting: from the dialog (`add`), or an outside collaborator as a
  // member (`convert`). Nobody joins without saying yes.
  const invited = await inviteFromForm(user, params.owner, form);
  if ("error" in invited) return { ...invited, converting: form.get("action") === "convert" };
  if (form.get("action") === "convert") return { converted: target };
  return invited;
}

/** What a member's roles say about them, as badges: owner or member, then the roles on top. */
function RoleBadges({ member }: { member: Member }) {
  return (
    <span className="flex flex-wrap justify-end gap-1">
      {member.role === "owner" ? <Badge tone="accent">Owner</Badge> : <Badge>Member</Badge>}
      {(member.org_roles ?? []).map((role) => (
        <Hint key={role} label={ORG_ROLE_SUMMARIES[role]}>
          <Badge tone="info" tabIndex={0}>
            {ORG_ROLE_LABELS[role]}
          </Badge>
        </Hint>
      ))}
    </span>
  );
}

/** Whether a member has two-factor authentication on, for owners. */
function TwoFactorMark({ on }: { on: boolean | null | undefined }) {
  if (on == null) return null;
  return on ? (
    <Hint label="Two-factor authentication is on">
      <span tabIndex={0} className="inline-flex text-success" aria-label="Two-factor authentication on">
        <ShieldCheck size={15} />
      </span>
    </Hint>
  ) : (
    <Hint label="Two-factor authentication is off">
      <span tabIndex={0} className="inline-flex text-warn" aria-label="Two-factor authentication off">
        <ShieldAlert size={15} />
      </span>
    </Hint>
  );
}

/** An owner's menu for one member: their role, the roles on top, handing over and removing. */
function MemberMenu({ member, self, owners, slug }: { member: Member; self: boolean; owners: number; slug: string }) {
  const submit = useSubmit();
  const [confirm, setConfirm] = useState<"transfer" | "remove" | null>(null);
  const roles = member.org_roles ?? [];
  const post = (fields: Record<string, string>) => submit({ ...fields, member: member.username }, { method: "post", preventScrollReset: true });
  const lastOwner = member.role === "owner" && owners <= 1;
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button type="button" aria-label={`Manage ${member.username}`} variant="ghost" size="inline" className="p-1.5 text-faint max-sm:p-2.5">
            <Ellipsis size={16} />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-64">
          <DropdownMenuLabel>Role in {slug}</DropdownMenuLabel>
          {member.role === "member" ? (
            <DropdownMenuItem onSelect={() => post({ action: "role", role: "owner" })}>Make owner</DropdownMenuItem>
          ) : (
            <DropdownMenuItem disabled={lastOwner} onSelect={() => post({ action: "role", role: "member" })}>
              {lastOwner ? "The only owner" : "Make member"}
            </DropdownMenuItem>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuLabel>Also</DropdownMenuLabel>
          {ORG_ROLES.map((role) => {
            const has = roles.includes(role);
            const next = has ? roles.filter((other) => other !== role) : [...roles, role];
            return (
              <DropdownMenuItem key={role} onSelect={() => post({ action: "org-roles", org_roles: next.join(",") })}>
                <span className="flex size-4 items-center justify-center">{has && <Check />}</span>
                {ORG_ROLE_LABELS[role]}
              </DropdownMenuItem>
            );
          })}
          {!self && (
            <>
              <DropdownMenuSeparator />
              {member.role === "member" && <DropdownMenuItem onSelect={() => setConfirm("transfer")}>Transfer ownership…</DropdownMenuItem>}
              <DropdownMenuItem disabled={lastOwner} onSelect={() => setConfirm("remove")} className="text-danger">
                Remove from {slug}…
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <AlertDialog open={confirm !== null} onOpenChange={(open) => !open && setConfirm(null)}>
        <AlertDialogContent>
          <Form method="post" className="grid gap-4" onSubmit={() => setConfirm(null)}>
            <input type="hidden" name="action" value={confirm === "transfer" ? "transfer" : "remove"} />
            <input type="hidden" name="member" value={member.username} />
            <AlertDialogHeader>
              <AlertDialogTitle>{confirm === "transfer" ? `Hand ${slug} to ${member.username}?` : `Remove ${member.username} from ${slug}?`}</AlertDialogTitle>
              <AlertDialogDescription>
                {confirm === "transfer"
                  ? `${member.username} becomes an owner and you a member. Only an owner can make you an owner again.`
                  : `Their roles on ${slug}'s repositories and their place in its teams go too. To keep them on a repository, add them back to it as an outside collaborator.`}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel type="button">Cancel</AlertDialogCancel>
              <SubmitButton variant="destructive" match={{ action: confirm ?? "", member: member.username }} pending="Working…">
                {confirm === "transfer" ? "Transfer ownership" : "Remove"}
              </SubmitButton>
            </AlertDialogFooter>
          </Form>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

/** Leaving the workspace, for anyone in it. */
function LeaveSection({ slug, soleOwner, error }: { slug: string; soleOwner: boolean; error: string | null }) {
  const [open, setOpen] = useState(false);
  return (
    <section id="leave" className="mt-10 scroll-mt-[calc(var(--topbar-h)+1rem)] border-t border-line pt-8">
      <h2 className="font-medium">Leave {slug}</h2>
      <p className="mt-1 text-sm text-muted">
        {soleOwner
          ? `You are ${slug}'s only owner. Make another member an owner first, or delete the workspace in its settings.`
          : "Your roles on its repositories and your place in its teams go too. An owner can add you again."}
      </p>
      <div className="mt-4">
        <Button variant="destructive" type="button" disabled={soleOwner} onClick={() => setOpen(true)}>
          Leave {slug}
        </Button>
      </div>
      <ErrorText>{error}</ErrorText>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent>
          <Form method="post" className="grid gap-4">
            <input type="hidden" name="action" value="leave" />
            <AlertDialogHeader>
              <AlertDialogTitle>Leave {slug}?</AlertDialogTitle>
              <AlertDialogDescription>You lose access to its private repositories at once.</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel type="button">Cancel</AlertDialogCancel>
              <SubmitButton variant="destructive" match={{ action: "leave" }} pending="Leaving…">
                Leave
              </SubmitButton>
            </AlertDialogFooter>
          </Form>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}

/**
 * The row above the list: words to search by, the role, two-factor (for
 * owners) and a team, each kept in the address so a filtered list can be
 * shared; and, for owners, Invite.
 */
function MembersToolbar({
  owner,
  teams,
  invite,
}: {
  owner: boolean;
  /** The teams any listed member is on, to filter by. */
  teams: { slug: string; name: string }[];
  invite: ReactNode;
}) {
  const [search, setSearch] = useSearchParams();
  const filters = memberFilters(search);
  const [words, setWords] = useState(filters.query);
  // The box is typed into freely; the address follows a moment later.
  useEffect(() => {
    if (words === filters.query) return;
    const timer = setTimeout(() => {
      const next = new URLSearchParams(search);
      if (words.trim()) next.set("q", words.trim());
      else next.delete("q");
      setSearch(next, { replace: true, preventScrollReset: true });
    }, 200);
    return () => clearTimeout(timer);
  }, [words, filters.query, search, setSearch]);
  const set = (key: string, value: string) => {
    const next = new URLSearchParams(search);
    if (value && value !== "all") next.set(key, value);
    else next.delete(key);
    setSearch(next, { replace: true, preventScrollReset: true });
  };
  return (
    <div className="mb-4 flex flex-wrap items-center gap-2">
      <div className="relative min-w-0 grow basis-56">
        <Search size={14} aria-hidden="true" className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-faint" />
        <Input
          type="search"
          aria-label="Search members"
          placeholder="Search by username or name"
          value={words}
          onChange={(event) => setWords(event.currentTarget.value)}
          className="pl-9"
        />
      </div>
      <SelectField
        aria-label="Role"
        value={filters.role}
        onValueChange={(value) => set("role", value)}
        className="w-auto min-w-28"
        options={[
          { value: "all", label: "Any role" },
          { value: "owner", label: "Owners" },
          { value: "member", label: "Members" },
        ]}
      />
      {owner && (
        <SelectField
          aria-label="Two-factor authentication"
          value={filters.twoFactor}
          onValueChange={(value) => set("2fa", value)}
          className="w-auto min-w-28"
          options={[
            { value: "all", label: "Two-factor: any" },
            { value: "on", label: "Two-factor on" },
            { value: "off", label: "Two-factor off" },
          ]}
        />
      )}
      {teams.length > 0 && (
        <SelectField
          aria-label="Team"
          value={filters.team ?? "all"}
          onValueChange={(value) => set("team", value)}
          className="w-auto min-w-28"
          options={[{ value: "all", label: "Any team" }, ...teams.map((team) => ({ value: team.slug.toLowerCase(), label: team.name }))]}
        />
      )}
      {invite && <div className="ml-auto">{invite}</div>}
    </div>
  );
}

export default function WorkspaceMembers({ loaderData, actionData, params }: Route.ComponentProps) {
  const { role, members, outside, teams, teamsFailed, free, me, name, pendingInvitations } = loaderData;
  const owner = role === "owner";
  const owners = members.filter((member) => member.role === "owner").length;
  const rowError = (username: string) => (actionData && "row" in actionData && actionData.row === username ? (actionData.error ?? null) : null);
  const [search, setSearch] = useSearchParams();
  const tab = search.get("tab") === "outside" && owner ? "outside" : "members";
  const filters = memberFilters(search);
  const shown = filterMembers(members, filters, teams);
  const filtered = filters.role !== "all" || filters.twoFactor !== "all" || filters.team !== null || filters.query !== "";
  // Every team a listed member is on, once each, to filter by.
  const teamChoices = [
    ...new Map(
      Object.values(teams)
        .flat()
        .map((team) => [team.slug.toLowerCase(), team]),
    ).values(),
  ].sort((a, b) => a.name.localeCompare(b.name));
  // Who was just invited from the dialog, said under the list.
  const [invited, setInvited] = useState<string | null>(null);
  const invite = owner && !free ? <InviteDialog name={name} action={`/${params.owner}/-/members`} onInvited={setInvited} /> : null;
  const membersTab = (
    <>
      <MembersToolbar owner={owner} teams={teamChoices} invite={invite} />
      {teamsFailed && (
        <div className="mb-4">
          <Unavailable what={teamsFailed.what} compact />
        </div>
      )}
      {owner && free && (
        <div className="mb-4">
          <StartPlanToInvite workspace={params.owner} owner={owner} />
        </div>
      )}
      {shown.length === 0 ? (
        <EmptyState title={filtered ? "No members match" : "No members yet"}>
          {filtered ? "Clear a filter, or search for something else." : "Invite someone and they are listed here once they accept."}
        </EmptyState>
      ) : (
        <Card asChild tone="plain" divided>
          <ul>
            {shown.map((member) => (
              <li key={member.username} className="flex flex-wrap items-center gap-3 px-4 py-3">
                <WithPresence person={{ username: member.username }} size={28}>
                  <Avatar name={member.username} image={member.avatar} size={28} />
                </WithPresence>
                <div className="min-w-0 grow truncate">
                  <UserCard username={member.username}>
                    <Link to={`/u/${member.username}`} className="font-mono text-sm hover:text-accent">
                      {member.username}
                    </Link>
                  </UserCard>
                  <PersonStatusEmoji person={{ username: member.username }} size={13} className="ml-1.5 align-[-2px]" />
                  {member.name && <span className="ml-2 hidden text-sm text-muted sm:inline">{member.name}</span>}
                  {(teams[member.username] ?? []).length > 0 && (
                    <div className="mt-1 flex flex-wrap gap-1">
                      {(teams[member.username] ?? []).slice(0, 3).map((team) => (
                        <Link
                          key={team.slug}
                          to={`/${params.owner}/-/teams/${team.slug}`}
                          className="rounded-full border border-line px-2 py-px text-xs text-muted transition-colors hover:border-line-strong hover:text-fg"
                        >
                          {team.name}
                        </Link>
                      ))}
                      {(teams[member.username] ?? []).length > 3 && (
                        <span className="px-1 text-xs text-faint">+{(teams[member.username] ?? []).length - 3} more</span>
                      )}
                    </div>
                  )}
                </div>
                {/* Together, so on a narrow screen they move under the name as one. */}
                <div className="ml-auto flex items-center gap-2">
                  {owner && <TwoFactorMark on={member.two_factor} />}
                  <RoleBadges member={member} />
                  {owner && <MemberMenu member={member} self={member.username === me} owners={owners} slug={params.owner} />}
                </div>
                {rowError(member.username) && (
                  <p className="basis-full text-sm text-danger" role="alert">
                    {rowError(member.username)}
                  </p>
                )}
              </li>
            ))}
          </ul>
        </Card>
      )}
      <p className="mt-2 text-xs text-faint">
        {filtered ? `${shown.length} of ${members.length}` : members.length} {members.length === 1 ? "member" : "members"}
        {owner && pendingInvitations === null && (
          <>
            {" · "}
            <Link
              to={`/${params.owner}/-/members/invitations?state=pending`}
              className="inline-flex items-center gap-1 text-muted underline-offset-4 hover:text-fg hover:underline"
            >
              <Mail size={12} aria-hidden="true" />
              Invitations
            </Link>
          </>
        )}
        {owner && pendingInvitations != null && pendingInvitations > 0 && (
          <>
            {" · "}
            <Link
              to={`/${params.owner}/-/members/invitations?state=pending`}
              className="inline-flex items-center gap-1 text-muted underline-offset-4 hover:text-fg hover:underline"
            >
              <Mail size={12} aria-hidden="true" />
              {pendingInvitations} {pendingInvitations === 1 ? "invitation" : "invitations"} waiting
            </Link>
          </>
        )}
      </p>
      {invited && (
        <p className="mt-3 text-sm text-muted" role="status">
          Invitation to join {name} sent to <span className="text-fg">{invited}</span>. They join once they accept; until then it is listed under{" "}
          <Link to={`/${params.owner}/-/members/invitations`} className="text-accent underline-offset-4 hover:underline">
            Invitations
          </Link>
          .
        </p>
      )}
      {actionData && "transferred" in actionData && (
        <p className="mt-3 text-sm text-muted" role="status">
          <span className="font-mono text-fg">{actionData.transferred}</span> owns {params.owner} now, and you are a member.
        </p>
      )}
      {actionData && "converted" in actionData && (
        <p className="mt-3 text-sm text-muted" role="status">
          <span className="font-mono text-fg">{actionData.converted}</span> is invited to join {params.owner} as a member, and joins once they accept.
        </p>
      )}
      {actionData &&
        "error" in actionData &&
        !("row" in actionData) &&
        !("leaving" in actionData) &&
        !("converting" in actionData && actionData.converting) && <ErrorText>{actionData.error}</ErrorText>}

      <LeaveSection slug={params.owner} soleOwner={owner && owners <= 1} error={actionData && "leaving" in actionData ? (actionData.error ?? null) : null} />
    </>
  );
  return (
    <div className="max-w-3xl">
      {owner ? (
        <Tabs
          value={tab}
          onValueChange={(value) => {
            const next = new URLSearchParams(search);
            if (value === "outside") next.set("tab", "outside");
            else next.delete("tab");
            setSearch(next, { replace: true, preventScrollReset: true });
          }}
        >
          <TabsList className="mb-4">
            <TabsTrigger value="members">Members · {members.length}</TabsTrigger>
            <TabsTrigger value="outside">{isFailed(outside) ? "Outside collaborators" : `Outside collaborators · ${outside.length}`}</TabsTrigger>
          </TabsList>
          <TabsContent value="members">{membersTab}</TabsContent>
          <TabsContent value="outside">
            {isFailed(outside) ? (
              <Unavailable what={outside.what} />
            ) : (
              <OutsideCollaborators
                people={outside}
                slug={params.owner}
                free={free}
                error={actionData && "converting" in actionData && actionData.converting ? actionData.error : null}
              />
            )}
          </TabsContent>
        </Tabs>
      ) : (
        membersTab
      )}
    </div>
  );
}

/** People with a role on some of the workspace's repositories who are not members of it. */
function OutsideCollaborators({
  people,
  slug,
  free,
  error,
}: {
  people: Exclude<Route.ComponentProps["loaderData"]["outside"], Failed>;
  slug: string;
  free: boolean;
  error: string | null | undefined;
}) {
  return (
    <>
      <p className="mb-4 text-sm text-muted">
        People given a role on one or more of {slug}'s repositories without being members. They see only those repositories. Change or take away a role on the
        repository's Access settings.
      </p>
      {free && (
        <div className="mb-4">
          <StartPlanToInvite workspace={slug} owner />
        </div>
      )}
      {people.length === 0 ? (
        <Card tone="plain" className="border-dashed px-6 py-10 text-center">
          <Users size={18} className="mx-auto text-faint" />
          <p className="mt-2 text-sm font-medium">No outside collaborators</p>
          <p className="mt-1 text-sm text-muted">Add someone to a single repository from its Settings → Access.</p>
        </Card>
      ) : (
        <Card asChild tone="plain" divided>
          <ul>
            {people.map((person) => (
              <li key={person.username} className="px-4 py-3">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                  <Avatar name={person.username} image={person.avatar} size={28} />
                  <div className="min-w-0 grow basis-32">
                    <UserCard username={person.username}>
                      <Link to={`/u/${person.username}`} className="font-mono text-sm hover:text-accent">
                        {person.username}
                      </Link>
                    </UserCard>
                    {person.name && <span className="ml-2 text-sm text-muted">{person.name}</span>}
                  </div>
                  {!free && (
                    <Form method="post">
                      <input type="hidden" name="action" value="convert" />
                      <input type="hidden" name="member" value={person.username} />
                      <SubmitButton variant="outline" match={{ action: "convert", member: person.username }} pending="Inviting…">
                        Invite as a member
                      </SubmitButton>
                    </Form>
                  )}
                </div>
                <ul className="mt-2 flex flex-wrap gap-1.5 pl-10">
                  {person.repos.map((grant) => (
                    <li key={grant.repo}>
                      <Link
                        to={`/${grant.repo}/settings/access`}
                        className="group inline-flex items-center gap-1.5 rounded-full border border-line px-2 py-0.5 text-xs transition-colors hover:border-line-strong hover:bg-surface"
                      >
                        <span className="font-mono text-fg/90">{grant.repo}</span>
                        <span className="text-muted">{REPO_ROLE_LABELS[grant.role]}</span>
                        <ArrowUpRight size={11} className="text-faint group-hover:text-fg" />
                      </Link>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        </Card>
      )}
      <ErrorText>{error}</ErrorText>
    </>
  );
}
