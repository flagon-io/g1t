import { Mail, UserPlus, Users } from "lucide-react";
import { useEffect, useState } from "react";
import { Form, Link, useFetcher } from "react-router";

import {
  BASE_PERMISSION_LABELS,
  REPO_ROLES,
  REPO_ROLE_LABELS,
  type Collaborator,
  type RepoInvitation,
  type RepoRole,
  type RepoTeam,
  type Team,
  baseRole,
} from "@g1t/contracts";

import type { Route } from "./+types/settings-access";
import { RoleSelect, RolesTable } from "../../components/access";
import { RepoSettingsHeading } from "../../components/repo-settings-heading";
import { StartPlanToInvite } from "../../components/start-plan";
import { SettingsSection as Section } from "../../components/settings-section";
import { Avatar, Button, ErrorText, Field, Input, SubmitButton } from "../../components/ui";
import { Badge } from "../../components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../components/ui/select";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../../components/ui/alert-dialog";
import { page } from "../../lib/meta";
import { refusal, requireInsider } from "../../lib/access.server";
import { billing, identity } from "../../lib/services.server";
import { assertSameOrigin, requireUser, roleIn, unwrap } from "../../lib/session.server";

export function meta({ params, ...args }: Route.MetaArgs) {
  return page(args, { title: `Access · ${params.owner}/${params.repo} · g1t` });
}

export async function loader({ params, context }: Route.LoaderArgs) {
  // Write and up see who has access; Admins change it. To anyone without a
  // role here the page does not exist.
  const { viewer, access } = await requireInsider(context, params, "push");
  const manage = access.can.manage_access;
  // The workspace's teams, for Add team: only Admins add one, and a
  // failure there leaves the rest of the page as it is.
  const [found, teams, free] = await Promise.all([
    identity.repoAccess(params.owner, params.repo, viewer),
    manage ? identity.listTeams(viewer, params.owner).catch(() => null) : Promise.resolve(null),
    // A free workspace invites no one from outside; identity refuses it
    // either way, so a failure here only hides the note.
    manage ? billing.freeWorkspaces([params.owner]).catch(() => [] as string[]) : Promise.resolve([] as string[]),
  ]);
  return {
    access: unwrap(found),
    teams: teams?.ok ? teams.value : ([] as Team[]),
    manage,
    free: free.includes(params.owner.toLowerCase()),
    // Owners change the base permission, on the workspace's People page.
    owner: roleIn(viewer, params.owner) === "owner",
  };
}

/** What a form on this page came back with. */
type Outcome = { intent: string; ok: boolean; message: string | null; error: string | null };

const isRole = (value: string): value is RepoRole => (REPO_ROLES as readonly string[]).includes(value);

