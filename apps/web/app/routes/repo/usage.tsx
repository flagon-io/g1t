import { Suspense } from "react";
import { Await, data } from "react-router";

import { PRODUCTS } from "@g1t/contracts";

import type { Route } from "./+types/usage";
import { UsageFilterBar, UsageSkeleton } from "../../components/usage";
import { page } from "../../lib/meta";
import { billing } from "../../lib/services.server";
import { getViewer, roleIn } from "../../lib/session.server";
import { USAGE_API, UsageView, readFilters } from "../workspace/usage";

// A project's usage: the workspace's Usage page, held to this one project.
// Its members only, as the workspace's page is.

export function meta({ params, ...args }: Route.MetaArgs) {
  return page(args, { title: `Usage · ${params.owner}/${params.repo} · g1t` });
}

export async function loader({ params, context, request }: Route.LoaderArgs) {
  const viewer = getViewer(context);
  const role = roleIn(viewer, params.owner);
  if (!role) throw data(null, { status: 404 });
  const slug = params.owner.toLowerCase();
  const project = `${slug}/${params.repo.toLowerCase()}`;
  const url = new URL(request.url);
  const filters = readFilters(url, project);
  const report = billing
    .usageReport(slug, viewer, { from: filters.from, until: filters.until, products: filters.products, projects: [project] })
    .then((result) => (result.ok ? { report: result.value, error: null } : { report: null, error: result.error.message }));
  return { slug, project, owner: role === "owner", filters, url: url.toString(), report };
}

export default function ProjectUsage({ loaderData }: Route.ComponentProps) {
  const { slug, project, owner, filters, url, report } = loaderData;
  return (
    <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6">
      <h1 className="mb-4 text-lg font-semibold tracking-tight">Usage</h1>
      <Suspense
        fallback={
          <UsageSkeleton>
            <UsageFilterBar filters={filters} products={[...PRODUCTS]} projects={[]} report={null} apiHref={USAGE_API} fixedProject={project} />
          </UsageSkeleton>
        }
      >
        <Await resolve={report}>
          {(loaded) => (
            <UsageView slug={slug} owner={owner} filters={filters} url={url} report={loaded.report} error={loaded.error} fixedProject={project} />
          )}
        </Await>
      </Suspense>
    </div>
  );
}
