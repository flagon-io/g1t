import { CalendarClock, ChevronRight, ExternalLink, Mail, Siren } from "lucide-react";
import { Link } from "react-router";

import type { AdminIncident, AdminMaintenance } from "@g1t/contracts";

import type { Route } from "./+types/incidents";
import { ImpactBadge, MaintenanceBadge, PhaseBadge, SeverityBadge } from "~/components/incidents";
import { Button, ButtonLink, EmptyState, Input, Notice, PageHeader, Select, Stat, When } from "~/components/ui";
import {
  INCIDENT_SEVERITIES,
  TABS,
  duration,
  filterIncidents,
  incidentsHref,
  maintenanceList,
  median,
  parseFilters,
  secondsBetween,
  tabCounts,
} from "~/lib/incidents";
import { statusAdmin } from "~/lib/services.server";
import { settle } from "~/lib/settle";
import { requireStaff } from "~/lib/staff";

export const meta: Route.MetaFunction = () => [{ title: "Incidents · sudo" }, { name: "robots", content: "noindex, nofollow" }];

const STATUS_PAGE = "https://status.g1t.sh/";

export async function loader({ request, context }: Route.LoaderArgs) {
  requireStaff(context);
  const filters = parseFilters(new URL(request.url).searchParams);
  const [board, components] = await Promise.all([settle(statusAdmin.board()), settle(statusAdmin.components())]);
  return {
    filters,
    board: board.ok ? board.value : null,
    components: components.ok ? components.value : [],
    error: board.ok ? null : board.error,
    now: new Date().toISOString(),
  };
}

function IncidentRow({ incident, names, now }: { incident: AdminIncident; names: Map<string, string>; now: string }) {
  const affected = incident.components.filter((c) => c.impact !== "operational");
  const open = incident.resolved_at == null;
  return (
    <li>
      <Link
        to={`/incidents/${incident.id}`}
        className="group flex flex-col gap-2 px-4 py-3.5 hover:bg-raised/40 sm:flex-row sm:items-start sm:gap-4 sm:px-5"
      >
        <div className="flex shrink-0 items-center gap-2 sm:w-20 sm:pt-0.5">
          <SeverityBadge severity={incident.severity} />
        </div>
        <div className="min-w-0 grow">
          <div className="flex flex-wrap items-center gap-2">
            <p className="font-medium group-hover:text-fg">{incident.title}</p>
            <PhaseBadge incident={incident} />
            {incident.source === "detected" && <span className="text-xs text-faint">Detected by the checks</span>}
          </div>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {affected.map((c) => (
              <span key={c.key} className="inline-flex items-center gap-1.5 text-xs text-muted">
                {names.get(c.key) ?? c.key} <ImpactBadge impact={c.impact} />
              </span>
            ))}
          </div>
          <p className="mt-1.5 text-xs text-faint">
            Started <When at={incident.started_at} time />
            {incident.commander && (
              <>
                {" "}· IC <span className="font-mono">{incident.commander}</span>
              </>
            )}
            {incident.followups_open + incident.followups_done > 0 && (
              <>
                {" "}· follow-ups {incident.followups_done}/{incident.followups_open + incident.followups_done}
              </>
            )}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-3 text-right sm:block">
          <p className={`tabular text-sm font-medium ${open ? "text-warn" : "text-fg-soft"}`}>
            {open ? duration(secondsBetween(incident.started_at, now)) : duration(incident.durations.to_resolve)}
          </p>
          <p className="text-xs text-faint">{open ? "open" : incident.visibility === "dismissed" ? "dismissed" : "to resolve"}</p>
        </div>
        <ChevronRight size={16} aria-hidden="true" className="hidden shrink-0 self-center text-faint group-hover:text-muted sm:block" />
      </Link>
    </li>
  );
}

function MaintenanceRow({ m, names }: { m: AdminMaintenance; names: Map<string, string> }) {
  return (
    <li>
      <Link
        to={`/incidents/maintenance/${m.id}`}
        className="group flex flex-col gap-2 px-4 py-3.5 hover:bg-raised/40 sm:flex-row sm:items-start sm:gap-4 sm:px-5"
      >
        <CalendarClock size={16} aria-hidden="true" className="hidden shrink-0 text-faint sm:mt-0.5 sm:block" />
        <div className="min-w-0 grow">
          <div className="flex flex-wrap items-center gap-2">
            <p className="font-medium">{m.title}</p>
            <MaintenanceBadge state={m.state} />
          </div>
          <p className="mt-1 text-xs text-muted">{m.components.map((k) => names.get(k) ?? k).join(", ")}</p>
          <p className="mt-1 text-xs text-faint">
            <When at={m.starts_at} time /> to <When at={m.ends_at} time /> · {duration(secondsBetween(m.starts_at, m.ends_at))}
          </p>
        </div>
        <ChevronRight size={16} aria-hidden="true" className="hidden shrink-0 self-center text-faint group-hover:text-muted sm:block" />
      </Link>
    </li>
  );
}

