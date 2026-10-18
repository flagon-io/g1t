import { Code2, MessagesSquare, UsersRound } from "lucide-react";
import { type ReactNode, useState } from "react";
import { Form, Link, data, useNavigation } from "react-router";

import {
  BASE_PERMISSIONS,
  BASE_PERMISSION_LABELS,
  type BasePermission,
  type ChatAllowed,
  DEFAULT_BASE_PERMISSION,
  DEFAULT_MEMBER_PRIVILEGES,
  type MemberPrivileges,
  type TeamCreation,
  type Workspace,
} from "@g1t/contracts";

import type { Route } from "./+types/permissions";
import { page } from "../../lib/meta";
import { ErrorText, SubmitButton } from "../../components/ui";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../components/ui/card";
import { RadioGroup, RadioOption } from "../../components/ui/radio-group";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../components/ui/select";
import { SwitchCard } from "../../components/ui/switch";
import { chat, identity } from "../../lib/services.server";
import { assertSameOrigin, getViewer, requireUser, roleIn } from "../../lib/session.server";

export function meta({ params, ...args }: Route.MetaArgs) {
  return page(args, { title: `Permissions · ${params.owner} · g1t` });
}

/**
 * Permissions: who may do what in the workspace, in one place, a section
 * for each part of g1t. What exists today saves through the service that
 * owns it (identity for repositories and teams, chat for channels).
 * Owners only.
 */
export async function loader({ params, context }: Route.LoaderArgs) {
  const viewer = getViewer(context);
  if (roleIn(viewer, params.owner) !== "owner" || !viewer) throw data(null, { status: 404 });
  const slug = params.owner.toLowerCase();
  const [workspace, chatSettings] = await Promise.all([identity.getWorkspace(params.owner), chat.chatSettings(slug, viewer).catch(() => null)]);
  if (!workspace) throw data(null, { status: 404 });
  return {
    slug,
    base: workspace.basePermission ?? DEFAULT_BASE_PERMISSION,
    privileges: { ...DEFAULT_MEMBER_PRIVILEGES, ...pickPrivileges(workspace) },
    teamCreation: workspace.teamCreation ?? "members",
    // Null when chat did not answer: the section says so and takes no change.
    channels: chatSettings?.ok ? { public: chatSettings.value.settings.public_channels, private: chatSettings.value.settings.private_channels } : null,
  };
}

export async function action({ request, params, context }: Route.ActionArgs) {
  assertSameOrigin(request);
  const user = requireUser(context, request);
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const slug = params.owner.toLowerCase();
  // Each section saves on its own; identity and chat check the owner again.
  if (intent === "base-permission") {
    const base = String(form.get("base") ?? "");
    if (!(BASE_PERMISSIONS as readonly string[]).includes(base)) return { intent, error: "Choose a base permission." };
    const result = await identity.setBasePermission(user, params.owner, base as BasePermission);
    return result.ok ? { intent, saved: true } : { intent, error: result.error.message };
  }
  if (intent === "member-privileges") {
    // A switch posts only when on.
    const change = Object.fromEntries(PRIVILEGES.map(([key]) => [key, form.get(key) === "on"])) as MemberPrivileges;
    const result = await identity.setMemberPrivileges(user, params.owner, change);
    return result.ok ? { intent, saved: true } : { intent, error: result.error.message };
  }
  if (intent === "team-creation") {
    const wanted: TeamCreation = form.get("team_creation") === "owners" ? "owners" : "members";
    const result = await identity.setTeamCreation(user, params.owner, wanted);
    return result.ok ? { intent, saved: true } : { intent, error: result.error.message };
  }
  if (intent === "chat-channels") {
    const who = (key: string): ChatAllowed => (form.get(key) === "owners" ? "owners" : "members");
    try {
      const result = await chat.setChatSettings(slug, user, { public_channels: who("public_channels"), private_channels: who("private_channels") });
      return result.ok ? { intent, saved: true } : { intent, error: result.error.message };
    } catch {
      return { intent, error: "Chat didn't answer. Try again in a moment." };
    }
  }
  return { intent, error: "Unknown request." };
}

/** What the base permission means for members, in a sentence. */
const BASE_MEANS: Record<BasePermission, string> = {
  none: "Members see only public repositories and the ones they are given a role on.",
  read: "Members can see and clone every repository, open work items and pull requests, and comment.",
  write: "Members can see every repository, manage its work items and pull requests, push and merge.",
  admin: "Members can do everything on every repository, including its settings, webhooks, secrets and who has access. Only owners transfer or delete one.",
};

