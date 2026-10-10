/**
 * The templates g1t ships for folios. Docs' page templates
 * (src/templates.ts) are the doc kind's, as they are; each later kind
 * adds its own here (slides in Phase 4, dashboards in 5b, designs in 6b).
 * A workspace's own are in `folio_templates`. Pure.
 */
import type { FolioKind, FolioTemplate } from "@g1t/contracts";

import { BUILTIN_TEMPLATES } from "../templates.ts";

/** Built-in ids are `builtin:<kind>:<slug>`; a doc's old `builtin:<slug>` is still found. */
export const BUILTIN_FOLIO_TEMPLATES: FolioTemplate[] = BUILTIN_TEMPLATES.map((t) => ({
  id: `builtin:doc:${t.id.replace(/^builtin:/, "")}`,
  kind: "doc" as const,
  name: t.name,
  description: t.description,
  icon: t.icon,
  builtin: true,
  body: t.markdown,
  created_by: null,
}));

export function builtinFolioTemplate(id: string): FolioTemplate | null {
  const wanted = String(id ?? "");
  return BUILTIN_FOLIO_TEMPLATES.find((t) => t.id === wanted || t.id === `builtin:doc:${wanted.replace(/^builtin:/, "")}`) ?? null;
}

export function builtinFolioTemplates(kind?: FolioKind | null): FolioTemplate[] {
  return kind ? BUILTIN_FOLIO_TEMPLATES.filter((t) => t.kind === kind) : BUILTIN_FOLIO_TEMPLATES;
}
