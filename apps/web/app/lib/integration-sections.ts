import type { ProviderKind } from "@g1t/contracts";

/**
 * The workspace's integration setup pages, under `-/integrations/<section>`:
 * one for each kind of provider connection. The directory at
 * `-/integrations` links into them. Model providers have no page: they
 * were for g1t's own agents, which are gone.
 */
export type IntegrationsSection = "alerts" | "trackers";

/** The kinds of provider that have a setup page. */
export type SectionKind = Exclude<ProviderKind, "models">;

const SECTIONS: Record<SectionKind, IntegrationsSection> = {
  alerts: "alerts",
  tracker: "trackers",
};

/** Whether a kind of provider has a setup page. */
export function hasSection(kind: ProviderKind): kind is SectionKind {
  return kind in SECTIONS;
}

/** The page a kind of provider is set up on, or null when it has none. */
export function integrationsSection(kind: ProviderKind): IntegrationsSection | null {
  return hasSection(kind) ? SECTIONS[kind] : null;
}

/** The kind of provider a section's page is for, or null when it is no section. */
export function sectionKind(section: string | undefined): SectionKind | null {
  const found = (Object.keys(SECTIONS) as SectionKind[]).find((kind) => SECTIONS[kind] === section);
  return found ?? null;
}
