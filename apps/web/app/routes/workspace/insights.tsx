import { useRef } from "react";
import { Form, Link, data, useNavigation } from "react-router";
import type { DeliveryMetrics } from "@g1t/contracts";
import type { Route } from "./+types/insights";
import { ButtonLink } from "../../components/ui";
import { Alert } from "../../components/ui/alert";
import { Card } from "../../components/ui/card";
import { Hint } from "../../components/ui/hint";
import { SelectField } from "../../components/ui/select";
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from "../../components/ui/table";
import { page } from "../../lib/meta";
import { money } from "../../lib/money";
import { billing, work } from "../../lib/services.server";
import { getViewer, roleIn } from "../../lib/session.server";
import { workspaceProjects } from "../../lib/workspace-projects.server";
import { resolveRange } from "../../lib/usage";
import { deliveryDays, deliveryTotals, duration, projectCosts, usageKey } from "../../lib/workspace-insights";

export function meta({ params, ...args }: Route.MetaArgs) {
  return page(args, { title: `Insights · ${params.owner} · g1t` });
}

const PERIODS = [
  { value: "7d", label: "Last 7 days" },
  { value: "30d", label: "Last 30 days" },
  { value: "90d", label: "Last 90 days" },
];

export async function loader({ params, context, request }: Route.LoaderArgs) {
  const viewer = getViewer(context);
  const slug = params.owner.toLowerCase();
  if (!roleIn(viewer, slug)) throw data(null, { status: 404 });
  const query = new URL(request.url).searchParams;
  const period = PERIODS.some((p) => p.value === query.get("period")) ? query.get("period")! : "30d";
  const { from, until } = resolveRange(period, {});
  const listed = await workspaceProjects(slug, viewer);
  if (!listed.ok) throw data("Repositories could not be loaded. Please try again.", { status: 503 });
  const selected = query.get("project") ?? "";
  if (selected && !listed.value.some((p) => p.slug === selected)) throw data(null, { status: 404 });
  // Billing counts usage by repository (`owner/name`), as Usage filters it.
  const projects = listed.value
    .filter((p) => !selected || p.slug === selected)
    .map((p) => ({ slug: p.slug, name: p.name, repoId: p.source.repoId, usage: usageKey(p.source.repo) }));
  const ids = [...new Set(projects.map((p) => p.repoId))];
  const usageTask = billing.usageReport(slug, viewer, { from, until, projects: selected ? projects.map((p) => p.usage) : [] }).catch(() => null);
  // Bounded batches cover every project, without one RPC per repository.
  const batches = await Promise.allSettled(
    Array.from({ length: Math.ceil(ids.length / 100) }, (_, i) => work.deliveryInsights(ids.slice(i * 100, i * 100 + 100), viewer, from, until)),
  );
  const metrics: DeliveryMetrics[] = [];
  const days: { day: string; merged: number }[] = [];
  let checksUnavailable = false;
  for (const batch of batches) {
    if (batch.status !== "fulfilled") continue;
    metrics.push(...batch.value.projects);
    days.push(...batch.value.days);
    checksUnavailable ||= batch.value.checksUnavailable;
  }
  const usage = await usageTask;
  return {
    slug,
    period,
    from,
    until,
    selected,
    choices: listed.value.map((p) => ({ value: p.slug, label: p.name })),
    projects,
    metrics,
    days: deliveryDays(from, until, days),
    deliveryError: batches.some((b) => b.status === "rejected"),
    checksUnavailable,
    report: usage?.ok ? usage.value : null,
  };
}

/** Money, or a dash when there is no sum to show. */
const cost = (micros: number | null) => (micros == null ? "—" : money(micros));

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <Card className="p-4">
      <p className="text-xs text-muted">{label}</p>
      <p className="mt-2 text-2xl font-semibold tabular-nums">{value}</p>
    </Card>
  );
}

