import { Bot, ChevronRight, KeyRound, MapPin, MessageSquare, Network, Pencil, UsersRound, Wallet } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { Form, Link, data, redirect, useNavigation } from "react-router";

import type { DirectoryPerson } from "@g1t/contracts";

import type { Route } from "./+types/person";
import { AgentLink, AgentPersonFace, Coming, LocalTime, PersonFace, PersonLink, TeamKindMark } from "../../../components/people";
import { PresenceSummary } from "../../../components/presence";
import { ErrorText, Field, Input, SubmitButton, Textarea } from "../../../components/ui";
import { Badge } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../../../components/ui/dialog";
import { SelectField } from "../../../components/ui/select";
import { channelPath } from "../../../lib/chat";
import { page } from "../../../lib/meta";
import {
  agentsOn,
  codeAccessWords,
  leads,
  managerChoices,
  ownsFromText,
  peopleAgent,
  personName,
  reportsOf,
  teamsOfPerson,
} from "../../../lib/people";
import { teamPath } from "../../../lib/teams";
import { money } from "../../../lib/usage";
import { chat, identity, workspaceAgents } from "../../../lib/services.server";
import { assertSameOrigin, getViewer, requireUser, roleIn, unwrap } from "../../../lib/session.server";

export function meta({ loaderData, params, ...args }: Route.MetaArgs) {
  const name = loaderData ? personName(loaderData.person) : params.username;
  return page(args, { title: `${name} · People · ${params.owner} · g1t` });
}

/** The few fields of everyone else a profile shows. */
function slim(person: DirectoryPerson) {
  const { user_id, username, display_username, name, avatar, title, manager } = person;
  return { user_id, username, display_username, name, avatar, title, manager };
}

export async function loader({ params, context }: Route.LoaderArgs) {
  const viewer = getViewer(context);
  if (!roleIn(viewer, params.owner)) throw data(null, { status: 404 });
  const [directory, agents, budgets] = await Promise.all([
    identity.peopleDirectory(viewer, params.owner).then(unwrap),
    workspaceAgents.list(params.owner, viewer!).catch(() => null),
    // Owners see everyone's; anyone else only their own.
    workspaceAgents.personBudgets(params.owner, viewer!).catch(() => null),
  ]);
  const username = params.username.toLowerCase();
  const person = directory.people.find((p) => p.username === username);
  if (!person) throw data(null, { status: 404 });
  const all = agents?.ok ? agents.value.map(peopleAgent) : [];
  const teams = teamsOfPerson(directory.teams, username);
  const self = viewer?.username.toLowerCase() === username;
  const budget = budgets?.ok ? (budgets.value.people.find((p) => p.username === username) ?? null) : null;
  return {
    slug: params.owner.toLowerCase(),
    person,
    people: directory.people.map(slim),
    teams,
    agents: all,
    base: directory.base_permission,
    canManage: directory.can_manage,
    self,
    spend: budget && (self || directory.can_manage) ? { spent: budget.spent_micros, budget: budget.monthly_micros } : null,
  };
}

export async function action({ request, params, context }: Route.ActionArgs) {
  assertSameOrigin(request);
  const user = requireUser(context, request);
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  if (intent === "message") {
    const directory = unwrap(await identity.peopleDirectory(user, params.owner));
    const person = directory.people.find((p) => p.username === params.username.toLowerCase());
    if (!person) return { intent, error: "They are no longer a member here." };
    const opened = await chat.openDm(params.owner, user, [{ kind: "user", id: person.user_id }]);
    if (!opened.ok) return { intent, error: opened.error.message };
    throw redirect(channelPath(params.owner.toLowerCase(), opened.value));
  }
  if (intent === "profile") {
    const changes: { title?: string; owns?: string[]; manager?: string } = {
      title: String(form.get("title") ?? ""),
      owns: ownsFromText(String(form.get("owns") ?? "")),
    };
    if (form.has("manager")) {
      const manager = String(form.get("manager") ?? "");
      changes.manager = manager === "none" ? "" : manager;
    }
    const saved = await identity.setMemberProfile(user, params.owner, params.username, changes);
    return saved.ok ? { intent, saved: true as const, error: null } : { intent, error: saved.error.message };
  }
  return { intent, error: "Unknown request." };
}

