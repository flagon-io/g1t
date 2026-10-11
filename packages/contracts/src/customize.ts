/**
 * Customize: one place for what shapes how a workspace's agents work, in
 * three parts. It is the Marketplace's successor, and what the phone app
 * shows today; the site moves to it in its own change.
 *
 * - **Skills**: what agents know how to do, in the open SKILL.md format
 *   (./skill-library.ts): the foundational skills every agent has, and the
 *   workspace's library.
 * - **Connectors**: what agents can reach: the tools a team already uses
 *   (./connectors.ts). Today's Marketplace integrations.
 * - **Plugins**: what adds pages, cards, tools and agent roles to the
 *   workspace (./marketplace.ts's `ExtensionManifest`). Today's
 *   Marketplace extensions.
 *
 * A Marketplace listing (`integration:<id>`, `extension:<id>`) keeps its
 * reference; {@link sectionOfListing} says which part shows it. No imports
 * beyond types, so it runs anywhere: services, the site, the phone.
 */

import type { ListingKind } from "./marketplace";

export type CustomizeSection = "skills" | "connectors" | "plugins";

export const CUSTOMIZE_SECTIONS: readonly CustomizeSection[] = ["skills", "connectors", "plugins"];

export type CustomizeSectionInfo = {
  id: CustomizeSection;
  title: string;
  /** One line, for the section's row. */
  description: string;
  /** Where the site manages it today, with `:workspace` to fill in. */
  sitePath: string;
};

export const CUSTOMIZE: Record<CustomizeSection, CustomizeSectionInfo> = {
  skills: {
    id: "skills",
    title: "Skills",
    description: "What agents know how to do: the skills every agent has, and your workspace's library.",
    sitePath: "/:workspace/-/agents/skills",
  },
  connectors: {
    id: "connectors",
    title: "Connectors",
    description: "The tools your team already uses, connected so agents can work with their data.",
    sitePath: "/:workspace/-/marketplace/integrations",
  },
  plugins: {
    id: "plugins",
    title: "Plugins",
    description: "Pages, cards, tools and agent roles for what your team does besides code.",
    sitePath: "/:workspace/-/marketplace/extensions",
  },
};

/** The part of Customize that shows a Marketplace listing of this kind. */
export function sectionOfListing(kind: ListingKind): CustomizeSection {
  return kind === "integration" ? "connectors" : "plugins";
}

/** A section's site path with its workspace filled in. */
export function customizePath(section: CustomizeSection, workspace: string): string {
  return CUSTOMIZE[section].sitePath.replace(/:workspace\b/g, encodeURIComponent(workspace));
}