export default function Insights({ loaderData: d }: Route.ComponentProps) {
  const form = useRef<HTMLFormElement>(null);
  const submit = () => form.current?.requestSubmit();
  const pending = useNavigation().state !== "idle";
  const totals = deliveryTotals(d.metrics);
  const costs = projectCosts(d.report);
  const byId = new Map(d.metrics.map((m) => [m.repoId, m]));
  // A project whose repository the viewer cannot read is left out of the
  // totals (its row shows dashes); only a batch that failed hides them.
  const delivery = !d.deliveryError;
  const checks = delivery && !d.checksUnavailable;
  const price = d.report?.totals.priceMicros ?? null;
  const peak = Math.max(1, ...d.days.map((day) => day.merged));
  const selectedUsage = d.projects.find((p) => p.slug === d.selected)?.usage;
  const usageHref = `/${d.slug}/-/usage?period=${d.period}${selectedUsage ? `&project=${encodeURIComponent(selectedUsage)}` : ""}`;
  return (
    <div className="space-y-6" aria-busy={pending}>
      <Form ref={form} method="get" preventScrollReset className="flex flex-wrap items-center gap-2">
        <SelectField
          key={`period-${d.period}`}
          name="period"
          defaultValue={d.period}
          afterChange={submit}
          size="sm"
          className="w-auto"
          aria-label="Period"
          options={PERIODS}
        />
        <SelectField
          key={`project-${d.selected}`}
          name="project"
          defaultValue={d.selected}
          afterChange={submit}
          size="sm"
          className="w-auto max-w-64"
          aria-label="Repository"
          options={[{ value: "", label: "All repositories" }, ...d.choices]}
        />
        <ButtonLink to={usageHref} variant="link" size="inline" className="ml-auto text-sm">
          Explore costs →
        </ButtonLink>
      </Form>
      <p className="text-xs text-muted">
        {d.from} – {d.until}, inclusive, UTC.
      </p>
      {!delivery && (
        <Alert tone="warn" role="status">
          Delivery could not be read for some repositories, so its numbers are hidden. Reload the page to try again.
        </Alert>
      )}
      {delivery && d.checksUnavailable && (
        <Alert tone="warn" role="status">
          g1t Actions could not be read, so the checks waiting now are not shown. Reload the page to try again.
        </Alert>
      )}
      {!d.report && (
        <Alert tone="warn" role="status">
          Costs could not be read right now. Reload the page to try again.
        </Alert>
      )}
      {!d.projects.length ? (
        <Card className="p-8 text-center">
          <h2 className="font-medium">No repositories yet</h2>
          <p className="mt-2 text-sm text-muted">Delivery and cost insights will appear as your workspace starts working.</p>
          <ButtonLink to={`/new?workspace=${d.slug}`} variant="link" size="inline" className="mt-4">
            Create a repository
          </ButtonLink>
        </Card>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label="Merged changes" value={delivery ? totals.merged : "—"} />
            <Stat label="Average lead time" value={duration(delivery && totals.merged ? totals.leadSeconds / totals.merged : null)} />
            <Stat label="Usage at price" value={cost(price)} />
            <Stat label="Cost per merged change" value={cost(delivery && totals.merged && price != null ? price / totals.merged : null)} />
          </div>
          {delivery && (
            <section>
              <h2 className="mb-3 font-medium">Merged changes by day</h2>
              <Card className="p-4">
                <div
                  className="flex h-36 items-end gap-0.5"
                  role="img"
                  aria-label={`${totals.merged} changes merged from ${d.from} through ${d.until}. Daily values are in the table below.`}
                >
                  {d.days.map((day) => (
                    <Hint key={day.day} label={`${day.day}: ${day.merged} merged`}>
                      <div className="flex h-full min-w-0 flex-1 items-end">
                        <div className="w-full rounded-t bg-accent" style={{ height: `${day.merged ? Math.max(2, (day.merged / peak) * 100) : 0}%` }} />
                      </div>
                    </Hint>
                  ))}
                </div>
                <div className="mt-2 flex justify-between text-xs text-muted">
                  <span>{d.from}</span>
                  <span>{d.until}</span>
                </div>
                {!totals.merged && <p className="mt-3 text-sm text-muted">No changes merged in this period.</p>}
                <details className="mt-3 text-xs text-muted">
                  <summary className="cursor-pointer">View daily values</summary>
                  <Table className="mt-2 text-xs">
                    <TableHeader>
                      <TableRow>
                        <TableHead scope="col">UTC day</TableHead>
                        <TableHead scope="col">Merged</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {d.days.map((day) => (
                        <TableRow key={day.day}>
                          <TableHead scope="row" className="font-normal">
                            {day.day}
                          </TableHead>
                          <TableCell className="tabular-nums">{day.merged}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </details>
              </Card>
            </section>
          )}
          <section>
            <h2 className="mb-3 font-medium">Waiting now</h2>
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <Stat label="Awaiting a first review" value={delivery ? totals.unreviewed : "—"} />
              <Stat label="In the merge queue" value={delivery ? totals.queued : "—"} />
              <Stat label="Checks running" value={checks ? totals.checking : "—"} />
              <Stat label="Checks failed" value={checks ? totals.failed : "—"} />
            </div>
          </section>
          <section>
            <h2 className="mb-3 font-medium">By repository</h2>
            <Card className="overflow-hidden">
              <Table>
                <TableCaption className="sr-only">
                  Delivery and costs for {d.from} through {d.until}
                </TableCaption>
                <TableHeader>
                  <TableRow>
                    {["Repository", "Opened", "Merged", "Open now", "Avg. lead time", "Avg. first review", "Cost", "Cost / merge"].map((h) => (
                      <TableHead key={h} scope="col">
                        {h}
                      </TableHead>
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {d.projects.map((p) => {
                    const m = delivery ? byId.get(p.repoId) : undefined;
                    const spent = d.report ? (costs.get(p.usage) ?? 0) : null;
                    const cells = [
                      m?.opened ?? "—",
                      m?.merged ?? "—",
                      m?.active ?? "—",
                      duration(m?.merged ? m.leadSeconds / m.merged : null),
                      duration(m?.reviewed ? m.reviewSeconds / m.reviewed : null),
                      cost(spent),
                      cost(m?.merged && spent != null ? spent / m.merged : null),
                    ];
                    return (
                      <TableRow key={p.slug}>
                        <TableHead scope="row" className="text-fg">
                          <Link className="hover:text-accent" to={`/${d.slug}/${p.slug}/pulls`}>
                            {p.name}
                          </Link>
                        </TableHead>
                        {cells.map((v, i) => (
                          <TableCell key={i} className="whitespace-nowrap tabular-nums">
                            {v}
                          </TableCell>
                        ))}
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </Card>
          </section>
          {d.report && (
            <section>
              <h2 className="mb-3 font-medium">Cost by product</h2>
              <Card className="divide-y divide-line">
                {d.report.products.map((p) => (
                  <div key={p.key} className="flex justify-between px-4 py-3 text-sm">
                    <span>{p.label}</span>
                    <span className="tabular-nums">{money(p.micros)}</span>
                  </div>
                ))}
                {!d.report.products.length && <p className="p-4 text-sm text-muted">No usage in this period.</p>}
              </Card>
            </section>
          )}
          <p className="text-xs leading-relaxed text-muted">
            Lead time runs from a pull request’s opening to its merge, for those merged in this period. First review runs from opening to the first approval or
            request for changes by a person other than its owner (not g1t or a workspace agent), for first reviews given in this period. Waiting counts are as
            of now and may overlap. Checks count each open pull request once, by its latest commit’s statuses, check runs and g1t Actions jobs: failed if any
            failed, else running if any is still going. Costs are usage at price, before what the plan, credit or discounts paid; cost per merged change divides
            the period’s usage by its merges, not what each change cost. A dash means no sample, or no data to show.
          </p>
        </>
      )}
    </div>
  );
}