export default function PersonProfile({ loaderData, actionData }: Route.ComponentProps) {
  const { slug, person, people, teams, agents, base, canManage, self, spend } = loaderData;
  const manager = person.manager ? people.find((p) => p.username === person.manager) : null;
  const reports = reportsOf(people as DirectoryPerson[], person.username);
  const teamAgents = teams.flatMap((team) => agentsOn(team, agents).map((agent) => ({ agent, team })));
  const seen = new Set<string>();
  const uniqueAgents = teamAgents.filter(({ agent }) => (seen.has(agent.id) ? false : (seen.add(agent.id), true)));
  const access = codeAccessWords(person, base, teams);
  const mayEdit = self || canManage;
  const navigation = useNavigation();
  const messaging = navigation.formData?.get("intent") === "message";

  return (
    <div className="space-y-8">
      <nav aria-label="Breadcrumb" className="flex items-center gap-1 text-sm text-muted">
        <Link to={`/${slug}/-/people`} className="hover:text-fg">
          People
        </Link>
        <ChevronRight size={13} className="text-faint" />
        <span className="truncate text-fg">{personName(person)}</span>
      </nav>

      <header className="flex flex-col gap-5 border-b border-line pb-6 sm:flex-row sm:items-start">
        <div className="self-start">
          <PersonFace person={person} size={72} />
        </div>
        <div className="min-w-0 grow space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight">{personName(person)}</h1>
            {person.role === "owner" && <Badge tone="accent">Owner</Badge>}
            {self && <Badge>You</Badge>}
          </div>
          <p className="text-sm text-muted">
            {[person.title, `@${person.display_username ?? person.username}`, person.pronouns].filter(Boolean).join(" · ")}
          </p>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted">
            <PresenceSummary person={{ id: person.user_id, username: person.username }} className="flex flex-wrap items-center gap-x-4 gap-y-1 space-y-0" />
            {person.location && (
              <span className="inline-flex items-center gap-1.5">
                <MapPin size={13} className="text-faint" />
                {person.location}
              </span>
            )}
            <LocalTime zone={person.timezone} />
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          {!self && (
            <Form method="post">
              <input type="hidden" name="intent" value="message" />
              <SubmitButton pending="Opening…" match={{ intent: "message" }} disabled={messaging}>
                <MessageSquare size={15} />
                Message
              </SubmitButton>
            </Form>
          )}
          {mayEdit && <EditProfile person={person} people={people as DirectoryPerson[]} canManage={canManage} actionData={actionData} />}
        </div>
      </header>
      {actionData?.intent === "message" && <ErrorText>{actionData.error}</ErrorText>}

      {(person.bio || person.owns.length > 0) && (
        <section className="space-y-3">
          {person.bio && <p className="max-w-2xl text-[0.9375rem] text-fg-soft">{person.bio}</p>}
          {person.owns.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="mr-1 text-sm text-muted">Owns</span>
              {person.owns.map((thing) => (
                <Badge key={thing} tone="info">
                  {thing}
                </Badge>
              ))}
            </div>
          )}
        </section>
      )}

      <div className="grid gap-4 md:grid-cols-2">
        <Card icon={<UsersRound size={14} />} title="Teams">
          {teams.length ? (
            <ul className="space-y-2">
              {teams.map((team) => {
                const role = team.people.find((p) => p.username === person.username)?.role;
                return (
                  <li key={team.slug} className="flex flex-wrap items-center gap-2">
                    <TeamKindMark people={team.people.length} agents={agentsOn(team, agents).length} />
                    <Link to={teamPath(slug, team.slug)} className="font-medium hover:text-accent">
                      {team.name}
                    </Link>
                    {leads(team.lead, { username: person.username }) && <Badge tone="accent">Lead</Badge>}
                    {role === "maintainer" && <Badge>Maintainer</Badge>}
                  </li>
                );
              })}
            </ul>
          ) : (
            <Quiet>Not on a team yet.</Quiet>
          )}
        </Card>

        <Card icon={<Network size={14} />} title="Reporting line">
          <dl className="space-y-3 text-sm">
            <div>
              <dt className="text-xs text-faint">Reports to</dt>
              <dd className="mt-1">{manager ? <PersonRow slug={slug} person={manager} /> : <Quiet>No one{canManage ? ". Set it under Edit profile." : "."}</Quiet>}</dd>
            </div>
            <div>
              <dt className="text-xs text-faint">
                Reports <span className="tabular-nums">{reports.length}</span>
              </dt>
              <dd className="mt-1 space-y-1.5">
                {reports.length ? reports.map((report) => <PersonRow key={report.username} slug={slug} person={report} />) : <Quiet>No one reports to them.</Quiet>}
              </dd>
            </div>
          </dl>
        </Card>

        <Card icon={<Bot size={14} />} title="Agents on their teams">
          {uniqueAgents.length ? (
            <ul className="space-y-2">
              {uniqueAgents.map(({ agent, team }) => (
                <li key={agent.id} className="flex items-center gap-2.5 text-sm">
                  <AgentPersonFace agent={agent} size={24} ring="var(--color-surface)" />
                  <span className="min-w-0 grow truncate">
                    <AgentLink workspace={slug} agent={agent} className="font-medium" />
                    <span className="text-muted"> · {agent.title || agent.role}</span>
                  </span>
                  <span className="shrink-0 text-xs text-faint">{team.name}</span>
                </li>
              ))}
            </ul>
          ) : (
            <Quiet>{teams.length ? "Their teams are people only." : "None yet."}</Quiet>
          )}
        </Card>

        <Card icon={<KeyRound size={14} />} title="Access">
          <dl className="space-y-3 text-sm">
            <div>
              <dt className="text-xs text-faint">Code</dt>
              <dd className="mt-0.5">{access.summary}</dd>
              {access.through.map((line) => (
                <dd key={line} className="text-muted">
                  {line}
                </dd>
              ))}
            </div>
            <div>
              <dt className="flex items-center gap-2 text-xs text-faint">
                Storage <Coming />
              </dt>
              <dd className="mt-0.5 text-muted">Who can read and write the workspace's files comes with Storage.</dd>
            </div>
            {spend && (
              <div>
                <dt className="flex items-center gap-1.5 text-xs text-faint">
                  <Wallet size={12} /> Agents' spend for them this month
                </dt>
                <dd className="mt-0.5 tabular-nums">
                  {money(spend.spent)}
                  {spend.budget != null && <span className="text-muted"> of {money(spend.budget)}</span>}
                </dd>
              </div>
            )}
          </dl>
        </Card>
      </div>
    </div>
  );
}

