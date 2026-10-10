import { Box } from "lucide-react";
import { useState } from "react";
import { Form, Link, data, useFetcher } from "react-router";

import { REPO_ROLES, REPO_ROLE_LABELS, REPO_ROLE_SUMMARIES, type RepoRole, type TeamRepo } from "@g1t/contracts";

import type { Route } from "./+types/repositories";
import { useTeam } from "../../../components/teams";
import { ErrorText, SubmitButton } from "../../../components/ui";
import { Badge } from "../../../components/ui/badge";
import { Card } from "../../../components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../../components/ui/select";
import { teamPath } from "../../../lib/teams";
import { identity, repos } from "../../../lib/services.server";
import { assertSameOrigin, getViewer, requireUser, roleIn, unwrap } from "../../../lib/session.server";

const isRole = (value: string): value is RepoRole => (REPO_ROLES as readonly string[]).includes(value);

export async function loader({ params, context }: Route.LoaderArgs) {
  const viewer = getViewer(context);
  if (!roleIn(viewer, params.owner)) throw data(null, { status: 404 });
  const [granted, list] = await Promise.all([
    identity.teamRepos(viewer, params.owner, params.team).then(unwrap),
    repos.list(viewer, { namespace: params.owner, memberOnly: true }).catch(() => []),
  ]);
  return { granted, names: list.filter((repo) => !repo.archivedAt).map((repo) => repo.name) };
}

export async function action({ request, params, context }: Route.ActionArgs) {
  assertSameOrigin(request);
  const user = requireUser(context, request);
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const name = String(form.get("repo") ?? "").trim().replace(/^.*\//, "");
  if (!name) return { intent, repo: name, error: "Choose a repository." };
  if (intent === "remove") {
    const removed = await identity.removeTeamRepo(user, params.owner, params.team, params.owner, name);
    return removed.ok ? { intent, repo: name, error: null } : { intent, repo: name, error: removed.error.message };
  }
  const role = String(form.get("role") ?? "");
  if (!isRole(role)) return { intent, repo: name, error: "Choose a role." };
  const set = await identity.setTeamRepo(user, params.owner, params.team, params.owner, name, role);
  return set.ok ? { intent, repo: name, error: null } : { intent, repo: name, error: set.error.message };
}

function RoleSelect({ value, onValueChange, name }: { value: RepoRole; onValueChange?: (role: RepoRole) => void; name?: string }) {
  return (
    <Select name={name} value={value} onValueChange={(role) => onValueChange?.(role as RepoRole)}>
      <SelectTrigger aria-label="Role" className="w-32">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {REPO_ROLES.map((role) => (
          <SelectItem key={role} value={role} description={REPO_ROLE_SUMMARIES[role]}>
            {REPO_ROLE_LABELS[role]}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export default function TeamRepositories({ loaderData, actionData }: Route.ComponentProps) {
  const team = useTeam();
  const { granted, names } = loaderData;
  const own = new Set(granted.filter((repo) => repo.inherited_from == null).map((repo) => repo.repo.split("/")[1]));
  const addable = names.filter((name) => !own.has(name));
  const [role, setRole] = useState<RepoRole>("write");

  return (
    <div className="max-w-3xl space-y-6">
      <p className="text-sm text-muted">
        Everyone in {team.name}, and in its child teams, has these roles. Where someone has a role another way too, the
        highest one counts. Giving a team a role on a repository needs the Admin role there.
      </p>
      {granted.length === 0 ? (
        <Card tone="plain" className="border-dashed px-6 py-10 text-center">
          <Box size={18} className="mx-auto text-faint" />
          <p className="mt-2 text-sm font-medium">{team.name} has no roles on repositories yet</p>
        </Card>
      ) : (
        <Card asChild tone="plain" divided className="overflow-hidden">
          <ul>
            {granted.map((repo) => (
              <RepoRow key={repo.repo_id} repo={repo} manage={team.can_manage} error={actionData?.repo === repo.repo.split("/")[1] && actionData.intent !== "add" ? actionData.error : null} />
            ))}
          </ul>
        </Card>
      )}

      {addable.length > 0 && (
        <Card asChild key={granted.length} className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center">
          <Form method="post">
            <input type="hidden" name="intent" value="add" />
            <Select name="repo">
              <SelectTrigger aria-label="Repository" className="sm:max-w-64">
                <SelectValue placeholder="Choose a repository" />
              </SelectTrigger>
              <SelectContent>
                {addable.map((name) => (
                  <SelectItem key={name} value={name}>
                    {name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <RoleSelect name="role" value={role} onValueChange={setRole} />
            <SubmitButton variant="outline" match={{ intent: "add" }} pending="Adding…">
              Add repository
            </SubmitButton>
          </Form>
        </Card>
      )}
      {actionData?.intent === "add" && <ErrorText>{actionData.error}</ErrorText>}
    </div>
  );
}

function RepoRow({ repo, manage, error }: { repo: TeamRepo; manage: boolean; error: string | null }) {
  const fetcher = useFetcher<typeof action>();
  const team = useTeam();
  const name = repo.repo.split("/")[1] ?? repo.repo;
  const inherited = repo.inherited_from != null;
  return (
    <li className="px-4 py-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-raised text-muted ring-1 ring-line">
          <Box size={13} />
        </span>
        <div className="min-w-0 grow basis-40">
          <Link to={`/${repo.repo}`} className="font-mono text-sm font-medium hover:underline">
            {name}
          </Link>
          {inherited && (
            <p className="text-xs text-faint">
              From{" "}
              <Link to={teamPath(team.workspace, repo.inherited_from!)} className="hover:text-fg hover:underline">
                {repo.inherited_from}
              </Link>
            </p>
          )}
        </div>
        {inherited || !manage ? (
          <Badge>{REPO_ROLE_LABELS[repo.role]}</Badge>
        ) : (
          <span className="flex items-center gap-1">
            <RoleSelect
              value={repo.role}
              onValueChange={(role) => fetcher.submit({ intent: "role", repo: name, role }, { method: "post" })}
            />
            <Form method="post">
              <input type="hidden" name="intent" value="remove" />
              <input type="hidden" name="repo" value={name} />
              <SubmitButton variant="outline" match={{ intent: "remove", repo: name }} pending="Removing…">
                Remove
              </SubmitButton>
            </Form>
          </span>
        )}
      </div>
      <ErrorText>{fetcher.data?.error ?? error}</ErrorText>
    </li>
  );
}
