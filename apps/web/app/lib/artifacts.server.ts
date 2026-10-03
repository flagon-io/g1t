import { env } from "cloudflare:workers";

/**
 * A run's artifacts, as the API keeps them in KV: a metadata key per
 * artifact, `a/{run}/{name}`, and its bytes in chunks, `…#0`, `…#1`.
 */
export type ArtifactMeta = { name: string; size: number; at: number };

type Meta = { size: number; chunks: number; at: number; name: string };

export async function listArtifacts(run: string): Promise<ArtifactMeta[]> {
  const listed = await env.BLOBS.list<Meta>({ prefix: `a/${run}/` });
  return listed.keys
    .filter((key) => !key.name.includes("#") && key.metadata)
    .map((key) => ({ name: key.metadata!.name, size: key.metadata!.size, at: key.metadata!.at }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function readArtifact(run: string, name: string): Promise<Uint8Array | null> {
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
