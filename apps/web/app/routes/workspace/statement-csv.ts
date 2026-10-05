import { MICROS_PER_DOLLAR, type LedgerEntry } from "@g1t/contracts";
import { data } from "react-router";

import type { Route } from "./+types/statement-csv";
import { billing } from "../../lib/services.server";
import { getViewer } from "../../lib/session.server";

/** Pages read per line at most: 50 entries each. */
const MAX_PAGES = 200;

/** A month's statement as CSV: every entry, with the line it falls under. */
export async function loader({ params, context, request }: Route.LoaderArgs) {
  const viewer = getViewer(context);
  const month = new URL(request.url).searchParams.get("month");
  const statement = await billing.statement(params.owner, viewer, month, "day");
  if (!statement.ok) throw data(null, { status: 404 });
  const kinds = [...new Set(statement.value.groups.flatMap((group) => group.lines.map((line) => line.kind)))];
  const rows: string[][] = [
    [
      "date",
      "kind",
      "description",
      "project",
      "pull request",
      "model",
      "by",
      "amount (USD)",
      "paid by Team credit (USD)",
      "paid by trial credit (USD)",
      "paid by open-source pool (USD)",
    ],
  ];
  for (const kind of kinds) {
    let before: string | null = null;
    for (let page = 0; page < MAX_PAGES; page++) {
      const entries = await billing.statementEntries(params.owner, viewer, {
        month: statement.value.month,
        kind,
        before,
      });
      if (!entries.ok || entries.value.length === 0) break;
      for (const entry of entries.value) rows.push(row(kind, entry));
      before = entries.value[entries.value.length - 1].id;
      if (entries.value.length < 50) break;
    }
  }
  const body = [rows[0], ...rows.slice(1).sort((a, b) => a[0].localeCompare(b[0]))].map((r) => r.map(cell).join(",")).join("\r\n");
  return new Response(`${body}\r\n`, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="g1t-${params.owner.toLowerCase()}-${statement.value.month}.csv"`,
      "cache-control": "no-store",
    },
  });
}

function row(kind: string, entry: LedgerEntry): string[] {
  return [
    entry.createdAt,
    kind,
    entry.description,
    entry.repo ?? "",
    entry.number ? String(entry.number) : "",
    entry.model ?? "",
    entry.createdBy ?? "",
    // Charges positive, as on the statement.
    (-entry.amountMicros / MICROS_PER_DOLLAR).toFixed(6),
    ((entry.creditMicros ?? 0) / MICROS_PER_DOLLAR).toFixed(6),
    ((entry.trialMicros ?? 0) / MICROS_PER_DOLLAR).toFixed(6),
    ((entry.ossMicros ?? 0) / MICROS_PER_DOLLAR).toFixed(6),
  ];
}

/** A CSV cell, quoted when it must be, and never read as a formula. */
function cell(value: string): string {
  const safe = /^[=+\-@\t\r]/.test(value) && !/^-?\d/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}
