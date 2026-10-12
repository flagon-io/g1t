/**
 * The image on a project's production card: a screenshot of production
 * (of its app on g1t.page, or of its address when it is deployed
 * elsewhere), else an image someone uploaded, else a placeholder. An
 * uploaded image is served from the usercontent origin at
 * `/production-images/<sha256>`; the projects service checks it again by
 * its bytes and is the one that decides. No Workers imports, so it is
 * tested under Node.
 */

import { sniffImage, toBase64 } from "./avatar-upload.ts";

/** As `MAX_PRODUCTION_IMAGE_BYTES` in the contracts: kept here so tests run without them. */
export const MAX_PRODUCTION_IMAGE_BYTES = 5 * 1024 * 1024;

/** What the file picker offers: PNG, JPEG and WebP. */
export const PRODUCTION_IMAGE_ACCEPT = "image/png,image/jpeg,image/webp";

const TYPES = new Set(PRODUCTION_IMAGE_ACCEPT.split(","));

/** Where an uploaded production image is served. */
export function productionImageUrl(file: string, usercontent = ""): string {
  return `${usercontent}/production-images/${file}`;
}

export type ProductionImageUpload = { image: string } | { error: string };

/** Reads the image in `field` of a submitted form, as base64 for the projects service. */
export async function readProductionImageUpload(form: FormData, field = "image"): Promise<ProductionImageUpload> {
  const file = form.get(field);
  if (!file || typeof file === "string" || file.size === 0) return { error: "Choose an image to upload." };
  if (file.size > MAX_PRODUCTION_IMAGE_BYTES) return { error: "Use an image of at most 5 MB." };
  const bytes = new Uint8Array(await file.arrayBuffer());
  const type = sniffImage(bytes);
  if (!type || !TYPES.has(type)) return { error: "Use a PNG, JPEG or WebP image." };
  return { image: toBase64(bytes) };
}

/** A production deployment reported from outside g1t.page, as the overview shows it. */
export type ReportedProduction = { url: string | null; sha: string; created_at: string };

/** A production deployed elsewhere, to take a screenshot of: its address and what it shows. */
export type ExternalTarget = {
  url: string;
  /** The reported deploy's commit, or the UTC day when none is reported. */
  commit: string;
  /** When the reported deploy was made; a screenshot from before it is taken again. */
  since: string | null;
};

/** The UTC day of `now`. */
export function utcDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

/**
 * The production deployed elsewhere whose screenshot the card shows: at
 * the address its reported production deployment gives, else the
 * project's own. Null when it is not deployed elsewhere, has no address,
 * or shows its uploaded image instead.
 */
export function externalTarget(
  project: {
    kind: string;
    runs: string | null;
    productionUrl: string | null;
    productionImage: { preferred: boolean } | null;
  },
  reported: ReportedProduction | null,
  now: number,
): ExternalTarget | null {
  if (project.productionImage?.preferred) return null;
  // An app that has not said where it runs, but reports production from elsewhere, runs elsewhere.
  const elsewhere = project.runs === "elsewhere" || (project.runs === null && project.kind === "app" && reported != null);
  if (!elsewhere) return null;
  const url = reported?.url ?? project.productionUrl;
  if (!url || !/^https?:\/\//i.test(url)) return null;
  const sha = reported?.sha?.toLowerCase() ?? "";
  if (reported && /^[0-9a-f]{7,64}$/.test(sha)) return { url, commit: sha, since: reported.created_at };
  return { url, commit: utcDay(now), since: null };
}

/** What names one screenshot of an external production, for its address on the site: changes with a deploy or a day. */
export function externalVersion(target: ExternalTarget): string {
  return `${target.commit}-${(target.since && Date.parse(target.since)) || 0}`;
}

/**
 * The images the card tries, in order, falling to the next when one does
 * not load: the uploaded image alone when it is preferred; else the
 * screenshot, then the uploaded image. Empty: the placeholder.
 */
export function cardSources(screenshot: string | null, upload: { url: string; preferred: boolean } | null): CardSource[] {
  const uploaded: CardSource[] = upload ? [{ src: upload.url, kind: "upload" }] : [];
  if (upload?.preferred) return uploaded;
  return [...(screenshot ? [{ src: screenshot, kind: "screenshot" as const }] : []), ...uploaded];
}

/** One image the card may show, and what it is. */
export type CardSource = { src: string; kind: "screenshot" | "upload" };
