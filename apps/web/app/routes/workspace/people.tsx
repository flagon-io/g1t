import { ArrowUpRight, Check, Ellipsis, ShieldAlert, ShieldCheck, Users } from "lucide-react";
import { useState } from "react";
import { Form, Link, data, redirect, useSearchParams, useSubmit } from "react-router";

import {
  BASE_PERMISSIONS,
  BASE_PERMISSION_LABELS,
  type BasePermission,
  DEFAULT_BASE_PERMISSION,
  type Member,
  ORG_ROLES,
  ORG_ROLE_LABELS,
  ORG_ROLE_SUMMARIES,
  type OrgRole,
  REPO_ROLE_LABELS,
} from "@g1t/contracts";

import type { Route } from "./+types/people";
import { page } from "../../lib/meta";
import { Avatar, Button, CopyLine, ErrorText, Field, Input, Pill, SubmitButton, TimeAgo } from "../../components/ui";
import { Badge } from "../../components/ui/badge";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../../components/ui/alert-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../../components/ui/dropdown-menu";
import { Hint } from "../../components/ui/hint";
import { forgetWorkspace } from "../../lib/workspace-choice";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../components/ui/tabs";
import { inviteLink, inviteState, moreInvitesMailto } from "../../lib/invites";
import { billing, identity } from "../../lib/services.server";
import { StartPlanToInvite } from "../../components/start-plan";
import {
  assertSameOrigin,
  getViewer,
  requireUser,
  roleIn,
  unwrap,
} from "../../lib/session.server";
import { UserCard } from "../../components/user-card";
import { PeoplePicker } from "../../components/people-picker";
import { inviteTarget } from "../../lib/people-search";

export function meta({ params, ...args }: Route.MetaArgs) {
  return page(args, { title: `People · ${params.owner} · g1t` });
}

export async function loader({ params, context, request }: Route.LoaderArgs) {
  const viewer = getViewer(context);
  const role = roleIn(viewer, params.owner);
  // Who is in a workspace is its members' business; anyone else, including
  // someone a repository is shared with, gets nothing here.
  if (!role) throw data(null, { status: 404 });
  const owner = role === "owner";
  const [members, invites, workspace, outside, teams, free] = await Promise.all([
    identity.listMembers(params.owner, viewer),
    owner ? identity.workspaceInvites(params.owner, viewer).catch(() => null) : null,
    identity.getWorkspace(params.owner),
    owner ? identity.outsideCollaborators(viewer, params.owner).catch(() => null) : null,
    // Each member's teams, as the viewer may see them.
    identity.teamMemberships(viewer, params.owner).catch(() => null),
    // A free workspace adds no one until it starts the plan; identity
    // refuses it either way, so a failure here only hides the note.
    billing.freeWorkspaces([params.owner]).catch(() => [] as string[]),
  ]);
  return {
    role,
    free: free.includes(params.owner.toLowerCase()),
    members: unwrap(members),
    invites: invites?.ok ? invites.value : [],
    base: workspace?.basePermission ?? DEFAULT_BASE_PERMISSION,
    outside: outside?.ok ? outside.value : [],
    teams: Object.fromEntries((teams?.ok ? teams.value : []).map((person) => [person.username, person.teams])),
    origin: new URL(request.url).origin,
    me: viewer?.username ?? null,
  };
}

export async function action({ request, params, context }: Route.ActionArgs) {
  assertSameOrigin(request);
  const user = requireUser(context, request);
  const form = await request.formData();
  if (form.get("action") === "revoke-invite") {
    const result = await identity.revokeWorkspaceInvite(user, params.owner, String(form.get("id") ?? ""));
    return result.ok ? null : { error: result.error.message };
  }
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
  if (form.get("action") === "base-permission") {
    const base = String(form.get("base") ?? "");
    if (!(BASE_PERMISSIONS as readonly string[]).includes(base)) return { error: "Choose a base permission." };
    const result = await identity.setBasePermission(user, params.owner, base as BasePermission);
    return result.ok ? { based: result.value } : { error: result.error.message, base: true };
  }
  const member = String(form.get("member") ?? "").trim();
  if (form.get("action") === "remove") {
    const result = await identity.removeMember(user, params.owner, member);
    return result.ok ? null : { error: result.error.message, converting: false };
  }
  // Nobody joins without saying yes: a username or an address gets an
  // invitation to accept or decline, with the role chosen here.
  const who = inviteTarget(member);
  if (!who) return { error: "Enter a g1t username or an email address.", outOfInvites: false };
  const role = form.get("role") === "owner" ? "owner" : "member";
  const result = await identity.inviteMember(user, params.owner, { ...who, role });
  if (!result.ok) {
    return { error: result.error.message, outOfInvites: result.error.code === "limit", converting: form.get("action") === "convert" };
  }
  if (form.get("action") === "convert") return { converted: member };
  return { invited: "email" in who ? who.email : `@${"username" in who ? who.username : member}`, outOfInvites: false };
}