export async function action({ request, params, context }: Route.ActionArgs): Promise<Outcome> {
  assertSameOrigin(request);
  const user = requireUser(context, request);
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const text = (name: string) => String(form.get(name) ?? "").trim();
  const failed = (error: string): Outcome => ({ intent, ok: false, message: null, error });
  const refused = await refusal(context, params, "manage_access");
  if (refused) return failed(refused);
  const role = text("role");

  switch (intent) {
    case "add": {
      const invitee = text("invitee");
      if (!invitee) return failed("Enter a username or an email address.");
      if (!isRole(role)) return failed("Choose a role.");
      const added = await identity.addCollaborator(user, params.owner, params.repo, invitee, role);
      if (!added.ok) return failed(added.error.message);
      const label = REPO_ROLE_LABELS[role];
      if (added.value.result === "granted") {
        return { intent, ok: true, error: null, message: `${added.value.collaborator.username} now has the ${label} role.` };
      }
      const invitation = added.value.invitation;
      return {
        intent,
        ok: true,
        error: null,
        message: invitation.invitee
          ? `We sent ${invitation.invitee} an invitation. They get the ${label} role when they accept it.`
          : `We sent an invite to ${invitation.email ?? invitee}. They get the ${label} role once they make an account and join.`,
      };
    }
    case "role": {
      if (!isRole(role)) return failed("Choose a role.");
      const changed = await identity.setCollaboratorRole(user, params.owner, params.repo, text("username"), role);
      return changed.ok
        ? { intent, ok: true, error: null, message: `${changed.value.username} has the ${REPO_ROLE_LABELS[changed.value.role]} role.` }
        : failed(changed.error.message);
    }
    case "remove": {
      const removed = await identity.removeCollaborator(user, params.owner, params.repo, text("username"));
      return removed.ok
        ? { intent, ok: true, error: null, message: `${text("username")} no longer has a role given here.` }
        : failed(removed.error.message);
    }
    case "team-add":
    case "team-role": {
      const team = text("team");
      if (!team) return failed("Choose a team.");
      if (!isRole(role)) return failed("Choose a role.");
      const set = await identity.setTeamRepo(user, params.owner, team, params.owner, params.repo, role);
      return set.ok
        ? { intent, ok: true, error: null, message: `${team} has the ${REPO_ROLE_LABELS[set.value.role]} role.` }
        : failed(set.error.message);
    }
    case "team-remove": {
      const team = text("team");
      const removed = await identity.removeTeamRepo(user, params.owner, team, params.owner, params.repo);
      return removed.ok
        ? { intent, ok: true, error: null, message: `${team} no longer has a role here.` }
        : failed(removed.error.message);
    }
    case "revoke": {
      const revoked = await identity.revokeRepoInvitation(user, params.owner, params.repo, text("id"));
      return revoked.ok ? { intent, ok: true, error: null, message: null } : failed(revoked.error.message);
    }
    default:
      return failed("Unknown request.");
  }
}

const SOURCE: Record<Collaborator["source"], string> = {
  owner: "Owner of the workspace",
  base: "Member, by the base permission",
  direct: "Given a role here",
  team: "Through a team",
};

