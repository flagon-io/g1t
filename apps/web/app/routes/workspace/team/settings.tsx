import { useState } from "react";
import { Form, data, redirect } from "react-router";

import {
  MAX_ASSIGNED,
  REVIEW_ALGORITHM_LABELS,
  REVIEW_ALGORITHM_SUMMARIES,
  TEAM_VISIBILITY_SUMMARIES,
  type ReviewAlgorithm,
  type TeamVisibility,
} from "@g1t/contracts";

import type { Route } from "./+types/settings";
import { ConfirmDialog } from "../../../components/repo-lifecycle";
import { useTeam, useTeamAgents } from "../../../components/teams";
import { Coming } from "../../../components/people";
import { SelectField } from "../../../components/ui/select";
import { budgetFromText } from "../../../lib/people";
import { Button, ErrorText, Field, Input, SubmitButton } from "../../../components/ui";
import { Input as NumberInput } from "../../../components/ui/input";
import { Textarea } from "../../../components/ui/textarea";
import { CheckboxOption } from "../../../components/ui/checkbox";
import { RadioGroup, RadioOption } from "../../../components/ui/radio-group";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../../components/ui/select";
import { SwitchCard } from "../../../components/ui/switch";
import { parentChoices, reviewAssignmentFromForm, teamChangesFromForm, teamPath } from "../../../lib/teams";
import { chat, identity, workspaceAgents } from "../../../lib/services.server";
import { assertSameOrigin, getViewer, requireUser, roleIn, unwrap } from "../../../lib/session.server";

/** The parent select's value for "no parent". */
const NO_PARENT = "-";
/** The lead select's value for no lead. */
const NO_LEAD = "none";

/**
 * Its lead, channel and budget. An agent made lead that is on the team
 * only through its home team is added to it first, as identity needs; a
 * channel is found by its name in Chat, as the viewer sees it.
 */
