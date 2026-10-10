import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { FOLIO_RPC, folioHandler } from "./rpc.ts";

/** FOLIO_RPC_METHODS as the contract lists them (read from the source: Node can't load the contracts package itself). */
function contractMethods(): string[] {
  const source = readFileSync(new URL("../../../../packages/contracts/src/folios.ts", import.meta.url), "utf8");
  const block = source.slice(source.indexOf("export const FOLIO_RPC_METHODS = ["), source.indexOf("] as const;"));
  return [...block.matchAll(/^\s*"([a-z_]+)",/gm)].map((m) => m[1]!);
}

test("every folio RPC method in the contract is answered, and nothing else", () => {
  const methods = contractMethods();
  assert.ok(methods.length >= 40);
  assert.deepEqual(Object.keys(FOLIO_RPC).sort(), [...methods].sort());
  for (const m of methods) assert.equal(typeof folioHandler(m), "function", m);
});

test("Docs' own methods fall through to the legacy switch", () => {
  for (const m of ["sidebar", "page", "create_page", "recall_for_agent", "toString", "__proto__", "constructor"]) assert.equal(folioHandler(m), null, m);
});