export default function RepoAccessSettings({ loaderData, actionData, params }: Route.ComponentProps) {
  const { access, manage, owner, teams, free } = loaderData;
  const base = `/${params.owner}/${params.repo}`;
  const full = `${params.owner}/${params.repo}`;
  const pending = access.invitations.filter((invitation) => invitation.status === "pending");
  const people = [...access.people].sort(
    (a, b) => REPO_ROLES.indexOf(b.role) - REPO_ROLES.indexOf(a.role) || a.username.localeCompare(b.username),
  );
  const result = actionData?.intent === "add" ? actionData : undefined;
  const teamResult = actionData?.intent === "team-add" ? actionData : undefined;
  const repoTeams = [...(access.teams ?? [])].sort(
    (a, b) => REPO_ROLES.indexOf(b.role) - REPO_ROLES.indexOf(a.role) || a.name.localeCompare(b.name),
  );
  const listed = new Set(repoTeams.map((team) => team.slug));
  const addable = teams.filter((team) => !listed.has(team.slug));
  // Roles are changed and people removed from their own rows, which say
  // what went wrong; what went right is said once, under the list.
  const [notice, setNotice] = useState<string | null>(null);
  return (
    <>
      <RepoSettingsHeading base={base} />
      <div className="max-w-4xl space-y-8">
        <Section
          title="Base permission"
          about={`What every member of ${params.owner} gets on its repositories.`}
        >
          <div className="rounded-xl border border-line bg-surface p-4 text-sm">
            <p>
              Members have{" "}
              <span className="font-medium text-fg">
                {access.base_permission === "none" ? "no permission" : `the ${BASE_PERMISSION_LABELS[access.base_permission]} role`}
              </span>{" "}
              on {full}
              {access.base_permission === "none" ? " unless they are given a role here." : ", or the higher role they are given here."}{" "}
              Owners of the workspace are Admins on every repository.
            </p>
            <p className="mt-2 text-muted">
              {owner ? (
                <Link to={`/${params.owner}/-/people#base-permission`} className="text-accent hover:underline">
                  Change the base permission
                </Link>
              ) : (
                "Owners of the workspace choose it."
              )}
            </p>
          </div>
        </Section>

        {manage && (
          <Section
            title="Add people"
            about="A member of the workspace gets the role at once. Anyone else gets an invitation, by email, and has the role once they accept it."
          >
            {free && <StartPlanToInvite workspace={params.owner} owner={owner} outside />}
            <AddForm result={result} />
          </Section>
        )}

        <Section
          title="People with access"
          about={
            manage
              ? "Who can see the repository, and what each can do. Outside collaborators are not members of the workspace; they see only the repositories shared with them."
              : "Who can see the repository, and what each can do. Changing who has access needs the Admin role."
          }
        >
          <ul className="divide-y divide-line rounded-xl border border-line">
            {people.map((person) => (
              <PersonRow
                key={person.username}
                person={person}
                manage={manage}
                base={access.base_permission}
                full={full}
                workspace={params.owner}
                onDone={setNotice}
              />
            ))}
          </ul>
          {notice && (
            <p className="text-sm text-success" role="status">
              {notice}
            </p>
          )}
        </Section>

        <Section
          title="Teams with access"
          about={
            manage
              ? `Teams of ${params.owner} with a role here. Everyone on a team gets its role, and the team can be asked to review.`
              : `Teams of ${params.owner} with a role here. Everyone on a team gets its role. Changing them needs the Admin role.`
          }
        >
          {repoTeams.length === 0 ? (
            <p className="rounded-xl border border-dashed border-line px-4 py-6 text-center text-sm text-muted">
              No team has a role here.
            </p>
          ) : (
            <ul className="divide-y divide-line rounded-xl border border-line">
              {repoTeams.map((team) => (
                <TeamRow key={team.slug} team={team} workspace={params.owner} full={full} manage={manage} onDone={setNotice} />
              ))}
            </ul>
          )}
          {manage && <AddTeamForm teams={addable} result={teamResult} workspace={params.owner} />}
        </Section>

        {manage && (
          <Section title="Pending invitations" about="Invitations not yet accepted. Each expires after 7 days.">
            {pending.length === 0 ? (
              <p className="rounded-xl border border-dashed border-line px-4 py-6 text-center text-sm text-muted">
                No invitations are waiting.
              </p>
            ) : (
              <ul className="divide-y divide-line rounded-xl border border-line">
                {pending.map((invitation) => (
                  <InvitationRow key={invitation.id} invitation={invitation} />
                ))}
              </ul>
            )}
          </Section>
        )}

        <Section
          title="Roles"
          about="What each role can do. Each role can do everything the one before it can. Transferring and deleting also need an owner of the workspace."
        >
          <RolesTable />
        </Section>
      </div>
    </>
  );
}

/** A username or an address, and the role to give. */
function AddForm({ result }: { result: Outcome | undefined }) {
  const [role, setRole] = useState<RepoRole>("write");
  const [key, setKey] = useState(0);
  // Cleared once someone was added, ready for the next.
  useEffect(() => {
    if (result?.ok) setKey((k) => k + 1);
  }, [result]);
  return (
    <Form method="post" className="space-y-3 rounded-xl border border-line bg-surface p-4">
      <input type="hidden" name="intent" value="add" />
      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_11rem_auto] sm:items-end">
        <Field label="Username or email address">
          <Input key={key} name="invitee" required maxLength={254} placeholder="username or name@example.com" />
        </Field>
        <div>
          <span className="mb-1.5 block text-sm font-medium text-muted">Role</span>
          <RoleSelect name="role" label="Role" value={role} onValueChange={(value) => setRole(value as RepoRole)} />
        </div>
        <SubmitButton match={{ intent: "add" }} pending="Adding…">
          <UserPlus size={15} />
          Add
        </SubmitButton>
      </div>
      <p className="text-xs text-faint">{REPO_ROLE_LABELS[role]}: {roleLine(role)}</p>
      {result &&
        (result.ok ? (
          <p className="flex items-start gap-2 text-sm text-fg" role="status">
            <Mail size={14} className="mt-0.5 shrink-0 text-accent" />
            {result.message}
          </p>
        ) : (
          <ErrorText>{result.error}</ErrorText>
        ))}
    </Form>
  );
}

