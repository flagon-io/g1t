import { Users } from "lucide-react";
import { Form, Link, data, useSearchParams } from "react-router";

import type { TeamRole } from "@g1t/contracts";

import type { Route } from "./+types/members";
import { useTeam } from "../../../components/teams";
import { ErrorText, Field, Input, SubmitButton } from "../../../components/ui";
import { Avatar } from "../../../components/ui/avatar";
import { Badge } from "../../../components/ui/badge";
import { Card } from "../../../components/ui/card";
import { CheckboxOption } from "../../../components/ui/checkbox";
import { Switch } from "../../../components/ui/switch";
import { WithPresence } from "../../../components/presence";
import { leads, personPath } from "../../../lib/people";
import { teamPath } from "../../../lib/teams";
import { identity } from "../../../lib/services.server";
import { assertSameOrigin, getViewer, requireUser, roleIn, unwrap } from "../../../lib/session.server";
import { UserCard } from "../../../components/user-card";

export async function loader({ params, context, request }: Route.LoaderArgs) {
  const viewer = getViewer(context);
  if (!roleIn(viewer, params.owner)) throw data(null, { status: 404 });
  const children = new URL(request.url).searchParams.get("children") === "1";
  const members = unwrap(await identity.teamMembers(viewer, params.owner, params.team, children));
  return { members, children, me: viewer?.username ?? null };
}

export async function action({ request, params, context }: Route.ActionArgs) {
  assertSameOrigin(request);
  const user = requireUser(context, request);
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const username = String(form.get("username") ?? "").trim().replace(/^@/, "");
  if (!username) return { intent, username, error: "Enter a username." };
  if (intent === "remove") {
    const removed = await identity.removeTeamMember(user, params.owner, params.team, username);
    return removed.ok ? { intent, username, error: null } : { intent, username, error: removed.error.message };
  }
  const role: TeamRole = form.get("role") === "maintainer" ? "maintainer" : "member";
  const set = await identity.setTeamMember(user, params.owner, params.team, username, role);
  return set.ok ? { intent, username, error: null } : { intent, username, error: set.error.message };
}

export default function TeamMembers({ loaderData, actionData }: Route.ComponentProps) {
  const team = useTeam();
  const { members, children, me } = loaderData;
  const [, setParams] = useSearchParams();
  const manage = team.can_manage;
  const rowError = (username: string) =>
    actionData && actionData.intent !== "add" && actionData.username === username ? actionData.error : null;

  return (
    <div className="max-w-3xl space-y-10">
      <section aria-labelledby="team-people" className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 id="team-people" className="flex items-center gap-2 font-medium">
            <Users size={15} className="text-faint" />
            People <span className="text-sm font-normal text-faint tabular-nums">{team.members_count}</span>
          </h2>
          {team.child_teams_count > 0 && (
            <label className="flex items-center gap-2.5 text-sm text-muted">
              <Switch
                size="sm"
                checked={children}
                onCheckedChange={(on) => setParams(on ? { children: "1" } : {}, { replace: true, preventScrollReset: true })}
              />
              Include the people of child teams
            </label>
          )}
        </div>

        {members.length === 0 ? (
          <Card asChild tone="plain" className="border-dashed px-6 py-6 text-center text-sm text-muted">
            <p>
              {`No one is in ${team.name} yet.`}
              {manage && " Add members of the workspace below."}
            </p>
          </Card>
        ) : (
          <Card asChild tone="plain" divided>
            <ul>
              {members.map((member) => {
                const self = member.username === me;
                return (
                  <li key={member.username} className="px-4 py-3">
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                      <WithPresence person={{ username: member.username }} size={28}>
                        <Avatar name={member.username} image={member.avatar} size={28} />
                      </WithPresence>
                      <div className="min-w-0 grow basis-32 truncate">
                        <UserCard username={member.username}>
                          <Link to={personPath(team.workspace, member.username)} className="text-sm font-medium hover:text-accent">
                            {member.name || member.username}
                          </Link>
                        </UserCard>
                        {member.name && <span className="ml-2 hidden font-mono text-xs text-faint sm:inline">{member.username}</span>}
                      </div>
                      {leads(team.lead, { username: member.username }) && <Badge tone="accent">Lead</Badge>}
                      {member.via ? (
                        <Link to={teamPath(team.workspace, member.via)}>
                          <Badge>via {member.via}</Badge>
                        </Link>
                      ) : member.role === "maintainer" ? (
                        <Badge tone="accent">Maintainer</Badge>
                      ) : (
                        <Badge>Member</Badge>
                      )}
                      {!member.via && (manage || self) && (
                        <span className="flex items-center gap-1">
                          {manage && (
                            <Form method="post">
                              <input type="hidden" name="intent" value="role" />
                              <input type="hidden" name="username" value={member.username} />
                              <input type="hidden" name="role" value={member.role === "maintainer" ? "member" : "maintainer"} />
                              <SubmitButton variant="outline" match={{ intent: "role", username: member.username }} pending="Saving…">
                                {member.role === "maintainer" ? "Make member" : "Make maintainer"}
                              </SubmitButton>
                            </Form>
                          )}
                          <Form method="post">
                            <input type="hidden" name="intent" value="remove" />
                            <input type="hidden" name="username" value={member.username} />
                            <SubmitButton variant="outline" match={{ intent: "remove", username: member.username }} pending="Removing…">
                              {self ? "Leave" : "Remove"}
                            </SubmitButton>
                          </Form>
                        </span>
                      )}
                    </div>
                    <ErrorText>{rowError(member.username)}</ErrorText>
                  </li>
                );
              })}
            </ul>
          </Card>
        )}

        {manage && (
          <Form method="post" key={members.length} className="flex flex-col gap-3 sm:flex-row sm:items-start">
            <input type="hidden" name="intent" value="add" />
            <div className="grow">
              <Field label="Add a person" hint={`A member of ${team.workspace}, by username. Maintainers manage the team's people and settings.`}>
                <Input name="username" required maxLength={39} placeholder="username" />
              </Field>
            </div>
            <CheckboxOption name="role" value="maintainer" label="Maintainer" className="sm:pt-[2.1rem]" />
            <div className="sm:pt-[1.625rem]">
              <SubmitButton match={{ intent: "add" }} pending="Adding…">
                Add
              </SubmitButton>
            </div>
          </Form>
        )}
        {actionData?.intent === "add" && <ErrorText>{actionData.error}</ErrorText>}
      </section>
    </div>
  );
}
