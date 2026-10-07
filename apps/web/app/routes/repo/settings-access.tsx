import { Mail, UserPlus } from "lucide-react";
import { useEffect, useState } from "react";
import { Form, Link, useFetcher } from "react-router";

import {
  BASE_PERMISSION_LABELS,
  REPO_ROLES,
  REPO_ROLE_LABELS,
  type Collaborator,
  type RepoInvitation,
  type RepoRole,
  baseRole,
} from "@g1t/contracts";

import type { Route } from "./+types/settings-access";
import { RoleSelect, RolesTable } from "../../components/access";
import { RepoSettingsHeading } from "../../components/repo-settings-heading";
import { SettingsSection as Section } from "../../components/settings-section";
import { Avatar, Button, ErrorText, Field, Input, SubmitButton } from "../../components/ui";
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
import { page } from "../../lib/meta";
import { refusal, requireInsider } from "../../lib/access.server";
import { identity } from "../../lib/services.server";
import { assertSameOrigin, requireUser, roleIn, unwrap } from "../../lib/session.server";

export function meta({ params, ...args }: Route.MetaArgs) {
  return page(args, { title: `Access · ${params.owner}/${params.repo} · g1t` });
}

export async function loader({ params, context }: Route.LoaderArgs) {
  // Write and up see who has access; Admins change it. To anyone without a
  // role here the page does not exist.
  const { viewer, access } = await requireInsider(context, params, "push");
  const found = unwrap(await identity.repoAccess(params.owner, params.repo, viewer));
  return {
    access: found,
    manage: access.can.manage_access,
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
      return removed.ok ? { intent, ok: true, error: null, message: null } : failed(removed.error.message);
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
};

export default function RepoAccessSettings({ loaderData, actionData, params }: Route.ComponentProps) {
  const { access, manage, owner } = loaderData;
  const base = `/${params.owner}/${params.repo}`;
  const full = `${params.owner}/${params.repo}`;
  const pending = access.invitations.filter((invitation) => invitation.status === "pending");
  const people = [...access.people].sort(
    (a, b) => REPO_ROLES.indexOf(b.role) - REPO_ROLES.indexOf(a.role) || a.username.localeCompare(b.username),
  );
  const result = actionData?.intent === "add" ? actionData : undefined;
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
              <PersonRow key={person.username} person={person} manage={manage} base={access.base_permission} full={full} />
            ))}
          </ul>
          {actionData && ["role", "remove"].includes(actionData.intent) && (
            actionData.ok ? (
              actionData.message && <p className="text-sm text-muted" role="status">{actionData.message}</p>
            ) : (
              <ErrorText>{actionData.error}</ErrorText>
            )
          )}
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
            {actionData?.intent === "revoke" && !actionData.ok && <ErrorText>{actionData.error}</ErrorText>}
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
    triage: "they can also label, assign, close and reopen issues and pull requests.",
    write: "they can also push, merge and put agents to work.",
    maintain: "they can also change its settings, branch protection and guardrails.",
    admin: "they can do everything, including webhooks, secrets, deployments and who has access.",
  }[role];
}

/** One person: who they are, how they have access, and their role. */
function PersonRow({
  person,
  manage,
  base,
  full,
}: {
  person: Collaborator;
  manage: boolean;
  base: Parameters<typeof baseRole>[0];
  full: string;
}) {
  const fetcher = useFetcher<Outcome>();
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
          {SOURCE[person.source]}
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
            {editable && person.direct != null && <RemoveButton person={person} full={full} outside={outside} />}
          </span>
        )}
      </div>
    </li>
  );
}

/** Taking someone's role here away, after saying what that means. */
function RemoveButton({ person, full, outside }: { person: Collaborator; full: string; outside: boolean }) {
  const fetcher = useFetcher<Outcome>();
  const [open, setOpen] = useState(false);
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
