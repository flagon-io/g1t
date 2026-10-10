/**
 * Names and faces for member keys (`user:<id>`, `agent:<id>`): comment
 * authors and history. Asked of the site once per key per tab.
 */
import type { AgentLook, Result } from "@g1t/contracts";

/** Someone by member key, as the site names them. */
export type Who = { key: string; kind: "user" | "agent"; id: string; name: string; display_name: string; avatar: string | null; avatar_seed: string | null; look?: AgentLook | null };

const known = new Map<string, Who>();

/** Names and faces for member keys (`user:<id>`, `agent:<id>`), asked of the site once each. */
export async function whoAre(slug: string, keys: string[]): Promise<Map<string, Who>> {
  const wanted = [...new Set(keys)].filter((k) => !known.has(k) && /^(user|agent):/.test(k));
  if (wanted.length) {
    try {
      const r = await fetch(`/${slug}/-/artifacts/api?who=${encodeURIComponent(wanted.join(","))}`, { headers: { accept: "application/json" } });
      const result = (await r.json()) as Result<Who[]>;
      if (result.ok) for (const w of result.value) known.set(w.key, w);
    } catch {
      // Shown as "Someone" until asked again.
    }
  }
  return new Map(keys.map((k) => [k, known.get(k)!]).filter(([, w]) => !!w) as [string, Who][]);
}

