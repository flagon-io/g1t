// The forms of Work's projects: creating one, changing it (its fields, its
// health, its brief), archiving it, and its people and repositories. Each
// needs the Write role in the workspace, which work checks again.

import { needs } from "@g1t/contracts";

import { notFound } from "./not-found.server";
import { isFailed, part } from "./partial";
import { type ProjectResult, projectChangeOf } from "./projects";
import { identity, work } from "./services.server";
import { assertSameOrigin, getViewer, requireUser, roleIn, unwrap } from "./session.server";
import { canItem } from "./work-access";
import { repoFilter } from "./work-items";

type Context = Parameters<typeof requireUser>[0];

/**
 * What a project's pages read (its Overview and Items): the project,
 * strictly (it is what the page is about), and the workspace's people, for
 * its lead and members, as a part.
 */
export async function loadProject({ params, context }: { params: { owner: string; slug: string }; context: Context }) {
  const viewer = getViewer(context);
  const workspace = params.owner.toLowerCase();
  const member = roleIn(viewer, workspace) != null;
  const [found, members] = await Promise.all([
    work.getProject(workspace, params.slug, viewer),
    member ? part(identity.listMembers(workspace, viewer), "The workspace's people") : null,
  ]);
  if (!found.ok && found.error.code === "not_found") throw notFound("page");
  const detail = unwrap(found);
  return {
    workspace,
    member,
    detail,
    project: detail.project,
    // Changed with the Write role in the workspace; a work item is filed by a member.
    canEdit: canItem(viewer, workspace, null, "manage_labels"),
    canOpen: viewer != null && member,
    members: members == null || isFailed(members) || !members.ok ? [] : members.value.map((m) => m.username).sort(),
    today: new Date().toISOString(),
  };
}

export async function projectAction(request: Request, params: { owner?: string; slug?: string }, context: Context): Promise<ProjectResult> {
  assertSameOrigin(request);
  const user = requireUser(context, request);
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const workspace = (params.owner ?? "").toLowerCase();
  const slug = params.slug ?? String(form.get("project") ?? "");
  if (!canItem(user, workspace, null, "manage_labels")) return { intent, slug, error: needs("manage_labels") };
  const failed = (message: string): ProjectResult => ({ intent, slug, error: message });
  switch (intent) {
    case "create": {
      const change = projectChangeOf(form);
      if (typeof change === "string") return failed(change);
      if (!change.name) return failed("A project needs a name.");
      // No lead chosen on a new project is "You": the work service makes the actor its lead.
      if (change.lead === "") delete change.lead;
      const made = await work.createProject(user, workspace, { ...change, name: change.name });
      return made.ok ? { intent, slug: made.value.slug } : failed(made.error.message);
    }
    case "update":
    case "health":
    case "brief": {
      const change = projectChangeOf(form);
      if (typeof change === "string") return failed(change);
      const saved = await work.updateProject(user, workspace, slug, change);
      return saved.ok ? { intent, slug: saved.value.slug } : failed(saved.error.message);
    }
    case "archive":
    case "unarchive": {
      const done = await work.archiveProject(user, workspace, slug, intent === "archive");
      return done.ok ? { intent, slug } : failed(done.error.message);
    }
    case "add-member":
    case "remove-member": {
      const username = String(form.get("username") ?? "")
        .trim()
        .replace(/^@/, "");
      if (!username) return failed("Say who, by username.");
      const role = form.get("role") === "lead" ? "lead" : undefined;
      const done =
        intent === "add-member"
          ? await work.addProjectMember(user, workspace, slug, username, role)
          : await work.removeProjectMember(user, workspace, slug, username);
      return done.ok ? { intent, slug } : failed(done.error.message);
    }
    case "add-repo":
    case "remove-repo": {
      const repo = repoFilter(workspace, String(form.get("repo") ?? "").trim());
      if (!repo) return failed("Choose a repository of the workspace.");
      const done =
        intent === "add-repo"
          ? await work.addProjectRepo(user, workspace, slug, repo, form.get("defaultTarget") !== "0")
          : await work.removeProjectRepo(user, workspace, slug, repo);
      return done.ok ? { intent, slug } : failed(done.error.message);
    }
  }
  return failed("That is not something a project's page can do.");
}