function roleLine(role: RepoRole): string {
  return {
    read: "they can see and clone it, open issues and pull requests, and comment.",
    triage: "they can also apply labels and milestones, and assign, close and reopen issues and pull requests.",
    write: "they can also push, merge, manage labels and milestones, see security alerts and put agents to work.",
    maintain: "they can also change its settings and topics.",
    admin: "they can do everything, including branch protection, webhooks, secrets, deployments and who has access.",
  }[role];
}

/** One person: who they are, how they have access, and their role. */
function PersonRow({
  person,
  manage,
  base,
  full,
  workspace,
  onDone,
}: {
  person: Collaborator;
  manage: boolean;
  base: Parameters<typeof baseRole>[0];
  full: string;
  workspace: string;
  onDone: (notice: string | null) => void;
}) {
  const fetcher = useFetcher<Outcome>();
  useEffect(() => {
    if (fetcher.data) onDone(fetcher.data.ok ? fetcher.data.message : null);
  }, [fetcher.data, onDone]);
  const outside = person.workspace_role == null;
  // A member keeps the base permission whatever role they are given here,
  // so only higher roles mean anything for them.
  const floor = outside ? null : baseRole(base);
  const roles = floor ? REPO_ROLES.filter((role) => REPO_ROLES.indexOf(role) >= REPO_ROLES.indexOf(floor)) : REPO_ROLES;
  const shown = fetcher.formData?.get("intent") === "role" ? String(fetcher.formData.get("role")) : person.role;
  const editable = manage && person.source !== "owner";
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3">
      <Avatar name={person.username} image={person.avatar} size={32} />
      <div className="min-w-0 grow basis-40">
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <Link to={`/u/${person.username}`} className="font-mono text-sm hover:text-accent">
            {person.username}
          </Link>
          {person.name && <span className="truncate text-sm text-muted">{person.name}</span>}
          {person.source === "owner" && <Badge tone="accent">Owner</Badge>}
          {outside && <Badge tone="info">Outside collaborator</Badge>}
        </p>
        <p className="mt-0.5 text-xs text-faint">
          {person.source === "team" && person.team ? (
            <>
              Through team{" "}
              <Link to={`/${workspace}/-/teams/${person.team}`} className="text-muted hover:text-accent hover:underline">
                {person.team}
              </Link>
            </>
          ) : (
            SOURCE[person.source]
          )}
          {!outside && person.direct != null && person.source !== "direct" ? ` · given ${REPO_ROLE_LABELS[person.direct]} here` : ""}
        </p>
        {fetcher.data && !fetcher.data.ok && <ErrorText>{fetcher.data.error}</ErrorText>}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {editable ? (
          <RoleSelect
            size="sm"
            label={`Role of ${person.username}`}
            roles={roles}
            value={shown}
            className="w-32"
            disabled={fetcher.state !== "idle"}
            onValueChange={(role) =>
              fetcher.submit({ intent: "role", username: person.username, role }, { method: "post" })
            }
          />
        ) : (
          <span className="inline-flex h-8 w-32 items-center rounded-md border border-line px-2.5 text-[0.8125rem] text-muted">
            {REPO_ROLE_LABELS[person.role]}
          </span>
        )}
        {/* The same room for Remove on every row, so the roles line up. */}
        {manage && (
          <span className="flex w-[5.5rem] justify-end">
            {editable && person.direct != null && (
              <RemoveButton person={person} full={full} outside={outside} onDone={onDone} />
            )}
          </span>
        )}
      </div>
    </li>
  );
}

