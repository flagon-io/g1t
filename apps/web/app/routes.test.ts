import assert from "node:assert/strict";
import { test } from "node:test";

import { matchRoutes } from "react-router";

import routes from "./routes.ts";

type Config = { id?: string; file: string; path?: string; index?: boolean; children?: Config[] };
type Plain = { id: string; path?: string; index?: boolean; children?: Plain[] };

/** The config as the router sees it, its routes in this order or the other way round. */
function plain(config: Config[], reversed: boolean): Plain[] {
  const out = config.map((route) => ({
    id: route.id ?? route.file,
    path: route.path,
    index: route.index,
    children: route.children ? plain(route.children, reversed) : undefined,
  }));
  return reversed ? out.reverse() : out;
}

/** Each route's full path, from its parents'. */
function paths(config: Config[], parent = ""): string[] {
  return config.flatMap((route) => {
    const path = route.path ? `${parent}/${route.path}` : parent;
    return [...(route.children ? paths(route.children, path) : []), ...(route.children || route.index || route.path ? [path] : [])];
  });
}

/** A path's segments, once with each optional segment and once without. */
function exploded(path: string): string[][] {
  let found: string[][] = [[]];
  for (const segment of path.split("/").filter(Boolean)) {
    const name = segment.replace(/\?$/, "");
    found = found.flatMap((at) => (segment.endsWith("?") ? [at, [...at, name]] : [[...at, name]]));
  }
  return found;
}

const param = (segment: string) => segment.startsWith(":");

/**
 * An address both paths match, else null: each segment the one's or the
 * other's name where it has one (`u/:username/pulls` and
 * `:owner/:repo/pulls` both match `/u/x/pulls`).
 */
function both(one: string[], other: string[]): string | null {
  if (one.length !== other.length || one.includes("*") || other.includes("*")) return null;
  const address: string[] = [];
  for (const [i, a] of one.entries()) {
    const b = other[i]!;
    if (!param(a) && !param(b) && a.toLowerCase() !== b.toLowerCase()) return null;
    address.push(param(a) ? (param(b) ? "x" : b) : a);
  }
  return `/${address.join("/")}`;
}

// Two routes that rank level for one address are told apart by their order
// alone. The browser learns routes as it goes, so its order can differ from
// the server's: it then asks for one route's data and the server answers
// with the other's ("No result found for routeId"). `u/:username/:tab?`
// against `:owner/:repo/pulls` was one (#427).
test("every address is the same route whatever order the routes are in", () => {
  const config = routes as Config[];
  const forward = plain(config, false);
  const backward = plain(config, true);
  const ties: string[] = [];
  const all = paths(config).flatMap(exploded);
  const addresses = new Set<string>();
  for (const [i, one] of all.entries()) for (const other of all.slice(i)) {
    const address = both(one, other);
    if (address) addresses.add(address);
  }
  for (const address of addresses) {
    const one = matchRoutes(forward, address)?.at(-1)?.route.id;
    const other = matchRoutes(backward, address)?.at(-1)?.route.id;
    if (one !== other) ties.push(`${address}: ${one} or ${other}`);
  }
  assert.deepEqual(ties, []);
});