function Card({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <section className="rounded-xl border border-line bg-surface p-4">
      <h2 className="mb-3 flex items-center gap-2 text-sm font-medium text-muted">
        <span className="text-faint">{icon}</span>
        {title}
      </h2>
      {children}
    </section>
  );
}

function Quiet({ children }: { children: ReactNode }) {
  return <p className="text-sm text-faint">{children}</p>;
}

function PersonRow({ slug, person }: { slug: string; person: Pick<DirectoryPerson, "user_id" | "username" | "display_username" | "name" | "avatar" | "title"> }) {
  return (
    <span className="flex min-w-0 items-center gap-2.5">
      <PersonFace person={person} size={24} ring="var(--color-surface)" />
      <span className="min-w-0 truncate">
        <PersonLink workspace={slug} person={person} className="font-medium" />
        {person.title && <span className="text-muted"> · {person.title}</span>}
      </span>
    </span>
  );
}

/** Their title and what they own (theirs, or an owner's to change), and who they report to (an owner's). */
function EditProfile({
  person,
  people,
  canManage,
  actionData,
}: {
  person: DirectoryPerson;
  people: DirectoryPerson[];
  canManage: boolean;
  actionData: { intent: string; error: string | null; saved?: true } | undefined;
}) {
  const [open, setOpen] = useState(false);
  const saved = actionData?.intent === "profile" && actionData.saved;
  useEffect(() => {
    if (saved) setOpen(false);
  }, [saved, actionData]);
  const choices = managerChoices(people, person.username);
  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)}>
        <Pencil size={14} />
        Edit profile
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit {personName(person)}'s profile</DialogTitle>
            <DialogDescription>Shown in the directory, and told to the agents on their teams.</DialogDescription>
          </DialogHeader>
          <Form method="post" className="space-y-4">
            <input type="hidden" name="intent" value="profile" />
            <Field label="Title" hint="Their job here, such as Staff Engineer.">
              <Input name="title" defaultValue={person.title ?? ""} maxLength={80} placeholder="Staff Engineer" />
            </Field>
            <Field label="What they own" hint="One per line: a product, a process, an account. Agents ask them about these.">
              <Textarea name="owns" defaultValue={person.owns.join("\n")} rows={3} placeholder={"storefront\nthe release process"} />
            </Field>
            {canManage && (
              <label className="block">
                <span className="mb-1.5 block text-sm font-medium text-muted">Reports to</span>
                <SelectField
                  name="manager"
                  defaultValue={person.manager ?? "none"}
                  className="w-full"
                  options={[{ value: "none", label: "No one" }, ...choices.map((p) => ({ value: p.username, label: `${personName(p)}${p.title ? ` · ${p.title}` : ""}` }))]}
                />
              </label>
            )}
            {actionData?.intent === "profile" && <ErrorText>{actionData.error}</ErrorText>}
            <DialogFooter>
              <Button variant="outline" type="button" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <SubmitButton pending="Saving…" match={{ intent: "profile" }}>
                Save
              </SubmitButton>
            </DialogFooter>
          </Form>
        </DialogContent>
      </Dialog>
    </>
  );
}