/** Taking someone's role here away, after saying what that means. */
function RemoveButton({
  person,
  full,
  outside,
  onDone,
}: {
  person: Collaborator;
  full: string;
  outside: boolean;
  onDone: (notice: string | null) => void;
}) {
  const fetcher = useFetcher<Outcome>();
  const [open, setOpen] = useState(false);
  // Said as soon as the answer comes, before the row leaves the list.
  useEffect(() => {
    if (fetcher.data) onDone(fetcher.data.ok ? fetcher.data.message : null);
  }, [fetcher.data, onDone]);
  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data?.ok) setOpen(false);
  }, [fetcher.state, fetcher.data]);
  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <Button type="button" variant="quiet" onClick={() => setOpen(true)}>
        Remove
      </Button>
      <AlertDialogContent>
        <fetcher.Form method="post" className="grid gap-4">
          <input type="hidden" name="intent" value="remove" />
          <input type="hidden" name="username" value={person.username} />
          <AlertDialogHeader>
            <AlertDialogTitle>
              Remove {person.username} from {full}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {outside
                ? "They lose access to the repository at once, and stop seeing it in Shared with you. Their issues, pull requests and comments stay."
                : "They lose the role given to them here, and keep what the workspace's base permission gives every member."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {fetcher.data && !fetcher.data.ok && <ErrorText>{fetcher.data.error}</ErrorText>}
          <AlertDialogFooter>
            <AlertDialogCancel type="button">Cancel</AlertDialogCancel>
            <SubmitButton variant="danger" fetcher={fetcher} pending="Removing…">
              Remove
            </SubmitButton>
          </AlertDialogFooter>
        </fetcher.Form>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function day(at: string): string {
  return new Date(at).toISOString().slice(0, 10);
}

/** A pending invitation: to whom, with which role, until when. */
function InvitationRow({ invitation }: { invitation: RepoInvitation }) {
  const fetcher = useFetcher<Outcome>();
  const who = invitation.invitee ?? invitation.email ?? "Someone";
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3">
      {invitation.invitee ? (
        <Avatar name={invitation.invitee} size={32} />
      ) : (
        <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-raised text-muted ring-1 ring-line">
          <Mail size={14} />
        </span>
      )}
      <div className="min-w-0 grow basis-40">
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className={`min-w-0 truncate text-sm ${invitation.invitee ? "font-mono" : ""}`}>{who}</span>
          <Badge>{REPO_ROLE_LABELS[invitation.role]}</Badge>
        </p>
        <p className="mt-0.5 text-xs text-faint">
          Invited by {invitation.invited_by ?? "g1t"} on {day(invitation.created_at)} · expires {day(invitation.expires_at)}
        </p>
        {fetcher.data && !fetcher.data.ok && <ErrorText>{fetcher.data.error}</ErrorText>}
      </div>
      <fetcher.Form method="post" className="shrink-0">
        <input type="hidden" name="intent" value="revoke" />
        <input type="hidden" name="id" value={invitation.id} />
        <SubmitButton variant="quiet" fetcher={fetcher} pending="Revoking…">
          Revoke
        </SubmitButton>
      </fetcher.Form>
    </li>
  );
}

