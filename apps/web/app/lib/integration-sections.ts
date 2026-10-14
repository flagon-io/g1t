import type { ProviderKind } from "@g1t/contracts";

/**
 * Where each kind of integration is set up: alerts and trackers have setup
 * pages under `-/integrations/<section>`, which the directory at
 * `-/integrations` links into. AI providers are not integrations: they are
 * the workspace's own AI settings, at `-/ai`.
 */
export type IntegrationsSection = "alerts" | "trackers";

const SECTIONS: Record<ProviderKind, IntegrationsSection> = {
  alerts: "alerts",
  tracker: "trackers",
};

/** The page, under `-/`, a kind of integration is set up on. */
export function providerPage(kind: ProviderKind): string {
  return `integrations/${SECTIONS[kind]}`;
}

/** The kind of integration a section's page is for, or null when it is no section. */
export function sectionKind(section: string | undefined): ProviderKind | null {
  const found = (Object.keys(SECTIONS) as ProviderKind[]).find((kind) => SECTIONS[kind] === section);
  return found ?? null;
}

/**
 * Where an older link to the AI providers' page (`-/integrations/models`,
 * or the directory's `?add=anthropic`) leads now: the workspace's AI page,
 * keeping the query, and opening the form when it names a provider. Such
 * links are out in the wild, so they keep working.
 */
export function aiPagePath(slug: string, search: string): string {
  const query = new URLSearchParams(search);
  query.delete("_routes");
  const rest = query.toString();
  return `/${slug}/-/ai${rest ? `?${rest}` : ""}${query.has("add") ? "#add" : ""}`;
}