/** What the base permission means for members, in a sentence. */
const BASE_MEANS: Record<BasePermission, string> = {
  none: "Members see only public repositories and the ones they are given a role on.",
  read: "Members can see and clone every repository, open issues and pull requests, and comment.",
  write: "Members can see every repository, manage its issues and pull requests, push, merge, and put agents to work.",
  admin: "Members can do everything on every repository, including its settings, webhooks, secrets and who has access. Only owners transfer or delete one.",
};

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
  const post = (fields: Record<string, string>) =>
    submit({ ...fields, member: member.username }, { method: "post", preventScrollReset: true });
  const lastOwner = member.role === "owner" && owners <= 1;
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={`Manage ${member.username}`}
            className="rounded-md p-1.5 text-faint transition-colors hover:bg-raised hover:text-fg"
          >
            <Ellipsis size={16} />
          </button>
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
              {member.role === "member" && (
                <DropdownMenuItem onSelect={() => setConfirm("transfer")}>Transfer ownership…</DropdownMenuItem>
              )}
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
              <AlertDialogTitle>
                {confirm === "transfer" ? `Hand ${slug} to ${member.username}?` : `Remove ${member.username} from ${slug}?`}
              </AlertDialogTitle>
              <AlertDialogDescription>
                {confirm === "transfer"
                  ? `${member.username} becomes an owner and you a member. Only an owner can make you an owner again.`
                  : `Their roles on ${slug}'s repositories and their place in its teams go too. To keep them on a repository, add them back to it as an outside collaborator.`}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel type="button">Cancel</AlertDialogCancel>
              <SubmitButton variant="danger" match={{ action: confirm ?? "", member: member.username }} pending="Working…">
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
    <section id="leave" className="mt-10 scroll-mt-20 border-t border-line pt-8">
      <h2 className="font-medium">Leave {slug}</h2>
      <p className="mt-1 text-sm text-muted">
        {soleOwner
          ? `You are ${slug}'s only owner. Make another member an owner first, or delete the workspace in its settings.`
          : "Your roles on its repositories and your place in its teams go too. An owner can add you again."}
      </p>
      <div className="mt-4">
        <Button variant="danger" type="button" disabled={soleOwner} onClick={() => setOpen(true)}>
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
              <SubmitButton variant="danger" match={{ action: "leave" }} pending="Leaving…">
                Leave
              </SubmitButton>
            </AlertDialogFooter>
          </Form>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}