/** The member privileges, in the order the Code section shows them, with what each lets members do. */
const PRIVILEGES: [keyof MemberPrivileges, string, string][] = [
  ["members_can_create_public_repositories", "Members can create public repositories", "Owners always can. Off: members ask an owner."],
  ["members_can_create_private_repositories", "Members can create private repositories", "Owners always can. Whoever creates a repository is its Admin."],
  [
    "members_can_change_repo_visibility",
    "Repository admins can change visibility",
    "Members with the Admin role on a repository can make it public or private. Off: owners only.",
  ],
  [
    "members_can_delete_repositories",
    "Repository admins can delete and transfer repositories",
    "Members with the Admin role on a repository can delete it, or transfer it to a workspace where they can create one. Off: owners only.",
  ],
  [
    "members_can_invite_outside_collaborators",
    "Repository admins can add outside collaborators",
    "Members with the Admin role on a repository can give a role on it to someone outside the workspace. Off: owners only.",
  ],
];

/** The member privileges a workspace carries, by name. */
function pickPrivileges(workspace: Workspace): Partial<MemberPrivileges> {
  const picked: Partial<MemberPrivileges> = {};
  for (const [key] of PRIVILEGES) {
    const value = workspace[key];
    if (typeof value === "boolean") picked[key] = value;
  }
  return picked;
}

type Answer = Route.ComponentProps["actionData"];

/** What the last save of `intent` came to: saved, or why not. */
function outcome(answer: Answer, intent: string): { saved: boolean; error: string | null } {
  if (!answer || answer.intent !== intent) return { saved: false, error: null };
  return { saved: "saved" in answer && answer.saved === true, error: "error" in answer ? (answer.error ?? null) : null };
}

/** Whether a save of `intent` is on its way. */
function useSaving(intent: string): boolean {
  const navigation = useNavigation();
  return navigation.state !== "idle" && navigation.formData?.get("intent") === intent;
}

/** One part of g1t: its sections, under its name and what the part covers. */
function Part({ icon, title, about, children }: { icon: ReactNode; title: string; about: string; children: ReactNode }) {
  return (
    <Card asChild>
      <section aria-labelledby={`part-${title.toLowerCase().replace(/\W+/g, "-")}`}>
        <CardHeader className="border-b border-line">
          <CardTitle id={`part-${title.toLowerCase().replace(/\W+/g, "-")}`} className="flex items-center gap-2 text-base">
            <span className="text-faint [&>svg]:size-4">{icon}</span>
            {title}
          </CardTitle>
          <CardDescription>{about}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-8 p-5">{children}</CardContent>
      </section>
    </Card>
  );
}

/** A setting's heading inside a part, and a line on what it decides. */
function Setting({ title, about, children }: { title: string; about: ReactNode; children: ReactNode }) {
  return (
    <div>
      <h3 className="text-sm font-medium">{title}</h3>
      <p className="mt-1 text-xs leading-relaxed text-faint">{about}</p>
      <div className="mt-3">{children}</div>
    </div>
  );
}

/** Saved, or why not, beside a Save button. */
function SaveRow({ intent, changed, answer }: { intent: string; changed: boolean; answer: Answer }) {
  const saving = useSaving(intent);
  const { saved, error } = outcome(answer, intent);
  return (
    <div className="flex flex-wrap items-center gap-3">
      <SubmitButton variant="outline" size="sm" match={{ intent }} pending="Saving…" disabled={saving || !changed}>
        Save
      </SubmitButton>
      {saved && !changed && !error && (
        <p role="status" className="text-xs text-muted">
          Saved.
        </p>
      )}
      <ErrorText>{error}</ErrorText>
    </div>
  );
}

export default function WorkspacePermissions({ loaderData, actionData, params }: Route.ComponentProps) {
  const { slug, base, privileges, teamCreation, channels } = loaderData;
  return (
    <div className="max-w-3xl space-y-6">
      <Part
        icon={<Code2 />}
        title="Code"
        about="What members may do with the workspace's repositories, beyond the role each repository gives them. Owners always can do all of it."
      >
        <BasePermissionSetting key={base} base={base} slug={params.owner} answer={actionData} />
        <PrivilegesSetting key={JSON.stringify(privileges)} privileges={privileges} answer={actionData} />
      </Part>

      <Part icon={<UsersRound />} title="People and teams" about="Who may shape the workspace's teams.">
        <TeamCreationSetting key={teamCreation} setting={teamCreation} answer={actionData} />
      </Part>

      <Part
        icon={<MessagesSquare />}
        title="Chat"
        about="Who may open channels. What a channel's own members may do, its default channels and emoji are on Chat settings."
      >
        {channels ? (
          <ChannelsSetting key={`${channels.public}:${channels.private}`} channels={channels} slug={slug} answer={actionData} />
        ) : (
          <Setting title="Creating channels" about="Who can create public and private channels.">
            <p className="text-sm text-muted">Chat didn't answer. Reload to try again.</p>
          </Setting>
        )}
      </Part>

      <p className="text-xs text-faint">
        Each change is recorded in the{" "}
        <Link to={`/${slug}/-/audit`} className="underline underline-offset-4 hover:text-fg">
          audit log
        </Link>
        . Every other setting of the workspace is in this sidebar.
      </p>
    </div>
  );
}

