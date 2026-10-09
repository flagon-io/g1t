import type { ProviderKind } from "@g1t/contracts";

/**
 * The workspace's integration setup pages, under `-/integrations/<section>`:
 * one for each kind of provider connection. The directory at
 * `-/integrations` links into them.
 */
export type IntegrationsSection = "models" | "alerts" | "trackers";

const SECTIONS: Record<ProviderKind, IntegrationsSection> = {
  models: "models",
  alerts: "alerts",
  tracker: "trackers",
};

/** The page a kind of provider is set up on. */
export function integrationsSection(kind: ProviderKind): IntegrationsSection {
  return SECTIONS[kind];
}

/** The kind of provider a section's page is for, or null when it is no section. */
export function sectionKind(section: string | undefined): ProviderKind | null {
  const found = (Object.keys(SECTIONS) as ProviderKind[]).find((kind) => SECTIONS[kind] === section);
  return found ?? null;
}
