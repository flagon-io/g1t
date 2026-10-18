import type { DeliveryMetrics, UsageReport } from "@g1t/contracts";

export function deliveryTotals(rows: DeliveryMetrics[]) {
  return rows.reduce(
    (total, row) => ({
      opened: total.opened + row.opened,
      merged: total.merged + row.merged,
      active: total.active + row.active,
      unreviewed: total.unreviewed + row.unreviewed,
      queued: total.queued + row.queued,
      checking: total.checking + row.checking,
      failed: total.failed + row.failed,
      leadSeconds: total.leadSeconds + row.leadSeconds,
      reviewSeconds: total.reviewSeconds + row.reviewSeconds,
      reviewed: total.reviewed + row.reviewed,
    }),
    { opened: 0, merged: 0, active: 0, unreviewed: 0, queued: 0, checking: 0, failed: 0, leadSeconds: 0, reviewSeconds: 0, reviewed: 0 },
  );
}

/** How billing names a project's usage: its repository, `owner/name`, as Usage filters it. */
export function usageKey(repo: { namespace: string; name: string }): string {
  return `${repo.namespace}/${repo.name}`.toLowerCase();
}

export function projectCosts(report: UsageReport | null): Map<string, number> {
  const costs = new Map<string, number>();
  for (const product of report?.products ?? [])
    for (const meter of product.meters) {
      for (const row of meter.byProject) costs.set(row.project, (costs.get(row.project) ?? 0) + row.micros);
    }
  return costs;
}

export function duration(seconds: number | null): string {
  if (seconds == null || !Number.isFinite(seconds)) return "—";
  if (seconds < 60) return "<1m";
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86400) return `${(seconds / 3600).toFixed(1)}h`;
  return `${(seconds / 86400).toFixed(1)}d`;
}

/** Merge service batches and fill quiet UTC days so gaps never disappear. */
export function deliveryDays(from: string, until: string, rows: { day: string; merged: number }[]) {
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(row.day, (counts.get(row.day) ?? 0) + row.merged);
  const days = [];
  for (let at = Date.parse(`${from}T00:00:00Z`); at <= Date.parse(`${until}T00:00:00Z`); at += 86_400_000) {
    const day = new Date(at).toISOString().slice(0, 10);
    days.push({ day, merged: counts.get(day) ?? 0 });
  }
  return days;
}