/** What members get on every repository, which owners choose. */
function BasePermissionSetting({ base, slug, answer }: { base: BasePermission; slug: string; answer: Answer }) {
  const [chosen, setChosen] = useState<BasePermission>(base);
  return (
    <Setting
      title="Base permission"
      about={`The role every member has on each of ${slug}'s repositories. Owners are Admins on all of them, and a role given to someone on one repository adds to this; it never takes away.`}
    >
      <Form method="post" className="space-y-3">
        <input type="hidden" name="intent" value="base-permission" />
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <Select name="base" value={chosen} onValueChange={(value) => setChosen(value as BasePermission)}>
            <SelectTrigger aria-label="Base permission" className="sm:max-w-56">
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
          <p className="text-sm text-muted">{BASE_MEANS[chosen]}</p>
        </div>
        <SaveRow intent="base-permission" changed={chosen !== base} answer={answer} />
      </Form>
    </Setting>
  );
}

/** What members may do: create repositories, and what repository admins may do. */
function PrivilegesSetting({ privileges, answer }: { privileges: MemberPrivileges; answer: Answer }) {
  const [chosen, setChosen] = useState<MemberPrivileges>(privileges);
  const changed = PRIVILEGES.some(([key]) => chosen[key] !== privileges[key]);
  return (
    <Setting title="Repositories" about="Creating repositories, and what a member with Admin on one may do with it.">
      <Form method="post" className="space-y-3">
        <input type="hidden" name="intent" value="member-privileges" />
        {PRIVILEGES.map(([key, title, about]) => (
          <SwitchCard key={key} name={key} title={title} checked={chosen[key]} onCheckedChange={(on) => setChosen((current) => ({ ...current, [key]: on }))}>
            {about}
          </SwitchCard>
        ))}
        <SaveRow intent="member-privileges" changed={changed} answer={answer} />
      </Form>
    </Setting>
  );
}

/** Who may create the workspace's teams. Teams already made stay as they are, whoever made them. */
function TeamCreationSetting({ setting, answer }: { setting: TeamCreation; answer: Answer }) {
  const [choice, setChoice] = useState<TeamCreation>(setting);
  return (
    <Setting title="Who can create teams" about="Whoever creates a team becomes its first maintainer. Teams that already exist stay as they are.">
      <Form method="post" className="space-y-3">
        <input type="hidden" name="intent" value="team-creation" />
        <RadioGroup
          name="team_creation"
          value={choice}
          onValueChange={(value) => setChoice(value as TeamCreation)}
          aria-label="Who can create teams"
          className="grid gap-2 sm:grid-cols-2"
        >
          <RadioOption value="members" label="Any member" description="Every member with a confirmed email address. The default." />
          <RadioOption value="owners" label="Owners only" description="Members ask an owner to create a team; maintainers still manage their own." />
        </RadioGroup>
        <SaveRow intent="team-creation" changed={choice !== setting} answer={answer} />
      </Form>
    </Setting>
  );
}

/** Who may create public and private channels, saved by the chat service. */
function ChannelsSetting({ channels, slug, answer }: { channels: { public: ChatAllowed; private: ChatAllowed }; slug: string; answer: Answer }) {
  const [chosen, setChosen] = useState(channels);
  const changed = chosen.public !== channels.public || chosen.private !== channels.private;
  return (
    <Setting
      title="Creating channels"
      about={
        <>
          Whoever creates a channel becomes its first owner. Renaming, archiving, emoji and default channels are on{" "}
          <Link to={`/${slug}/-/settings/chat`} className="underline underline-offset-4 hover:text-fg">
            Chat settings
          </Link>
          .
        </>
      }
    >
      <Form method="post" className="space-y-3">
        <input type="hidden" name="intent" value="chat-channels" />
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <h4 className="mb-2 text-xs font-medium text-fg-soft">Workspace channels</h4>
            <RadioGroup
              name="public_channels"
              value={chosen.public}
              onValueChange={(value) => setChosen((now) => ({ ...now, public: value as ChatAllowed }))}
              aria-label="Who can create workspace channels"
            >
              <RadioOption value="members" label="Any member" description="The default." />
              <RadioOption
                value="owners"
                label="Owners only"
                description="Members join and read workspace channels, but ask an owner for a new one. Public channels, open to anyone on g1t, are always for owners to make."
              />
            </RadioGroup>
          </div>
          <div>
            <h4 className="mb-2 text-xs font-medium text-fg-soft">Private channels</h4>
            <RadioGroup
              name="private_channels"
              value={chosen.private}
              onValueChange={(value) => setChosen((now) => ({ ...now, private: value as ChatAllowed }))}
              aria-label="Who can create private channels"
            >
              <RadioOption value="members" label="Any member" description="The default." />
              <RadioOption value="owners" label="Owners only" description="Only owners can make a channel that is kept to the people invited." />
            </RadioGroup>
          </div>
        </div>
        <SaveRow intent="chat-channels" changed={changed} answer={answer} />
      </Form>
    </Setting>
  );
}
