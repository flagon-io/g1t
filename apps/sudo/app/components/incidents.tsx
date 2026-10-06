/**
 * The Incidents pages' small parts: chips, a page's back link, the
 * timers strip and the component impact picker. Forms only: sudo ships
 * no JavaScript.
 */
import { ArrowLeft } from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "react-router";

import type { AdminIncident, ComponentImpact, IncidentSeverity, MaintenanceState } from "@g1t/contracts";

import { Badge, Select } from "~/components/ui";
import {
  COMPONENT_IMPACTS,
  IMPACT_TONE,
  MAINTENANCE_TONE,
  MAINTENANCE_WORD,
  SEVERITY_TONE,
  impactLabel,
  phase,
  severityLabel,
} from "~/lib/incidents";

export function SeverityBadge({ severity }: { severity: IncidentSeverity }) {
  return <Badge tone={SEVERITY_TONE[severity]}>{severityLabel(severity)}</Badge>;
}

export function PhaseBadge({ incident }: { incident: Pick<AdminIncident, "visibility" | "status" | "postmortem_published_at"> }) {
  const { label, tone } = phase(incident);
  return <Badge tone={tone}>{label}</Badge>;
}

export function ImpactBadge({ impact }: { impact: ComponentImpact }) {
  return <Badge tone={IMPACT_TONE[impact]}>{impactLabel(impact)}</Badge>;
}

export function MaintenanceBadge({ state }: { state: MaintenanceState }) {
  return <Badge tone={MAINTENANCE_TONE[state]}>{MAINTENANCE_WORD[state]}</Badge>;
}

export function BackLink({ to, children }: { to: string; children: ReactNode }) {
  return (
    <Link to={to} className="inline-flex items-center gap-1.5 text-xs text-muted underline-offset-4 hover:text-fg hover:underline">
      <ArrowLeft size={13} aria-hidden="true" />
      {children}
    </Link>
  );
}

/** One timer: a label, a figure, and a line under it. */
export function Timer({ label, value, hint, tone }: { label: string; value: ReactNode; hint?: ReactNode; tone?: "danger" | "warn" | "mint" }) {
  const color = tone === "danger" ? "text-danger" : tone === "warn" ? "text-warn" : tone === "mint" ? "text-accent" : "text-fg";
  return (
    <div className="min-w-0 px-4 py-3">
      <p className="text-xs text-muted">{label}</p>
      <p className={`tabular mt-0.5 text-base font-semibold tracking-tight ${color}`}>{value}</p>
      {hint && <p className="mt-0.5 truncate text-xs text-faint">{hint}</p>}
    </div>
  );
}

/**
 * A row per part with a select of impacts. `blank` adds a first choice
 * that leaves the part as it is (for updates); without it, every part
 * starts operational (for declaring).
 */
export function ImpactPicker({
  components,
  current,
  blank,
}: {
  components: { key: string; name: string }[];
  current: Map<string, ComponentImpact>;
  blank?: boolean;
}) {
  return (
    <div className="divide-y divide-line rounded-md border border-line">
      {components.map((c) => {
        const now = current.get(c.key) ?? "operational";
        return (
          <label key={c.key} className="flex items-center gap-3 px-3 py-1.5">
            <span className="min-w-0 grow text-sm">
              <span className="block truncate">{c.name}</span>
              {blank && now !== "operational" && <span className="block text-xs text-faint">now {impactLabel(now).toLowerCase()}</span>}
            </span>
            <span className="block w-40 shrink-0 sm:w-48">
              <Select name={`impact.${c.key}`} defaultValue={blank ? "" : now} aria-label={`${c.name}: impact`} className="py-1 text-xs">
                {blank && <option value="">No change</option>}
                {COMPONENT_IMPACTS.map((i) => (
                  <option key={i.value} value={i.value}>
                    {i.label}
                  </option>
                ))}
              </Select>
            </span>
          </label>
        );
      })}
    </div>
  );
}
