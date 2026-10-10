import { ArrowRight, Check, Sparkles } from "lucide-react";
import { Link, data, redirect } from "react-router";

import type { Route } from "./+types/soon";
import { page } from "../../lib/meta";
import { ROADMAP, type RoadmapItem, roadmapIn, roadmapItem } from "../../lib/roadmap";
import { Badge } from "../../components/ui/badge";
import { Card } from "../../components/ui/card";

export function meta({ params, ...args }: Route.MetaArgs) {
  const item = roadmapItem(params.feature);
  return page(args, {
    title: `${item?.title ?? "Soon"} · ${params.owner}/${params.repo} · g1t`,
    description: item ? `Soon on g1t: ${item.summary}` : null,
    version: item ? [item.title, item.summary] : undefined,
  });
}

/** Soon pages that have since been built, and where each is now. */
const BUILT: Record<string, string> = { releases: "releases" };

export function loader({ params }: Route.LoaderArgs) {
  const built = BUILT[params.feature];
  if (built) throw redirect(`/${params.owner}/${params.repo}/${built}`);
  const item = roadmapItem(params.feature);
  if (!item) throw data(null, { status: 404 });
  return { item };
}

/**
 * A page a project will have: what it is for, what it will do, and what
 * to use until then. Reached from the project menu's Soon items.
 */
export default function Soon({ loaderData, params }: Route.ComponentProps) {
  return <SoonView item={loaderData.item} base={`/${params.owner}/${params.repo}`} />;
}

/**
 * A Soon page, for a project's (under `base`, `/<owner>/<project>`) or the
 * workspace's (`/<owner>/-`).
 */
/**
 * What is coming, and what to use until then. In a project, "until then"
 * is a page of that project. Across a workspace it lives in each project,
 * so `inProjects` lists them, or offers to make the first one.
 */
export function SoonView({
  item,
  base,
  inProjects,
  newProject,
}: {
  item: RoadmapItem;
  base: string;
  inProjects?: { name: string; to: string }[];
  newProject?: string;
}) {
  const siblings = roadmapIn(item.section).filter((other) => other.key !== item.key);
  const inWorkspace = item.section === "Workspace";
  return (
    <div className="mx-auto max-w-3xl">
      {/* A project's tabs already say where this is; the workspace's need saying. */}
      {inWorkspace && (
        <p className="mb-4 flex items-center gap-2 text-sm text-muted">
          <span>Across projects</span>
          <span className="text-line-strong">/</span>
          <span className="text-fg">{item.title}</span>
        </p>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-3xl font-semibold tracking-tight">{item.title}</h1>
        <Badge tone="accent" size="md" className="gap-1.5 px-2.5 font-medium">
          <Sparkles size={12} />
          Soon
        </Badge>
      </div>
      <p className="mt-3 text-lg text-muted">{item.summary}</p>

      <Card asChild className="mt-8 p-6">
        <section>
          <p className="leading-relaxed">{item.why}</p>
          <h2 className="mt-6 text-sm font-medium text-muted">What it will do</h2>
          <ul className="mt-3 space-y-2.5">
            {item.plans.map((plan) => (
              <li key={plan} className="flex gap-3 text-sm">
                <Check size={16} className="mt-0.5 shrink-0 text-accent" />
                <span>{plan}</span>
              </li>
            ))}
          </ul>
        </section>
      </Card>

      {item.today && inProjects && (
        <Card asChild tone="plain" className="mt-4 px-5 py-4">
          <section>
            <span className="block text-xs text-faint">Until then: {item.today.label.toLowerCase()} in each project</span>
            {inProjects.length > 0 ? (
              <ul className="mt-2 divide-y divide-line">
                {inProjects.map((project) => (
                  <li key={project.to}>
                    <Link
                      to={`${project.to}/${item.today!.path}`}
                      className="group flex items-center justify-between gap-4 py-2.5 text-sm"
                    >
                      <span className="font-medium">
                        {item.today!.label} in {project.name}
                      </span>
                      <ArrowRight size={16} className="text-faint transition-transform group-hover:translate-x-0.5 group-hover:text-fg" />
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <Link
                to={newProject ?? "/new"}
                className="group mt-2 flex items-center justify-between gap-4 text-sm"
              >
                <span>
                  <span className="font-medium">Create a project</span>
                  <span className="text-muted"> to plan {item.today.label.toLowerCase()} in it.</span>
                </span>
                <ArrowRight size={16} className="text-faint transition-transform group-hover:translate-x-0.5 group-hover:text-fg" />
              </Link>
            )}
          </section>
        </Card>
      )}

      {item.today && !inProjects && (
        <Link
          to={`${base}/${item.today.path}`}
          className="group mt-4 flex items-center justify-between gap-4 rounded-xl border border-line px-5 py-4 transition-colors hover:border-line-strong hover:bg-surface"
        >
          <span>
            <span className="block text-xs text-faint">Until then</span>
            <span className="mt-0.5 block text-sm font-medium">{item.today.label}</span>
          </span>
          <ArrowRight size={16} className="text-faint transition-transform group-hover:translate-x-0.5 group-hover:text-fg" />
        </Link>
      )}

      {siblings.length > 0 && (
        <section className="mt-10">
          <h2 className="text-sm font-medium text-muted">
            Also coming {inWorkspace ? "across projects" : `to ${item.section}`}
          </h2>
          <ul className="mt-3 grid gap-3 sm:grid-cols-2">
            {siblings.map((other) => (
              <li key={other.key}>
                <Link
                  to={`${base}/soon/${other.key}`}
                  className="block h-full rounded-xl border border-line p-4 transition-colors hover:border-line-strong hover:bg-surface"
                >
                  <span className="text-sm font-medium">{other.title}</span>
                  <span className="mt-1 block text-sm text-muted">{other.summary}</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      <p className="mt-10 text-xs text-faint">
        {ROADMAP.length} things are on the way to every project. Want this one sooner, or something else?{" "}
        <a href="https://g1t.sh/flagon-io/g1t/issues/new" className="text-muted hover:text-fg">
          Tell us
        </a>
        .
      </p>
    </div>
  );
}
