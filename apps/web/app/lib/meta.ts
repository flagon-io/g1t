/**
 * Every page's <title> and the tags a link preview reads: its description,
 * Open Graph and Twitter's card. The image is the page's own card from the
 * og service (services/og), which draws it as an anonymous visitor would
 * see the page, so a private page's card never names anything. A g1t without
 * the og service (`OG_URL` set empty) leaves the image tags out.
 *
 * React Router renders only the deepest route's `meta`, so each route
 * returns `page(args, …)` rather than a bare title.
 */
import type { MetaDescriptor } from "react-router";
import { ogVersion } from "@g1t/contracts/og";

import type { Addresses } from "./addresses";

/**
 * g1t.sh's site and card service, the same as HOSTED_ADDRESSES in
 * ./addresses (kept here so this module has no imports to run in tests).
 * Pages use the addresses in the root loader's data when it has them.
 */
export const SITE = "https://g1t.sh";
export const OG = "https://og.g1t.sh";

/** What g1t is, for pages with nothing more particular to say. */
export const DESCRIPTION =
  "One workspace where a team and its agents talk, work and ship: chat with people and agents, agents with a job and a budget, and code that lands through checks. Open source, never per seat.";

/** As much of `MetaArgs` as the tags need. */
export type PageArgs = {
  location: { pathname: string };
  matches: ReadonlyArray<{ id: string; loaderData?: unknown } | undefined>;
};

export type PageMeta = {
  /** The whole <title>, ending in "· g1t". */
  title: string;
  /** Defaults to the project's or workspace's description, then g1t's. */
  description?: string | null;
  /**
   * Whatever the page's card shows, so that the card is drawn again when it
   * changes. Defaults to the project's details on project pages.
   */
  version?: unknown;
  type?: "website" | "article";
};

type ProjectData = {
  repo?: { description?: string | null };
  project?: { name?: string; description?: string | null; descriptionInherited?: boolean } | null;
  open?: { issues?: number; pulls?: number };
};
type WorkspaceData = { workspace?: { name?: string; description?: string | null; avatar?: string | null } };

function loaded<T>(args: PageArgs, id: string): T | undefined {
  return args.matches.find((match) => match?.id === id)?.loaderData as T | undefined;
}

/** A short, stable fingerprint, for the card's `v`. */
export function fingerprint(value: unknown): string {
  const text = JSON.stringify(value) ?? "";
  // FNV-1a, 32 bits.
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

/** A description fit for a preview: one line, at most 200 characters. */
function summary(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > 200 ? `${line.slice(0, 199).trimEnd()}…` : line;
}

/** The opening of some Markdown as plain text, for a description. */
export function excerpt(markdown: string | null | undefined, max = 160): string {
  const text = (markdown ?? "")
    .replace(/```[\s\S]*?(```|$)/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gm, "")
    .replace(/[`*_~|]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

/**
 * The address of a page's card. Its `v` always carries the cards' render
 * version, so a new card design is a new address for og's cache, browsers
 * and every site that has fetched the old card; then, when the page has one,
 * a fingerprint of what the card shows.
 */
export function cardUrl(pathname: string, version?: unknown, og: string = OG): string {
  const url = new URL("/image", og);
  url.searchParams.set("path", pathname);
  url.searchParams.set("v", ogVersion(version === undefined ? undefined : fingerprint(version)));
  return url.toString();
}

/** A project's own description; null while it follows its repository's. */
function ownDescription(project: { description?: string | null; descriptionInherited?: boolean } | null | undefined): string | null {
  return project && !project.descriptionInherited ? (project.description ?? null) : null;
}

export function page(args: PageArgs, meta: PageMeta): MetaDescriptor[] {
  const project = loaded<ProjectData>(args, "routes/repo/layout");
  const workspace = loaded<WorkspaceData>(args, "routes/workspace/layout");
  const description = summary(
    meta.description ||
      ownDescription(project?.project) ||
      project?.repo?.description ||
      workspace?.workspace?.description ||
      DESCRIPTION,
  );
  const version =
    meta.version ??
    (project
      ? [project.project?.name, ownDescription(project.project) ?? project.repo?.description, project.open]
      : workspace
        ? [
            workspace.workspace?.name,
            workspace.workspace?.description,
            // Only when there is one, so cards without an icon keep their address.
            ...(workspace.workspace?.avatar ? [workspace.workspace.avatar] : []),
          ]
        : undefined);
  const pathname = args.location.pathname.replace(/\/+$/, "") || "/";
  // The title a preview shows needs no "· g1t": the site name is beside it.
  const shareTitle = meta.title.replace(/ · g1t$/, "");
  const addresses = loaded<{ addresses?: Pick<Addresses, "site" | "og"> }>(args, "root")?.addresses;
  const site = addresses?.site ?? SITE;
  const og = addresses ? addresses.og : OG;
  const image = og ? cardUrl(pathname, version, og) : null;
  return [
    { title: meta.title },
    { name: "description", content: description },
    { property: "og:site_name", content: "g1t" },
    { property: "og:type", content: meta.type ?? "website" },
    { property: "og:url", content: `${site}${pathname === "/" ? "/" : pathname}` },
    { property: "og:title", content: shareTitle },
    { property: "og:description", content: description },
    ...(image
      ? [
          { property: "og:image", content: image },
          { property: "og:image:type", content: "image/png" },
          { property: "og:image:width", content: "1200" },
          { property: "og:image:height", content: "630" },
          { property: "og:image:alt", content: shareTitle },
        ]
      : []),
    { name: "twitter:card", content: image ? "summary_large_image" : "summary" },
    { name: "twitter:title", content: shareTitle },
    { name: "twitter:description", content: description },
    ...(image
      ? [
          { name: "twitter:image", content: image },
          { name: "twitter:image:alt", content: shareTitle },
        ]
      : []),
  ];
}
