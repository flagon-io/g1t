import { pluginRef } from "@g1t/contracts/claude-plugin";
import { connectorPath, connectorsFor } from "@g1t/contracts/connectors";
import { CUSTOMIZE, type CustomizeSection, customizePath } from "@g1t/contracts/customize";
import { FIRST_PARTY_EXTENSIONS } from "@g1t/contracts/marketplace";
import { FOUNDATIONAL_SKILLS } from "@g1t/contracts/skills";

/**
 * Customize on the phone: Skills, Connectors and Plugins
 * (packages/contracts/src/customize.ts). What is listed comes from the
 * catalogs every g1t ships with; a workspace's own library, connections
 * and installs are read on the site for now, and added here once the API
 * serves them. Every item opens where the site shows it: a connector on
 * Connectors' Discover (an MCP server on its connect page), g1t's own
 * announced plugins on their pages in the `g1t` marketplace.
 */

export type CustomizeItem = {
  id: string;
  name: string;
  description: string;
  /** Available, Soon, or what else a listing says about itself. */
  status: "available" | "soon" | "built-in";
  /** A group to list it under. */
  group: string;
  /** The site page that sets it up, for this workspace. */
  sitePath: string;
};

export function customizeItems(section: CustomizeSection, workspace: string): CustomizeItem[] {
  const fallback = customizePath(section, workspace);
  if (section === "skills") {
    return FOUNDATIONAL_SKILLS.map((skill) => ({
      id: skill.id,
      name: skill.name,
      description: skill.description,
      status: "built-in" as const,
      group: "In every agent",
      sitePath: fallback,
    }));
  }
  if (section === "connectors") {
    return connectorsFor("workspace").map((connector) => ({
      id: connector.id,
      name: connector.name,
      description: connector.description,
      status: connector.status,
      group: connector.status === "available" ? "Connect now" : "Coming",
      sitePath: connector.href ? connectorPath(connector.href, workspace) : `${fallback}?view=discover&directory=${encodeURIComponent(connector.id)}`,
    }));
  }
  return FIRST_PARTY_EXTENSIONS.map((extension) => ({
    id: extension.id,
    name: extension.name,
    description: extension.tagline,
    status: extension.status,
    group: `${extension.publisher.name} · ${extension.category}`,
    sitePath: customizePath("plugins", workspace, encodeURIComponent(pluginRef(extension.id, "g1t"))),
  }));
}

export { CUSTOMIZE, customizePath, type CustomizeSection };
