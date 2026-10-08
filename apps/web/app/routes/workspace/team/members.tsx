import { Users } from "lucide-react";
import { Form, Link, data, useSearchParams } from "react-router";

import type { TeamRole } from "@g1t/contracts";

import type { Route } from "./+types/members";
import { useTeam } from "../../../components/teams";
import { Avatar, ErrorText, Field, Input, SubmitButton } from "../../../components/ui";
import { Badge } from "../../../components/ui/badge";
import { CheckboxOption } from "../../../components/ui/checkbox";
import { Switch } from "../../../components/ui/switch";
import { teamPath } from "../../../lib/teams";
import { identity } from "../../../lib/services.server";
import { assertSameOrigin, getViewer, requireUser, roleIn, unwrap } from "../../../lib/session.server";

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
    <div className="max-w-3xl space-y-6">
      {team.child_teams_count > 0 && (
        <label className="flex items-center gap-2.5 text-sm text-muted">
          <Switch
            size="sm"
            checked={children}
            onCheckedChange={(on) =>
              setParams(on ? { children: "1" } : {}, { replace: true, preventScrollReset: true })
            }
          />
          Include the people of child teams
        </label>
      )}

      {members.length === 0 ? (
        <div className="rounded-xl border border-dashed border-line px-6 py-10 text-center">
          <Users size={18} className="mx-auto text-faint" />
          <p className="mt-2 text-sm font-medium">No one is in {team.name} yet</p>
          {manage && <p className="mt-1 text-sm text-muted">Add members of {team.workspace} below.</p>}
        </div>
      ) : (
        <ul className="divide-y divide-line rounded-xl border border-line">
          {members.map((member) => {
            const self = member.username === me;
            return (
              <li key={member.username} className="px-4 py-3">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                  <Avatar name={member.username} image={member.avatar} size={28} />
                  <div className="min-w-0 grow basis-32 truncate">
                    <Link to={`/u/${member.username}`} className="font-mono text-sm hover:text-accent">
                      {member.username}
                    </Link>
                    {member.name && <span className="ml-2 hidden text-sm text-muted sm:inline">{member.name}</span>}
                  </div>
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
                          <SubmitButton variant="quiet" match={{ intent: "role", username: member.username }} pending="Saving…">
                            {member.role === "maintainer" ? "Make member" : "Make maintainer"}
                          </SubmitButton>
                        </Form>
                      )}
                      <Form method="post">
                        <input type="hidden" name="intent" value="remove" />
                        <input type="hidden" name="username" value={member.username} />
                        <SubmitButton variant="quiet" match={{ intent: "remove", username: member.username }} pending="Removing…">
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
      )}

      {manage && (
        <Form method="post" key={members.length} className="flex flex-col gap-3 sm:flex-row sm:items-start">
          <input type="hidden" name="intent" value="add" />
          <div className="grow">
            <Field label="Add a member" hint={`A member of ${team.workspace}, by username. Maintainers manage the team's people and settings.`}>
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
    </div>
  );
}