export default function WorkspacePeople({ loaderData, actionData, params }: Route.ComponentProps) {
  const { role, members, invites, origin, base, outside, teams, free, me } = loaderData;
  const owner = role === "owner";
  const owners = members.filter((member) => member.role === "owner").length;
  const rowError = (username: string) =>
    actionData && "row" in actionData && actionData.row === username ? (actionData.error ?? null) : null;
  // Waiting to be used, or used by someone still confirming their email:
  // either can be revoked.
  // Waiting for an answer to a workspace invitation, too.
  const pending = invites.filter(
    (invite) => invite.status === "pending" || invite.status === "awaiting_confirmation" || invite.status === "awaiting_answer",
  );
  const [search, setSearch] = useSearchParams();
  const tab = search.get("tab") === "outside" && owner ? "outside" : "members";
  const membersTab = (
    <>
      <ul className="divide-y divide-line rounded-xl border border-line">
        {members.map((member) => (
          <li key={member.username} className="flex flex-wrap items-center gap-3 px-4 py-3">
            <Avatar name={member.username} image={member.avatar} size={28} />
            <div className="min-w-0 grow truncate">
              <UserCard username={member.username}>
                <Link to={`/u/${member.username}`} className="font-mono text-sm hover:text-accent">
                  {member.username}
                </Link>
              </UserCard>
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
      {owner && free && (
        <div className="mt-6">
          <StartPlanToInvite workspace={params.owner} owner={owner} />
        </div>
      )}
      {owner && !free && (
        // Empty again once the person is on the list; kept as typed when it failed.
        <Form
          method="post"
          key={`${members.length}:${pending.length}`}
          className="mt-6 flex flex-col gap-3 sm:flex-row sm:items-start"
        >
          <input type="hidden" name="action" value="add" />
          <div className="grow">
            <Field
              label="Invite someone"
              hint="Search people on g1t by username or name, or enter an email address. They get an invitation in their inbox and by email, and join once they accept. An address without a g1t account gets an invite to make one, using one of your invites."
            >
              <PeoplePicker name="member" placeholder="username, name or name@example.com" />
            </Field>
          </div>
          <label className="block">
            <span className="mb-1.5 block text-sm font-medium text-muted">Role</span>
            <select
              name="role"
              defaultValue="member"
              className="w-full rounded-md border border-line bg-bg px-3 py-2 text-sm outline-none hover:border-line-strong focus:border-accent-dim sm:w-auto"
            >
              <option value="member">Member</option>
              <option value="owner">Owner</option>
            </select>
          </label>
          <div className="sm:pt-[1.625rem]">
            <SubmitButton match={{ action: "add" }} pending="Inviting…">
              Invite
            </SubmitButton>
          </div>
        </Form>
      )}
      {actionData && "invited" in actionData && actionData.invited && (
        <p className="text-sm text-muted" role="status">
          Invitation sent to <span className="text-fg">{actionData.invited}</span>. They join once they accept.
        </p>
      )}
      {actionData && "transferred" in actionData && (
        <p className="text-sm text-muted" role="status">
          <span className="font-mono text-fg">{actionData.transferred}</span> owns {params.owner} now, and you are a member.
        </p>
      )}
      {actionData && "converted" in actionData && (
        <p className="text-sm text-muted" role="status">
          <span className="font-mono text-fg">{actionData.converted}</span> is invited to join {params.owner} as a member, and joins once they accept.
        </p>
      )}
      {actionData &&
        !("base" in actionData) &&
        !("row" in actionData) &&
        !("leaving" in actionData) &&
        !("converting" in actionData && actionData.converting) && (
        <ErrorText>{actionData && "error" in actionData ? actionData.error : null}</ErrorText>
      )}
      {actionData && "outOfInvites" in actionData && actionData.outOfInvites && (
        <p className="mt-1 text-sm text-muted">
          <a href={moreInvitesMailto(params.owner)} className="text-accent underline underline-offset-4">
            Ask for more invites
          </a>{" "}
          for {params.owner}.
        </p>
      )}

      {owner && pending.length > 0 && (
        <section className="mt-8">
          <h2 className="text-sm font-medium">Pending invitations</h2>
          <ul className="mt-3 divide-y divide-line rounded-xl border border-line">
            {pending.map((invite) => (
              <li key={invite.id} className="space-y-2 px-4 py-3">
                <div className="flex flex-wrap items-center gap-3">
                  <span className="min-w-0 grow truncate text-sm">
                    {invite.email ??
                      (invite.invitee ? (
                        <UserCard username={invite.invitee}>
                          <Link to={`/u/${invite.invitee}`} className="font-mono hover:text-accent">
                            @{invite.invitee}
                          </Link>
                        </UserCard>
                      ) : (
                        "Anyone with the link"
                      ))}
                  </span>
                  {invite.role === "owner" && <Pill>Owner</Pill>}
                  <Pill>{inviteState(invite).label}</Pill>
                  <Form method="post">
                    <input type="hidden" name="action" value="revoke-invite" />
                    <input type="hidden" name="id" value={invite.id} />
                    <SubmitButton variant="quiet" match={{ action: "revoke-invite", id: invite.id }} pending="Revoking…">
                      Revoke
                    </SubmitButton>
                  </Form>
                </div>
                <p className="text-xs text-faint">
                  By {invite.invitedBy ?? "g1t"} · <TimeAgo at={invite.createdAt} /> · works until{" "}
                  {new Date(invite.expiresAt).toISOString().slice(0, 10)}
                </p>
                {invite.code && <CopyLine text={inviteLink(invite.code, origin)} />}
              </li>
            ))}
          </ul>
        </section>
      )}

      <BasePermissionSection
        // Starts from the saved choice whenever it changes.
        key={base}
        base={base}
        owner={owner}
        slug={params.owner}
        error={actionData && "base" in actionData && "error" in actionData ? (actionData.error ?? null) : null}
        saved={Boolean(actionData && "based" in actionData)}
      />

      <LeaveSection
        slug={params.owner}
        soleOwner={owner && owners <= 1}
        error={actionData && "leaving" in actionData ? (actionData.error ?? null) : null}
      />
    </>
  );
  return (
    <div className="max-w-2xl">
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
          <TabsList className="mb-3">
            <TabsTrigger value="members">Members · {members.length}</TabsTrigger>
            <TabsTrigger value="outside">Outside collaborators · {outside.length}</TabsTrigger>
          </TabsList>
          <TabsContent value="members">{membersTab}</TabsContent>
          <TabsContent value="outside">
            <OutsideCollaborators
              people={outside}
              slug={params.owner}
              free={free}
              error={actionData && "converting" in actionData && actionData.converting ? actionData.error : null}
            />
          </TabsContent>
        </Tabs>
      ) : (
        membersTab
      )}
    </div>
  );
}

/** What members get on every repository, which owners choose. */
function BasePermissionSection({
  base,
  owner,
  slug,
  error,
  saved,
}: {
  base: BasePermission;
  owner: boolean;
  slug: string;
  error: string | null;
  saved: boolean;
}) {
  const [chosen, setChosen] = useState<BasePermission>(base);
  return (
    <section id="base-permission" className="mt-10 scroll-mt-20 border-t border-line pt-8">
      <h2 className="font-medium">Base permission</h2>
      <p className="mt-1 text-sm text-muted">
        The role every member has on each of {slug}'s repositories. Owners are Admins on all of them, and a role given to
        someone on one repository adds to this; it never takes away.
      </p>
      {owner ? (
        <Form method="post" className="mt-4 rounded-xl border border-line bg-surface p-4">
          <input type="hidden" name="action" value="base-permission" />
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
            <Select name="base" value={chosen} onValueChange={(value) => setChosen(value as BasePermission)}>
              <SelectTrigger aria-label="Base permission" className="sm:max-w-48">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {BASE_PERMISSIONS.map((value) => (
                  <SelectItem key={value} value={value} description={BASE_MEANS[value]}>
                    {BASE_PERMISSION_LABELS[value]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <SubmitButton variant="quiet" match={{ action: "base-permission" }} pending="Saving…" disabled={chosen === base}>
              Save
            </SubmitButton>
            {saved && chosen === base && <span className="text-sm text-muted">Saved.</span>}
          </div>
          <p className="mt-3 text-sm text-muted">{BASE_MEANS[chosen]}</p>
          <ErrorText>{error}</ErrorText>
        </Form>
      ) : (
        <div className="mt-4 rounded-xl border border-line bg-surface p-4 text-sm">
          <p>
            <span className="font-medium">{BASE_PERMISSION_LABELS[base]}.</span>{" "}
            <span className="text-muted">{BASE_MEANS[base]}</span>
          </p>
          <p className="mt-2 text-xs text-faint">Owners of the workspace choose it.</p>
        </div>
      )}
    </section>
  );
}

/** People with a role on some of the workspace's repositories who are not members of it. */
function OutsideCollaborators({
  people,
  slug,
  free,
  error,
}: {
  people: Route.ComponentProps["loaderData"]["outside"];
  slug: string;
  free: boolean;
  error: string | null | undefined;
}) {
  return (
    <>
      <p className="mb-4 text-sm text-muted">
        People given a role on one or more of {slug}'s repositories without being members. They see only those
        repositories. Change or take away a role on the repository's Access settings.
      </p>
      {free && (
        <div className="mb-4">
          <StartPlanToInvite workspace={slug} owner />
        </div>
      )}
      {people.length === 0 ? (
        <div className="rounded-xl border border-dashed border-line px-6 py-10 text-center">
          <Users size={18} className="mx-auto text-faint" />
          <p className="mt-2 text-sm font-medium">No outside collaborators</p>
          <p className="mt-1 text-sm text-muted">Add someone to a single repository from its Settings → Access.</p>
        </div>
      ) : (
        <ul className="divide-y divide-line rounded-xl border border-line">
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
                    <SubmitButton variant="quiet" match={{ action: "convert", member: person.username }} pending="Inviting…">
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
      )}
      <ErrorText>{error}</ErrorText>
    </>
  );
}
