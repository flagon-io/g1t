// Which units a lockfile change reaches. A change to Cargo.lock or
// package-lock.json touches only the units whose dependency graph includes
// a package that changed, read from the lockfiles themselves (their graph
// is a superset of any one target's, so this errs toward deploying).

/** Cargo.lock: name -> list of entries { version, source, checksum, deps: [names] }. */
export function parseCargoLock(text) {
  const packages = new Map();
  if (!text) return packages;
  for (const block of text.split(/^\[\[package\]\]\s*$/m).slice(1)) {
    const field = (key) => new RegExp(`^${key} = "([^"]*)"`, "m").exec(block)?.[1] ?? null;
    const depsBlock = /^dependencies = \[([\s\S]*?)\]/m.exec(block)?.[1] ?? "";
    const deps = [...depsBlock.matchAll(/"([^"\s]+)[^"]*"/g)].map((m) => m[1]);
    const entry = { version: field("version"), source: field("source"), checksum: field("checksum"), deps };
    const name = field("name");
    if (!packages.has(name)) packages.set(name, []);
    packages.get(name).push(entry);
  }
  return packages;
}

/** package-lock.json (v2/v3): name -> list of entries; workspace folders keep their path as name. */
export function parseNpmLock(text) {
  const packages = new Map();
  if (!text) return packages;
  const lock = JSON.parse(text);
  for (const [key, entry] of Object.entries(lock.packages ?? {})) {
    const at = key.lastIndexOf("node_modules/");
    const name = at < 0 ? key : key.slice(at + "node_modules/".length);
    // A workspace package is a link to its folder's entry.
    const deps = entry.link
      ? [entry.resolved]
      : Object.keys({ ...entry.dependencies, ...entry.devDependencies, ...entry.optionalDependencies, ...entry.peerDependencies });
    const record = { key, version: entry.version ?? null, resolved: entry.resolved ?? null, integrity: entry.integrity ?? null, deps };
    if (!packages.has(name)) packages.set(name, []);
    packages.get(name).push(record);
  }
  return packages;
}

const signature = (entries) => JSON.stringify((entries ?? []).map((e) => ({ ...e, deps: [...e.deps].sort() })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));

/** Names whose entries differ between two parsed lockfiles. */
export function changedNames(before, after) {
  const names = new Set();
  for (const name of new Set([...before.keys(), ...after.keys()])) {
    if (signature(before.get(name)) !== signature(after.get(name))) names.add(name);
  }
  return names;
}

/** Whether any of `names` is reachable from `roots` in a parsed lockfile (roots included). */
export function reaches(packages, roots, names) {
  if (!names.size) return false;
  const seen = new Set();
  const stack = [...roots];
  while (stack.length) {
    const name = stack.pop();
    if (seen.has(name)) continue;
    seen.add(name);
    if (names.has(name)) return true;
    for (const entry of packages.get(name) ?? []) stack.push(...entry.deps);
  }
  return false;
}

/**
 * Where a unit starts in each lockfile: its crate (or its image's) in
 * Cargo.lock; its folder, and the root's tools (Wrangler bundles every
 * TypeScript Worker), in package-lock.json.
 */
export function lockRoots(unit) {
  const cargo = [unit.crate, unit.image?.crate].filter(Boolean);
  const npm = unit.kind === "rust-worker" ? [] : [unit.path, ""];
  return { cargo, npm };
}
