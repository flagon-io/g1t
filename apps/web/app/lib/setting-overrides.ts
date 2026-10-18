import type { Setting } from "@g1t/contracts";

/** Project keys suppress workspace values per kind and reader, even when
 * none of the project's rows applies to the requested environment. */
export function settingOverride(row: Setting, rows: Setting[]): string | null {
  const others = rows.filter((other) => other.scope !== row.scope && other.name === row.name && other.kind === row.kind);
  const readers = row.availableTo.filter((reader) => others.some((other) => other.availableTo.includes(reader)));
  if (readers.length === 0) return null;
  const labels = readers.map((reader) => (reader === "workflows" ? "Workflows" : reader === "deployments" ? "Deployments" : reader)).join(", ");
  if (row.scope === "project") return `Overrides workspace: ${labels}`;
  return readers.length === row.availableTo.length ? "Overridden by project" : `Partially overridden: ${labels}`;
}