/** A team with a role here: its name, handle, size, and the role it gives. */
function TeamRow({
  team,
  workspace,
  full,
  manage,
  onDone,
}: {
  team: RepoTeam;
  workspace: string;
  full: string;
  manage: boolean;
  onDone: (notice: string | null) => void;
}) {
  const fetcher = useFetcher<Outcome>();
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (fetcher.data) onDone(fetcher.data.ok ? fetcher.data.message : null);
  }, [fetcher.data, onDone]);
  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data?.ok) setOpen(false);
  }, [fetcher.state, fetcher.data]);
  const shown = fetcher.formData?.get("intent") === "team-role" ? String(fetcher.formData.get("role")) : team.role;
  const href = `/${workspace}/-/teams/${team.slug}`;
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3">
      <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-raised text-muted ring-1 ring-line">
        <Users size={15} />
      </span>
      <div className="min-w-0 grow basis-40">
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <Link to={href} className="text-sm font-medium hover:text-accent">
            {team.name}
          </Link>
          <span className="truncate font-mono text-xs text-muted">
            @{workspace}/{team.slug}
          </span>
          {team.visibility === "secret" && <Badge tone="warn">Secret</Badge>}
        </p>
        <p className="mt-0.5 text-xs text-faint">
          {team.members_count === 1 ? "1 member" : `${team.members_count} members`}
        </p>
        {fetcher.data && !fetcher.data.ok && !open && <ErrorText>{fetcher.data.error}</ErrorText>}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {manage ? (
          <RoleSelect
            size="sm"
            label={`Role of team ${team.name}`}
            value={shown}
            className="w-32"
            disabled={fetcher.state !== "idle"}
            onValueChange={(role) => fetcher.submit({ intent: "team-role", team: team.slug, role }, { method: "post" })}
          />
        ) : (
          <span className="inline-flex h-8 w-32 items-center rounded-md border border-line px-2.5 text-[0.8125rem] text-muted">
            {REPO_ROLE_LABELS[team.role]}
          </span>
        )}
        {manage && (
          <span className="flex w-[5.5rem] justify-end">
            <AlertDialog open={open} onOpenChange={setOpen}>
              <Button type="button" variant="quiet" onClick={() => setOpen(true)}>
                Remove
              </Button>
              <AlertDialogContent>
                <fetcher.Form method="post" className="grid gap-4">
                  <input type="hidden" name="intent" value="team-remove" />
                  <input type="hidden" name="team" value={team.slug} />
                  <AlertDialogHeader>
                    <AlertDialogTitle>
                      Remove {team.name} from {full}?
                    </AlertDialogTitle>
                    <AlertDialogDescription>
                      Its people lose the role it gave them here, and keep any role they have otherwise. The team itself stays.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  {fetcher.data && !fetcher.data.ok && <ErrorText>{fetcher.data.error}</ErrorText>}
                  <AlertDialogFooter>
                    <AlertDialogCancel type="button">Cancel</AlertDialogCancel>
                    <SubmitButton variant="danger" fetcher={fetcher} pending="Removing…">
                      Remove
                    </SubmitButton>
                  </AlertDialogFooter>
                </fetcher.Form>
              </AlertDialogContent>
            </AlertDialog>
          </span>
        )}
      </div>
    </li>
  );
}

/** One of the workspace's teams without a role here yet, and the role to give it. */
function AddTeamForm({ teams, result, workspace }: { teams: Team[]; result: Outcome | undefined; workspace: string }) {
  const [team, setTeam] = useState("");
  const [role, setRole] = useState<RepoRole>("write");
  // Cleared once the team was added, ready for the next.
  useEffect(() => {
    if (result?.ok) setTeam("");
  }, [result]);
  if (teams.length === 0) {
    return (
      <p className="text-sm text-muted">
        No other team of {workspace} to add.{" "}
        <Link to={`/${workspace}/-/teams`} className="text-accent hover:underline">
          See its teams
        </Link>
      </p>
    );
  }
  return (
    <Form method="post" className="space-y-3 rounded-xl border border-line bg-surface p-4">
      <input type="hidden" name="intent" value="team-add" />
      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_11rem_auto] sm:items-end">
        <div>
          <span className="mb-1.5 block text-sm font-medium text-muted">Team</span>
          <Select name="team" value={team} onValueChange={setTeam} required>
            <SelectTrigger aria-label="Team">
              <SelectValue placeholder="Choose a team" />
            </SelectTrigger>
            <SelectContent align="start">
              {teams.map((option) => (
                <SelectItem
                  key={option.slug}
                  value={option.slug}
                  description={`@${option.workspace}/${option.slug} · ${option.members_count === 1 ? "1 member" : `${option.members_count} members`}`}
                >
                  {option.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div>
          <span className="mb-1.5 block text-sm font-medium text-muted">Role</span>
          <RoleSelect name="role" label="Role" value={role} onValueChange={(value) => setRole(value as RepoRole)} />
        </div>
        <SubmitButton match={{ intent: "team-add" }} pending="Adding…" disabled={!team}>
          <Users size={15} />
          Add team
        </SubmitButton>
      </div>
      <p className="text-xs text-faint">{REPO_ROLE_LABELS[role]}: everyone on the team {roleLine(role).replace(/^they /, "")}</p>
      {result &&
        (result.ok ? (
          <p className="text-sm text-success" role="status">
            {result.message}
          </p>
        ) : (
          <ErrorText>{result.error}</ErrorText>
        ))}
    </Form>
  );
}