export default function Incidents({ loaderData }: Route.ComponentProps) {
  const { filters, board, components, error, now } = loaderData;
  const names = new Map(components.map((c) => [c.key, c.name]));
  const incidents = board?.incidents ?? [];
  const maintenance = board?.maintenance ?? [];
  const counts = tabCounts(incidents, maintenance);
  const shown = filterIncidents(incidents, filters);
  const shownMaintenance = maintenanceList(maintenance, filters.component);
  const recent = incidents.filter((i) => i.visibility === "public" && i.resolved_at && secondsBetween(i.resolved_at, now) < 90 * 86400);
  const filtered = filters.severity != null || filters.component != null || filters.q !== "";

  return (
    <main className="mx-auto max-w-6xl px-4 py-8 sm:py-10">
      <PageHeader
        title="Incidents"
        description="Declare, run and close incidents, schedule maintenance, and publish postmortems. What is public appears on status.g1t.sh within 30 seconds."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <ButtonLink to="/incidents/new" variant="lavender">
              <Siren size={15} aria-hidden="true" />
              Declare incident
            </ButtonLink>
            <ButtonLink to="/incidents/maintenance/new" variant="quiet">
              <CalendarClock size={15} aria-hidden="true" />
              Schedule maintenance
            </ButtonLink>
            <a
              href={STATUS_PAGE}
              className="inline-flex items-center gap-1.5 rounded-md px-2 py-2 text-sm text-muted hover:text-fg"
            >
              status.g1t.sh <ExternalLink size={13} aria-hidden="true" />
            </a>
          </div>
        }
      />

      {error && (
        <div className="mt-5">
          <Notice tone="warn">The status worker did not answer: {error}</Notice>
        </div>
      )}

      <div className="mt-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Open" value={counts.open} tone={counts.open ? "danger" : "mint"} hint={counts.drafts ? `${counts.drafts} draft${counts.drafts === 1 ? "" : "s"} waiting` : "No drafts waiting"} />
        <Stat label="Maintenance ahead" value={counts.maintenance} hint="Scheduled or under way" />
        <Stat
          label="Median time to resolve"
          value={duration(median(recent.map((i) => i.durations.to_resolve)))}
          hint={`${recent.length} public incident${recent.length === 1 ? "" : "s"}, 90 days`}
        />
        <Stat
          label="Email subscribers"
          value={board?.subscribers ?? "—"}
          hint={board && !board.email ? "Email is off: feeds only" : "Confirmed addresses"}
        />
      </div>

      <nav aria-label="Incident lists" className="mt-6 flex gap-1 overflow-x-auto border-b border-line">
        {TABS.map((tab) => {
          const current = filters.tab === tab.value;
          return (
            <Link
              key={tab.value}
              to={incidentsHref({ ...filters, tab: tab.value })}
              aria-current={current ? "page" : undefined}
              className={`-mb-px flex shrink-0 items-center gap-2 border-b-2 px-3 py-2 text-sm whitespace-nowrap ${
                current ? "border-merged font-medium text-fg" : "border-transparent text-muted hover:text-fg"
              }`}
            >
              {tab.label}
              <span className={`tabular rounded-full px-1.5 text-xs ${counts[tab.value] && tab.value !== "resolved" ? "bg-merged/15 text-merged" : "text-faint"}`}>
                {counts[tab.value]}
              </span>
            </Link>
          );
        })}
      </nav>

      <form method="get" action="/incidents" className="mt-4 flex flex-col gap-2 sm:flex-row sm:items-center">
        {filters.tab !== "open" && <input type="hidden" name="tab" value={filters.tab} />}
        <Input name="q" type="search" defaultValue={filters.q} placeholder="Search titles" aria-label="Search titles" className="sm:w-64" />
        {filters.tab !== "maintenance" && (
          <Select name="severity" defaultValue={filters.severity ?? ""} aria-label="Severity" className="sm:w-40">
            <option value="">Any severity</option>
            {INCIDENT_SEVERITIES.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </Select>
        )}
        <Select name="component" defaultValue={filters.component ?? ""} aria-label="Part" className="sm:w-56">
          <option value="">Any part</option>
          {components.map((c) => (
            <option key={c.key} value={c.key}>
              {c.name}
            </option>
          ))}
        </Select>
        <div className="flex items-center gap-2">
          <Button type="submit" variant="quiet" className="py-2">
            Apply
          </Button>
          {filtered && (
            <Link to={incidentsHref({ tab: filters.tab })} className="px-1 text-xs text-muted underline-offset-4 hover:text-fg hover:underline">
              Clear
            </Link>
          )}
        </div>
      </form>

      <div className="mt-4">
        {filters.tab === "maintenance" ? (
          shownMaintenance.length === 0 ? (
            <EmptyState title="No maintenance scheduled">
              <Link to="/incidents/maintenance/new" className="text-merged hover:underline">
                Schedule maintenance
              </Link>{" "}
              to tell people ahead of planned work.
            </EmptyState>
          ) : (
            <ul className="divide-y divide-line rounded-lg border border-line bg-surface">
              {shownMaintenance.map((m) => (
                <MaintenanceRow key={m.id} m={m} names={names} />
              ))}
            </ul>
          )
        ) : shown.length === 0 ? (
          <EmptyState
            title={
              filtered
                ? "Nothing matches"
                : filters.tab === "open"
                  ? "Nothing is open"
                  : filters.tab === "drafts"
                    ? "No drafts"
                    : "No resolved incidents in the last 180 days"
            }
          >
            {filtered
              ? "Try another severity or part, or clear the filters."
              : filters.tab === "open"
                ? "The status page shows only its own checks."
                : filters.tab === "drafts"
                  ? "When a part fails three checks in a row, a draft appears here and the alert address gets an email."
                  : null}
          </EmptyState>
        ) : (
          <ul className="divide-y divide-line rounded-lg border border-line bg-surface">
            {shown.map((incident) => (
              <IncidentRow key={incident.id} incident={incident} names={names} now={now} />
            ))}
          </ul>
        )}
      </div>

      {board && !board.email && (
        <p className="mt-4 flex items-center gap-2 text-xs text-faint">
          <Mail size={13} aria-hidden="true" />
          The status worker has no email sender or no STATUS_SECRET, so subscribers cannot sign up; the feeds still carry every update.
        </p>
      )}
    </main>
  );
}