async function saveLeadChannelBudget(form: FormData, workspace: string, slug: string, user: Parameters<typeof identity.updateTeam>[0]) {
  const intent = "people";
  const lead = String(form.get("lead") ?? NO_LEAD);
  const channel = String(form.get("channel") ?? "").trim().replace(/^#/, "").toLowerCase();
  const budget = budgetFromText(String(form.get("budget") ?? ""));
  if (budget === null) return { intent, error: "Give the budget in dollars, such as 150.", saved: false };
  if (lead.startsWith("agent:")) {
    const listed = await workspaceAgents.list(workspace, user).catch(() => null);
    const agent = listed?.ok ? listed.value.find((a) => `agent:${a.id}` === lead) : null;
    if (!agent) return { intent, error: "Choose one of the team's agents.", saved: false };
    const added = await identity.setTeamAgent(user, workspace, slug, agent.id);
    if (!added.ok) return { intent, error: added.error.message, saved: false };
  }
  let channelId = "";
  let channelName = "";
  if (channel) {
    const found = await chat.channelByName(workspace, channel, user).catch(() => null);
    if (!found?.ok || found.value.channel.kind !== "channel") return { intent, error: `There is no channel #${channel} you can see.`, saved: false };
    channelId = found.value.channel.id;
    channelName = found.value.channel.name ?? channel;
  }
  const saved = await identity.updateTeam(user, workspace, slug, {
    lead: lead === NO_LEAD ? "" : lead,
    channel_id: channelId,
    channel_name: channelName,
    budget_micros: budget,
  });
  return saved.ok ? { intent, error: null, saved: true } : { intent, error: saved.error.message, saved: false };
}

export async function loader({ params, context }: Route.LoaderArgs) {
  const viewer = getViewer(context);
  if (!roleIn(viewer, params.owner)) throw data(null, { status: 404 });
  const team = unwrap(await identity.getTeam(viewer, params.owner, params.team));
  if (!team.can_manage) throw data(null, { status: 404 });
  const [all, members] = await Promise.all([
    identity.listTeams(viewer, params.owner).then((found) => (found.ok ? found.value : [])),
    // Who can lead it: its own people (and its agents, from the layout).
    identity.teamMembers(viewer, params.owner, params.team, false).then((found) => (found.ok ? found.value : [])),
  ]);
  const parents = parentChoices(all, team.slug).filter((other) => other.can_manage || other.slug === team.parent?.slug);
  return { parents, people: members.map((member) => ({ username: member.username, name: member.name })) };
}

export async function action({ request, params, context }: Route.ActionArgs) {
  assertSameOrigin(request);
  const user = requireUser(context, request);
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  if (intent === "delete") {
    const deleted = await identity.deleteTeam(user, params.owner, params.team);
    if (!deleted.ok) return { intent, error: deleted.error.message, saved: false };
    throw redirect(`/${params.owner}/-/teams`);
  }
  if (intent === "review") {
    const current = unwrap(await identity.getTeam(user, params.owner, params.team));
    const review = reviewAssignmentFromForm(form, current.review_assignment);
    const saved = await identity.updateTeam(user, params.owner, params.team, { review_assignment: review });
    return saved.ok ? { intent, error: null, saved: true } : { intent, error: saved.error.message, saved: false };
  }
  if (intent === "people") return saveLeadChannelBudget(form, params.owner, params.team, user);
  const changes = teamChangesFromForm(form);
  if (changes.parent === NO_PARENT) changes.parent = "";
  const saved = await identity.updateTeam(user, params.owner, params.team, changes);
  if (!saved.ok) return { intent, error: saved.error.message, saved: false };
  // A new slug is a new address.
  if (saved.value.slug !== params.team) throw redirect(teamPath(saved.value.workspace, saved.value.slug, "settings"));
  return { intent, error: null, saved: true };
}

export default function TeamSettings({ loaderData, actionData }: Route.ComponentProps) {
  const team = useTeam();
  const { agents } = useTeamAgents();
  const { parents, people } = loaderData;
  const leadValue = team.lead ? (team.lead.kind === "user" ? `@${team.lead.username}` : `agent:${team.lead.agent_id}`) : NO_LEAD;
  const said = (intent: string) => (actionData?.intent === intent ? actionData : null);
  const [visibility, setVisibility] = useState<TeamVisibility>(team.visibility);
  const review = team.review_assignment;
  const [assigning, setAssigning] = useState(review.enabled);
  const [algorithm, setAlgorithm] = useState<ReviewAlgorithm>(review.algorithm);
  const [skipBusy, setSkipBusy] = useState(review.skip_busy);

  return (
    <div className="max-w-2xl space-y-10">
      <section aria-labelledby="profile">
        <h2 id="profile" className="font-medium">
          Profile
        </h2>
        <Form method="post" className="mt-4 space-y-5" key={team.updated_at}>
          <input type="hidden" name="intent" value="profile" />
          <Field label="Name">
            <Input name="name" required maxLength={80} defaultValue={team.name} />
          </Field>
          <Field label="Slug" hint={`Mentioned as @${team.workspace}/<slug>. Changing it changes the team's address and how it is mentioned.`}>
            <Input name="slug" required maxLength={60} defaultValue={team.slug} pattern="[a-z0-9]+(-[a-z0-9]+)*" />
          </Field>
          <Field label="Description">
            <Textarea name="description" rows={2} maxLength={280} defaultValue={team.description ?? ""} />
          </Field>
          <fieldset>
            <legend className="mb-2 text-sm font-medium text-muted">Visibility</legend>
            <RadioGroup name="visibility" value={visibility} onValueChange={(value) => setVisibility(value as TeamVisibility)} className="space-y-3">
              <RadioOption value="visible" label="Visible" description={TEAM_VISIBILITY_SUMMARIES.visible} />
              <RadioOption value="secret" label="Secret" description={TEAM_VISIBILITY_SUMMARIES.secret} />
            </RadioGroup>
          </fieldset>
          {visibility === "visible" && (
            <div>
              <span className="mb-1.5 block text-sm font-medium text-muted">Parent team</span>
              <Select name="parent" defaultValue={team.parent?.slug ?? NO_PARENT}>
                <SelectTrigger aria-label="Parent team" className="sm:max-w-72">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_PARENT}>No parent</SelectItem>
                  {parents.map((parent) => (
                    <SelectItem key={parent.slug} value={parent.slug}>
                      {parent.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <span className="mt-1.5 block text-xs text-faint">
                It has its parent's roles on repositories, and hears what is asked of its parent. Moving it needs you to
                maintain both teams, or own the workspace.
              </span>
            </div>
          )}
          <input type="hidden" name="notify-shown" value="1" />
          <SwitchCard name="notify" defaultChecked={team.notify} title="Notify the team when it is mentioned">
            Everyone in it, and in its child teams, hears of @{team.workspace}/{team.slug} in their notifications.
          </SwitchCard>
          <ErrorText>{said("profile")?.error ?? null}</ErrorText>
          <div className="flex items-center gap-3">
            <SubmitButton match={{ intent: "profile" }} pending="Saving…">
              Save
            </SubmitButton>
            {said("profile")?.saved && <span className="text-sm text-muted">Saved.</span>}
          </div>
        </Form>
      </section>

      <section aria-labelledby="lead" className="border-t border-line pt-8">
        <h2 id="lead" className="font-medium">
          Lead, channel and budget
        </h2>
        <p className="mt-1 text-sm text-muted">
          Everyone on {team.name}, agents included, is told who leads it and where it talks. Its budget caps what its agents spend
          together in a month; each agent keeps its own budget too.
        </p>
        <Form method="post" className="mt-4 space-y-5" key={`people-${team.updated_at}`}>
          <input type="hidden" name="intent" value="people" />
          <label className="block">
            <span className="mb-1.5 block text-sm font-medium text-muted">Lead</span>
            <SelectField
              name="lead"
              defaultValue={leadValue}
              className="w-full sm:max-w-72"
              options={[
                { value: NO_LEAD, label: "No lead" },
                ...people.map((person) => ({ value: `@${person.username}`, label: person.name ? `${person.name} (@${person.username})` : `@${person.username}` })),
                ...agents.map((agent) => ({ value: `agent:${agent.id}`, label: `${agent.display_name}, an agent` })),
              ]}
            />
            <span className="mt-1.5 block text-xs text-faint">Someone on the team. Agents page the lead first when a person is needed.</span>
          </label>
          <Field label="Channel" hint="The team's channel in Chat, by name. Leave it empty for none.">
            <span className="block sm:max-w-72">
              <Input name="channel" defaultValue={team.channel?.name ?? ""} placeholder="sales" />
            </span>
          </Field>
          <Field label="Budget for its agents, a month" hint="In dollars. Empty or 0 for no team budget.">
            <span className="block sm:max-w-40">
              <Input name="budget" inputMode="decimal" defaultValue={team.budget_micros ? String(team.budget_micros / 1_000_000) : ""} placeholder="150" />
            </span>
          </Field>
          <div className="flex items-center gap-2 text-sm text-muted">
            Storage level <Coming />
          </div>
          <ErrorText>{said("people")?.error ?? null}</ErrorText>
          <div className="flex items-center gap-3">
            <SubmitButton match={{ intent: "people" }} pending="Saving…">
              Save
            </SubmitButton>
            {said("people")?.saved && <span className="text-sm text-muted">Saved.</span>}
          </div>
        </Form>
      </section>

      <section aria-labelledby="review" className="border-t border-line pt-8">
        <h2 id="review" className="font-medium">
          Code review assignment
        </h2>
        <p className="mt-1 text-sm text-muted">
          When {team.name} is asked to review a pull request, by a person or by a CODEOWNERS file. Off, everyone in the
          team is asked. On, g1t picks people from it; the team stays shown as asked.
        </p>
        <Form method="post" className="mt-4 space-y-5" key={`review-${team.updated_at}`}>
          <input type="hidden" name="intent" value="review" />
          <SwitchCard name="enabled" checked={assigning} onCheckedChange={setAssigning} title="Assign reviewers from the team">
            Never the pull request's author, and people from the team already asked count.
          </SwitchCard>
          {assigning && (
            <div className="space-y-5 rounded-xl border border-line p-4">
              <Field label="How many people" hint={`1 to ${MAX_ASSIGNED}.`}>
                <NumberInput name="count" type="number" min={1} max={MAX_ASSIGNED} defaultValue={review.count} className="max-w-24" />
              </Field>
              <fieldset>
                <legend className="mb-2 text-sm font-medium text-muted">Who goes first</legend>
                <RadioGroup name="algorithm" value={algorithm} onValueChange={(value) => setAlgorithm(value as ReviewAlgorithm)} className="space-y-3">
                  {(["round_robin", "load_balance"] as const).map((value) => (
                    <RadioOption key={value} value={value} label={REVIEW_ALGORITHM_LABELS[value]} description={REVIEW_ALGORITHM_SUMMARIES[value]} />
                  ))}
                </RadioGroup>
              </fieldset>
              <div className="space-y-2">
                <CheckboxOption
                  name="skip_busy"
                  checked={skipBusy}
                  onCheckedChange={(on) => setSkipBusy(on === true)}
                  label="Skip people who are busy"
                  description="Busy: this many or more open pull requests are waiting on their review."
                />
                {skipBusy && (
                  <div className="pl-6">
                    <NumberInput name="busy_at" type="number" min={1} max={100} defaultValue={review.busy_at} aria-label="Busy at" className="max-w-24" />
                  </div>
                )}
              </div>
              <CheckboxOption
                name="include_child_teams"
                defaultChecked={review.include_child_teams}
                label="Pick from child teams too"
                description="Otherwise only the team's own people are picked."
              />
              <CheckboxOption
                name="notify_team"
                defaultChecked={review.notify_team}
                label="Also tell the rest of the team"
                description="Everyone in the team hears of the request, not only the people picked."
              />
              <Field label="Never pick" hint="Usernames, separated by spaces or commas.">
                <Input name="excluded" defaultValue={review.excluded.join(" ")} placeholder="ana bo" />
              </Field>
            </div>
          )}
          {!assigning && (
            <>
              {/* Kept as they are while assignment is off. */}
              <input type="hidden" name="algorithm" value={review.algorithm} />
              <input type="hidden" name="count" value={review.count} />
              <input type="hidden" name="busy_at" value={review.busy_at} />
              <input type="hidden" name="excluded" value={review.excluded.join(" ")} />
              {review.skip_busy && <input type="hidden" name="skip_busy" value="on" />}
              {review.include_child_teams && <input type="hidden" name="include_child_teams" value="on" />}
              {review.notify_team && <input type="hidden" name="notify_team" value="on" />}
            </>
          )}
          <ErrorText>{said("review")?.error ?? null}</ErrorText>
          <div className="flex items-center gap-3">
            <SubmitButton match={{ intent: "review" }} pending="Saving…">
              Save
            </SubmitButton>
            {said("review")?.saved && <span className="text-sm text-muted">Saved.</span>}
          </div>
        </Form>
      </section>

      <section aria-labelledby="danger" className="border-t border-line pt-8">
        <h2 id="danger" className="font-medium">
          Delete this team
        </h2>
        <p className="mt-1 text-sm text-muted">
          Its people stay in {team.workspace}, and lose the roles the team gave them. Its child teams move up to{" "}
          {team.parent ? team.parent.name : "the top"}.
        </p>
        <div className="mt-4">
          <ConfirmDialog
            intent="delete"
            title={`Delete ${team.name}?`}
            description="This cannot be undone."
            confirm={`${team.workspace}/${team.slug}`}
            submit="Delete team"
            busy="Deleting…"
            error={said("delete")?.error ?? null}
            trigger={(open) => (
              <Button type="button" variant="danger" onClick={open}>
                Delete team
              </Button>
            )}
          >
            <li>Mentions of @{team.workspace}/{team.slug} stop telling anyone.</li>
            <li>Pull requests that asked it to review keep the people it picked.</li>
          </ConfirmDialog>
        </div>
      </section>
    </div>
  );
}
