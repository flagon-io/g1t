import { useEffect } from "react";
import { Link, useRevalidator } from "react-router";

import type { Route } from "./+types/status";
import { TrustPage } from "../components/trust-page";
import { StatusDot } from "../components/footer";
import { TimeAgo } from "../components/ui";
import { CONTACT } from "../lib/legal";
import { page } from "../lib/meta";
import { type ComponentStatus, INCIDENT_DAYS, type Incident, STATE_LABEL, dotClass } from "../lib/status";
import { currentStatus } from "../lib/status.server";

export function meta({ loaderData, ...args }: Route.MetaArgs) {
  return page(args, {
    title: "Status · g1t",
    description: loaderData
      ? `${loaderData.overall.line}. Live status of g1t: the website, API, git, MCP, docs, deployments, agents and billing.`
      : "Live status of g1t: the website, API, git, MCP, docs, deployments, agents and billing.",
  });
}

export async function loader() {
  return currentStatus();
}

/** How often an open page checks again: as often as the checks run. */
const REFRESH_MS = 60_000;

const BANNER: Record<string, string> = {
  up: "border-accent/30 bg-accent/5",
  degraded: "border-warn/40 bg-warn/5",
  down: "border-danger/40 bg-danger/5",
  unknown: "border-line bg-surface",
};

const STATE_TEXT: Record<ComponentStatus["state"], string> = {
  up: "text-accent",
  degraded: "text-warn",
  down: "text-danger",
  unmonitored: "text-faint",
};

function ComponentRow({ component }: { component: ComponentStatus }) {
  return (
    <li className="flex flex-col gap-2 px-4 py-4 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
      <div className="min-w-0">
        <p className="flex flex-wrap items-center gap-x-2 font-medium">
          <span aria-hidden className={`size-2 shrink-0 rounded-full ${dotClass(component.state)}`} />
          {component.name}
          {/* Beside the name when there's room, under it on a phone. */}
          <span className="w-full truncate pl-4 font-mono text-xs font-normal text-faint sm:w-auto sm:pl-0">
            {component.address}
          </span>
        </p>
        <p className="mt-1 pl-4 text-sm text-muted">{component.checks}</p>
      </div>
      <div className="shrink-0 pl-4 sm:pl-0 sm:text-right">
        <p className={`text-sm font-medium ${STATE_TEXT[component.state]}`}>{STATE_LABEL[component.state]}</p>
        {component.state !== "unmonitored" && <p className="text-xs text-faint">{component.detail}</p>}
      </div>
    </li>
  );
}

function IncidentItem({ incident }: { incident: Incident }) {
  const open = incident.resolved_at == null;
  return (
    <li className="px-4 py-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <p className="font-medium">{incident.title}</p>
        <p className={`text-xs font-medium ${open ? (incident.impact === "down" ? "text-danger" : "text-warn") : "text-faint"}`}>
          {open ? "Ongoing" : "Resolved"}
        </p>
      </div>
      <p className="mt-0.5 text-xs text-faint">
        Started <TimeAgo at={incident.started_at} />
        {incident.resolved_at && (
          <>
            {" "}· resolved <TimeAgo at={incident.resolved_at} />
          </>
        )}
      </p>
      {incident.updates.length > 0 && (
        <ol className="mt-3 space-y-2 border-l border-line pl-4 text-sm">
          {incident.updates.map((update) => (
            <li key={update.at}>
              <span className="text-faint">
                <TimeAgo at={update.at} />:
              </span>{" "}
              <span className="text-fg/90">{update.text}</span>
            </li>
          ))}
        </ol>
      )}
    </li>
  );
}

export default function Status({ loaderData }: Route.ComponentProps) {
  const { overall, components, incidents, checked_at } = loaderData;
  const revalidator = useRevalidator();
  // Keep an open page current, without the visitor reloading it.
  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState === "visible" && revalidator.state === "idle") revalidator.revalidate();
    }, REFRESH_MS);
    return () => clearInterval(timer);
  }, [revalidator]);
  const monitored = components.filter((c) => c.state !== "unmonitored").length;
  return (
    <TrustPage eyebrow="Status" title="g1t status">
      <div className="max-w-3xl">
        <div className={`flex items-start gap-3 rounded-xl border px-5 py-4 ${BANNER[overall.state]}`}>
          <StatusDot state={overall.state} className="mt-2" />
          <div className="min-w-0">
            <p className="text-lg font-semibold tracking-tight">{overall.line}</p>
            <p className="mt-0.5 text-sm text-muted">
              {monitored} of {components.length} parts checked, last <TimeAgo at={checked_at} />. Checked again every minute.
            </p>
          </div>
        </div>

        <ul className="mt-8 divide-y divide-line rounded-xl border border-line">
          {components.map((component) => (
            <ComponentRow key={component.key} component={component} />
          ))}
        </ul>
        <p className="mt-3 text-xs text-faint">
          Each check is one quick request, the same a visitor's would make, from g1t's own servers. A part that
          answers in over 1.5 seconds shows as degraded; one that fails or takes over 3 seconds, as down. Parts we
          can't check yet say so, rather than showing green. The same data is at{" "}
          <a href="/status.json" className="font-mono hover:text-fg">
            /status.json
          </a>
          .
        </p>

        <section className="mt-14">
          <h2 className="text-xl font-semibold tracking-tight">Incidents</h2>
          {incidents.length === 0 ? (
            <p className="mt-3 text-sm text-muted">No incidents reported in the last {INCIDENT_DAYS} days.</p>
          ) : (
            <ul className="mt-4 divide-y divide-line rounded-xl border border-line">
              {incidents.map((incident) => (
                <IncidentItem key={incident.id} incident={incident} />
              ))}
            </ul>
          )}
          <p className="mt-4 text-sm text-muted">
            Something broken that this page doesn't show? Tell us at{" "}
            <a href={`mailto:${CONTACT.support}`} className="text-accent hover:underline">
              {CONTACT.support}
            </a>
            , or see <Link to="/support" className="text-accent hover:underline">support</Link>.
          </p>
        </section>
      </div>
    </TrustPage>
  );
}
