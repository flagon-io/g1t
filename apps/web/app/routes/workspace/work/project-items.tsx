import type { Route } from "./+types/project-items";
import { ProjectHeader } from "../../../components/projects";
import { page } from "../../../lib/meta";
import { projectPath } from "../../../lib/projects";
import { loadProject, projectAction } from "../../../lib/projects.server";
import { loadWorkList } from "../../../lib/work-list.server";
import { WorkListView } from "./list";

export function meta({ params, loaderData, ...args }: Route.MetaArgs) {
  return page(args, { title: `Items · ${loaderData?.project.name ?? params.slug} · Projects · ${params.owner} · g1t` });
}

/** A project's Items: the Work list (its filters, pages and rows) of this project's work items alone, under its header. */
export async function loader(args: Route.LoaderArgs) {
  const project = await loadProject(args);
  const list = await loadWorkList(args, project.project.slug);
  return { ...project, list };
}

export async function action({ request, params, context }: Route.ActionArgs) {
  return projectAction(request, params, context);
}

export default function ProjectItems({ loaderData }: Route.ComponentProps) {
  const { workspace, project, canEdit, canOpen, members, list } = loaderData;
  return (
    <div>
      <ProjectHeader
        project={project}
        workspace={workspace}
        tab="items"
        canEdit={canEdit}
        canOpen={canOpen}
        members={members}
        today={new Date(loaderData.today)}
      />
      <WorkListView data={list} project={{ slug: project.slug, base: projectPath(workspace, project.slug, "items") }} />
    </div>
  );
}
