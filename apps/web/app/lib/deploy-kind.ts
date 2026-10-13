/**
 * What Settings, Deployments says a project is, from its last build: its
 * kind and what it was built with (`Static site · Astro`, `Container ·
 * Dockerfile`), and what running it costs, in a line. No imports beyond
 * types, so it can be tested under Node.
 */

import type { BuildAs, DetectedKind } from "@g1t/contracts";

export const KIND_LABELS: Record<DetectedKind, string> = {
  static: "Static site",
  html: "Plain HTML",
  workers: "Workers project",
  container: "Container",
};

export const KIND_COSTS: Record<DetectedKind, string> = {
  static: "Serving its files runs no code, so it adds no requests or CPU time. Builds are metered.",
  html: "Its files are served as they are and run no code, so serving adds no requests or CPU time. Builds are metered.",
  workers: "Its code runs on every request: requests and CPU time are metered, and so are builds.",
  container:
    "Its container runs only while it is awake: from the first request until it has had none for a few minutes, metered by the minute at its size, with what it sends. Builds are metered.",
};

/** `Static site · Astro`, `Container · Dockerfile`, or the kind alone when nothing names what it was built with. */
export function detectedLabel(kind: DetectedKind, framework: string | null | undefined, names: Record<string, string>): string {
  const built = framework ? (names[framework] ?? null) : null;
  if (!built) return KIND_LABELS[kind];
  // A server g1t wrote a Dockerfile for says so.
  const written = kind === "container" && framework !== "dockerfile" ? `${built}, with a Dockerfile g1t wrote` : built;
  return `${KIND_LABELS[kind]} · ${written}`;
}

/** The Build as choices, as the select shows them. */
export const BUILD_AS_OPTIONS: { value: BuildAs; label: string }[] = [
  { value: "auto", label: "Auto: found from its files" },
  { value: "static", label: "Static site" },
  { value: "workers", label: "Workers" },
  { value: "docker", label: "Container" },
];

/** `1/16 vCPU, 256 MiB, 2 GB disk`. */
export function sizeLabel(size: { vcpu: number; memoryGib: number; diskGb: number }): string {
  const vcpu = size.vcpu >= 1 ? String(size.vcpu) : `1/${Math.round(1 / size.vcpu)}`;
  const memory = size.memoryGib >= 1 ? `${size.memoryGib} GiB` : `${Math.round(size.memoryGib * 1024)} MiB`;
  return `${vcpu} vCPU, ${memory}, ${size.diskGb} GB disk`;
}
