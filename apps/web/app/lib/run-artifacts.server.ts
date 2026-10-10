import { env } from "cloudflare:workers";

import type { RepoPath, Viewer } from "@g1t/contracts";

import { LEGACY_KV_UNTIL } from "./run-artifacts";
import { actions } from "./services.server";

/**
 * A run's artifacts, for its page. The actions service lists them (their
 * bytes are in R2, downloaded through the API's signed links); artifacts an
 * older runner kept in KV (`a/{run}/{name}`, its bytes in chunks `…#0`,
 * `…#1`) are listed too until KV expires them, for runs the caller has
 * already been shown (`legacyArtifactsWorthAsking` in run-artifacts.ts).
 */
export type ArtifactRow = {
  /** The artifact's number; null for one kept in KV. */
  id: number | null;
  name: string;
  size: number;
  /** When it goes, RFC 3339; null for one kept in KV (14 days after it was made). */
  expiresAt: string | null;
  createdAt: string;
};

type Meta = { size: number; chunks: number; at: number; name: string };

async function kvArtifacts(run: string): Promise<ArtifactRow[]> {
  const listed = await env.BLOBS.list<Meta>({ prefix: `a/${run}/` });
  return listed.keys
    .filter((key) => !key.name.includes("#") && key.metadata)
    .map((key) => ({
      id: null,
      name: key.metadata!.name,
      size: key.metadata!.size,
      expiresAt: new Date(key.metadata!.at + 14 * 86_400_000).toISOString(),
      createdAt: new Date(key.metadata!.at).toISOString(),
    }));
}

/** A run's artifacts the actions service keeps, which checks who may see them. */
export async function listArtifacts(repo: RepoPath, viewer: Viewer, run: string): Promise<ArtifactRow[]> {
  const kept = await actions.artifacts(repo, viewer, { run, per_page: 100 });
  const rows: ArtifactRow[] = kept.ok
    ? kept.value.artifacts.map((a) => ({ id: a.id, name: a.name, size: a.size, expiresAt: a.expires_at, createdAt: a.created_at }))
    : [];
  return rows.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * `rows` with the artifacts an older runner kept in KV for `run` added.
 * Only for a run the viewer was allowed to see. Delete after
 * 2026-10-22T00:00Z (`LEGACY_KV_UNTIL`).
 */
export async function withLegacyArtifacts(rows: ArtifactRow[], run: string): Promise<ArtifactRow[]> {
  if (Date.now() >= LEGACY_KV_UNTIL) return rows;
  const legacy = await kvArtifacts(run).catch(() => []);
  const all = [...rows];
  for (const row of legacy) {
    if (!all.some((r) => r.name === row.name)) all.push(row);
  }
  return all.sort((a, b) => a.name.localeCompare(b.name));
}

export async function readArtifact(run: string, name: string): Promise<Uint8Array | null> {
  // Every artifact kept in KV has expired (run-artifacts.ts).
  if (Date.now() >= LEGACY_KV_UNTIL) return null;
  const base = `a/${run}/${name}`;
  const meta = await env.BLOBS.get<Meta>(base, "json");
  if (!meta) return null;
  const parts = await Promise.all(
    Array.from({ length: meta.chunks }, (_, index) => env.BLOBS.get(`${base}#${index}`, "arrayBuffer")),
  );
  if (parts.some((part) => part == null)) return null;
  const out = new Uint8Array(meta.size);
  let offset = 0;
  for (const part of parts as ArrayBuffer[]) {
    out.set(new Uint8Array(part), offset);
    offset += part.byteLength;
  }
  return out;
}
