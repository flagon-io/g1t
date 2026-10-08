import { ArrowUpRight, Users } from "lucide-react";
import { useState } from "react";
import { Form, Link, data, useSearchParams } from "react-router";

import {
  BASE_PERMISSIONS,
  BASE_PERMISSION_LABELS,
  type BasePermission,
  DEFAULT_BASE_PERMISSION,
  REPO_ROLE_LABELS,
} from "@g1t/contracts";

import type { Route } from "./+types/people";
import { page } from "../../lib/meta";
import { Avatar, CopyLine, ErrorText, Field, Input, Pill, SubmitButton, TimeAgo } from "../../components/ui";
import { Badge } from "../../components/ui/badge";
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
  if (form.get("action") === "base-permission") {
    const base = String(form.get("base") ?? "");
    if (!(BASE_PERMISSIONS as readonly string[]).includes(base)) return { error: "Choose a base permission." };
    const result = await identity.setBasePermission(user, params.owner, base as BasePermission);
    return result.ok ? { based: result.value } : { error: result.error.message, base: true };
  }
  const member = String(form.get("member") ?? "").trim();
  // An address is invited by email; a username is added at once.
  if (form.get("action") !== "remove" && member.includes("@")) {
    const result = await identity.inviteMember(user, params.owner, member);
    return result.ok ? { invited: result.value.email, outOfInvites: false } : { error: result.error.message, outOfInvites: result.error.code === "limit" };
  }
  const result =
    form.get("action") === "remove"
      ? await identity.removeMember(user, params.owner, member)
      : await identity.addMember(user, params.owner, member);
  if (!result.ok) return { error: result.error.message, converting: form.get("action") === "convert" };
  return form.get("action") === "convert" ? { converted: member } : null;
}

/** What the base permission means for members, in a sentence. */
const BASE_MEANS: Record<BasePermission, string> = {
  none: "Members see only public repositories and the ones they are given a role on.",
  read: "Members can see and clone every repository, open issues and pull requests, and comment.",
  write: "Members can see every repository, manage its issues and pull requests, push, merge, and put agents to work.",
  admin: "Members can do everything on every repository, including its settings, webhooks, secrets and who has access. Only owners transfer or delete one.",
};

export default function WorkspacePeople({ loaderData, actionData, params }: Route.ComponentProps) {
  const { role, members, invites, origin, base, outside, teams, free } = loaderData;
  const owner = role === "owner";
  const pending = invites.filter((invite) => invite.status === "pending");
  const [search, setSearch] = useSearchParams();
  const tab = search.get("tab") === "outside" && owner ? "outside" : "members";
  const membersTab = (
    <>
      <ul className="divide-y divide-line rounded-xl border border-line">
        {members.map((member) => (
          <li key={member.username} className="flex items-center gap-3 px-4 py-3">
            <Avatar name={member.username} image={member.avatar} size={28} />
            <div className="min-w-0 grow truncate">
              <Link to={`/u/${member.username}`} className="font-mono text-sm hover:text-accent">
                {member.username}
              </Link>
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
            {member.role === "owner" ? <Badge tone="accent">Owner</Badge> : <Badge>Member</Badge>}
            {owner && (
              // The same room on every row, so the badges line up.
              <span className="flex w-[5.5rem] justify-end">
                {member.role !== "owner" && (
                  <Form method="post">
                    <input type="hidden" name="action" value="remove" />
                    <input type="hidden" name="member" value={member.username} />
                    <SubmitButton variant="quiet" match={{ action: "remove", member: member.username }} pending="Removing…">
                      Remove
                    </SubmitButton>
                  </Form>
                )}
              </span>
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
              label="Add a member"
              hint="A g1t username joins at once, as a member. An email address gets an invite: without a g1t account, it makes one and joins in one step, using one of your invites."
            >
              <Input name="member" required maxLength={254} placeholder="username or name@example.com" />
            </Field>
          </div>
          <div className="sm:pt-[1.625rem]">
            <SubmitButton match={{ action: "add" }} pending="Adding…">
              Add
            </SubmitButton>
          </div>
        </Form>
      )}
      {actionData && "invited" in actionData && actionData.invited && (
        <p className="text-sm text-muted" role="status">
          Invite sent to <span className="text-fg">{actionData.invited}</span>.
        </p>
      )}
      {actionData && "converted" in actionData && (
        <p className="text-sm text-muted" role="status">
          <span className="font-mono text-fg">{actionData.converted}</span> is now a member of {params.owner}.
        </p>
      )}
      {actionData && !("base" in actionData) && !("converting" in actionData && actionData.converting) && (
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
          <h2 className="text-sm font-medium">Pending invites</h2>
          <ul className="mt-3 divide-y divide-line rounded-xl border border-line">
            {pending.map((invite) => (
              <li key={invite.id} className="space-y-2 px-4 py-3">
                <div className="flex flex-wrap items-center gap-3">
                  <span className="min-w-0 grow truncate text-sm">{invite.email}</span>
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
                  By {invite.invitedBy ?? "g1t"} · <TimeAgo at={invite.createdAt} />
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
                  <Link to={`/u/${person.username}`} className="font-mono text-sm hover:text-accent">
                    {person.username}
                  </Link>
                  {person.name && <span className="ml-2 text-sm text-muted">{person.name}</span>}
                </div>
                {!free && (
                  <Form method="post">
                    <input type="hidden" name="action" value="convert" />
                    <input type="hidden" name="member" value={person.username} />
                    <SubmitButton variant="quiet" match={{ action: "convert", member: person.username }} pending="Converting…">
                      Convert to member
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
