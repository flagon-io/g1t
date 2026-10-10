import { Network, Plus } from "lucide-react";
import { Form, data } from "react-router";

import type { Route } from "./+types/teams";
import { TeamRow, useTeam } from "../../../components/teams";
import { ButtonLink, ErrorText, SubmitButton } from "../../../components/ui";
import { Card } from "../../../components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../../components/ui/select";
import { identity } from "../../../lib/services.server";
import { assertSameOrigin, getViewer, requireUser, roleIn, unwrap } from "../../../lib/session.server";

export async function loader({ params, context }: Route.LoaderArgs) {
  const viewer = getViewer(context);
  if (!roleIn(viewer, params.owner)) throw data(null, { status: 404 });
  const [children, all] = await Promise.all([
    identity.childTeams(viewer, params.owner, params.team).then(unwrap),
    identity.listTeams(viewer, params.owner).then((found) => (found.ok ? found.value : [])),
  ]);
  return { children, all };
}

export async function action({ request, params, context }: Route.ActionArgs) {
  assertSameOrigin(request);
  const user = requireUser(context, request);
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const child = String(form.get("child") ?? "").trim();
  if (!child) return { intent, child, error: "Choose a team." };
  // Moving a team under this one, or out from under it, is a change to that team.
  const moved = await identity.updateTeam(user, params.owner, child, { parent: intent === "remove" ? "" : params.team });
  return moved.ok ? { intent, child, error: null } : { intent, child, error: moved.error.message };
}

export default function ChildTeams({ loaderData, actionData }: Route.ComponentProps) {
  const team = useTeam();
  const { children, all } = loaderData;
  const manage = team.can_manage;
  // What could move under it: visible teams you manage, not already its
  // children, and not the team itself or above it.
  const above = new Set<string>();
  for (let parent = team.parent; parent; parent = all.find((other) => other.slug === parent?.slug)?.parent ?? null) {
    if (above.has(parent.slug)) break;
    above.add(parent.slug);
  }
  const movable = all.filter(
    (other) =>
      other.can_manage &&
      other.visibility === "visible" &&
      other.slug !== team.slug &&
      !above.has(other.slug) &&
      !children.some((child) => child.slug === other.slug),
  );

  return (
    <div className="max-w-3xl space-y-6">
      <p className="text-sm text-muted">
        Child teams have {team.name}'s roles on repositories as well as their own, and hear when {team.name} is mentioned
        or asked to review.
      </p>
      {children.length === 0 ? (
        <Card tone="plain" className="border-dashed px-6 py-10 text-center">
          <Network size={18} className="mx-auto text-faint" />
          <p className="mt-2 text-sm font-medium">No child teams</p>
          {team.visibility === "secret" && <p className="mt-1 text-sm text-muted">Secret teams cannot be nested.</p>}
        </Card>
      ) : (
        <Card asChild tone="plain" divided className="overflow-hidden">
          <ul>
            {children.map((child) => (
              <TeamRow key={child.id} team={child}>
                {(manage || child.can_manage) && (
                  <Form method="post" className="shrink-0">
                    <input type="hidden" name="intent" value="remove" />
                    <input type="hidden" name="child" value={child.slug} />
                    <SubmitButton variant="outline" match={{ intent: "remove", child: child.slug }} pending="Moving…">
                      Remove
                    </SubmitButton>
                  </Form>
                )}
              </TeamRow>
            ))}
          </ul>
        </Card>
      )}
      {actionData?.intent === "remove" && <ErrorText>{actionData.error}</ErrorText>}

      {manage && team.visibility === "visible" && (
        <Card className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center">
          {movable.length > 0 ? (
            <Form method="post" className="flex grow flex-col gap-3 sm:flex-row sm:items-center">
              <input type="hidden" name="intent" value="add" />
              <Select name="child">
                <SelectTrigger aria-label="Team to add" className="sm:max-w-64">
                  <SelectValue placeholder="Choose a team" />
                </SelectTrigger>
                <SelectContent>
                  {movable.map((other) => (
                    <SelectItem key={other.slug} value={other.slug}>
                      {other.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <SubmitButton variant="outline" match={{ intent: "add" }} pending="Adding…">
                Add as a child team
              </SubmitButton>
            </Form>
          ) : (
            <p className="grow text-sm text-muted">No other team you manage can go under {team.name}.</p>
          )}
          <ButtonLink variant="outline" to={`/${team.workspace}/-/teams/new?parent=${team.slug}`}>
            <Plus size={15} />
            New child team
          </ButtonLink>
        </Card>
      )}
      {actionData?.intent === "add" && <ErrorText>{actionData.error}</ErrorText>}
    </div>
  );
}
