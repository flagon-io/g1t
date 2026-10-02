import { Plus, Users } from "lucide-react";
import { Form, data } from "react-router";

import type { Route } from "./+types/workspace";
import { RepoList } from "../components/repo-list";
import { Avatar, Button, ButtonLink, ErrorText, Input, Pill } from "../components/ui";
import { identity, repos as reposApi } from "../lib/services.server";
import { assertSameOrigin, getViewer, requireUser } from "../lib/session.server";

export function meta({ loaderData, params }: Route.MetaArgs) {
  return [{ title: `${loaderData?.workspace.name ?? params.owner} · g1t` }];
}

export async function loader({ params, context }: Route.LoaderArgs) {
  const viewer = getViewer(context);
  const workspace = await identity.getWorkspace(params.owner);
  if (!workspace) throw data(null, { status: 404 });
  const role =
    viewer?.workspaces?.find((membership) => membership.slug === workspace.slug)
      ?.role ?? null;
  const [repos, members] = await Promise.all([
    reposApi.list(viewer, { namespace: workspace.slug }),
    role ? identity.listMembers(workspace.slug, viewer) : null,
  ]);
  return {
    workspace,
    repos,
    role,
    members: members?.ok ? members.value : null,
  };
}

export async function action({ request, params, context }: Route.ActionArgs) {
  assertSameOrigin(request);
  const user = requireUser(context, request);
  const form = await request.formData();
  const username = String(form.get("username") ?? "");
  const result =
    form.get("action") === "remove"
      ? await identity.removeMember(user, params.owner, username)
      : await identity.addMember(user, params.owner, username);
  return result.ok ? null : { error: result.error.message };
}

export default function WorkspacePage({
  loaderData,
  actionData,
}: Route.ComponentProps) {
  const { workspace, repos, role, members } = loaderData;
  return (
    <main className="mx-auto grid max-w-6xl gap-10 px-4 py-10 lg:grid-cols-[1fr_18rem]">
      <div className="min-w-0">
        <div className="flex items-center gap-4">
          <Avatar name={workspace.slug} size={56} />
          <div className="min-w-0 grow">
            <h1 className="truncate text-2xl font-semibold tracking-tight">
              {workspace.name}
            </h1>
            <p className="font-mono text-sm text-muted">
              g1t.sh/{workspace.slug}
            </p>
          </div>
          {role && (
            <ButtonLink to={`/new?workspace=${workspace.slug}`}>
              <Plus size={15} />
              New repository
            </ButtonLink>
          )}
        </div>
        <h2 className="mt-10 text-sm font-medium text-muted">Repositories</h2>
        <RepoList repos={repos} />
      </div>

      <aside>
        <h2 className="flex items-center gap-2 text-sm font-medium">
          <Users size={15} className="text-faint" />
          {workspace.memberCount}{" "}
          {workspace.memberCount === 1 ? "member" : "members"}
        </h2>
        {members && (
          <ul className="mt-3 space-y-1">
            {members.map((member) => (
              <li
                key={member.username}
                className="flex items-center gap-2 rounded-md px-1 py-1 text-sm"
              >
                <Avatar name={member.username} />
                <span className="grow font-mono">{member.username}</span>
                {member.role === "owner" ? (
                  <Pill>owner</Pill>
                ) : (
                  role === "owner" && (
                    <Form method="post">
                      <input type="hidden" name="action" value="remove" />
                      <input type="hidden" name="username" value={member.username} />
                      <button
                        type="submit"
                        className="text-xs text-faint hover:text-danger"
                      >
                        Remove
                      </button>
                    </Form>
                  )
                )}
              </li>
            ))}
          </ul>
        )}
        {role === "owner" && (
          <Form method="post" className="mt-4 flex gap-2">
            <Input name="username" placeholder="Username to add" required />
            <Button variant="quiet" type="submit">
              Add
            </Button>
          </Form>
        )}
        <div className="mt-2">
          <ErrorText>{actionData?.error}</ErrorText>
        </div>
        {!role && (
          <p className="mt-2 text-sm text-muted">
            Members can create repositories here and ship changes to them.
          </p>
        )}
      </aside>
    </main>
  );
}
