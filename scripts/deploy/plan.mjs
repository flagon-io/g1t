// What a deploy would do: for each unit, the commit it runs, what changed
// since, and its pending migrations. Git and Wrangler are passed in, so the
// tests can give their own.

import { execFileSync } from "node:child_process";

import { changedNames, lockRoots, parseCargoLock, parseNpmLock, reaches } from "./lockfiles.mjs";
import { ROOT, byStage, buildGroups, codeStages, testOnlySource, touches, touchesImage } from "./stack.mjs";

/** Git, read-only. */
export const git = {
  head: () => run(["rev-parse", "HEAD"]).trim(),
  resolve: (rev) => run(["rev-parse", "--verify", `${rev}^{commit}`]).trim(),
  subject: () => run(["log", "-1", "--format=%s"]).trim(),
  /** Whether a commit is in this checkout's history. */
  has: (sha) => {
    try {
      run(["cat-file", "-e", `${sha}^{commit}`]);
      return true;
    } catch {
      return false;
    }
  },
  /** A file's text at a commit, or "" if it is not there. */
  show: (sha, path) => {
    try {
      return run(["show", `${sha}:${path}`]);
    } catch {
      return "";
    }
  },
  /** The files directly in a folder at a commit (repository-relative). */
  list: (sha, dir) => {
    try {
      return run(["ls-tree", "--name-only", sha, "--", `${dir}/`]).split("\n").filter(Boolean);
    } catch {
      return [];
    }
  },
  /** Files changed between two commits. */
  changed: (from, to) => run(["diff", "--name-only", "--no-renames", from, to]).split("\n").filter(Boolean),
  /** Whether `older` is in `newer`'s history (and not the same commit). */
  isAncestor: (older, newer) => {
    if (older === newer) return false;
    try {
      run(["merge-base", "--is-ancestor", older, newer]);
      return true;
    } catch {
      return false;
    }
  },
  /** Uncommitted and untracked files (not ignored ones). */
  dirty: () =>
    run(["status", "--porcelain", "--untracked-files=all"])
      .split("\n")
      .filter(Boolean)
      .map((line) => line.slice(3).replace(/^"|"$/g, "").split(" -> ").pop()),
};

function run(args) {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
}

/**
 * Decides, for each unit in `units`, whether it deploys and why.
 *
 *   live:    unit id -> { sha, why? } (what readLive found)
 *   head:    the commit being deployed
 *   force:   deploy even what has not changed
 *   gitApi:  { has, changed }
 *
 * Each unit gets { deploy, reason, since, files, image }: `files` are the
 * changed files that touch it; `image` says whether its Containers image
 * must be built.
 */
export function decide(units, { live, head, force = false, rollback = false, gitApi = git }) {
  const diffs = new Map();
  const changedSince = (sha) => {
    if (!diffs.has(sha)) diffs.set(sha, gitApi.changed(sha, head));
    return diffs.get(sha);
  };
  // A lockfile change counts for a unit only if a package it uses changed.
  const locks = new Map();
  const lockChange = (sha, file) => {
    const key = `${sha}:${file}`;
    if (!locks.has(key)) {
      const parse = file === "Cargo.lock" ? parseCargoLock : parseNpmLock;
      const after = parse(gitApi.show(head, file));
      locks.set(key, { after, names: changedNames(parse(gitApi.show(sha, file)), after) });
    }
    return locks.get(key);
  };
  // A Rust source compiled only for tests (`#[cfg(test)] mod tests;`) is
  // not in what deploys. Read at the commit being deployed, each file once.
  const texts = new Map();
  const listings = new Map();
  const atHead = {
    read: (path) => {
      if (!texts.has(path)) texts.set(path, gitApi.show(head, path));
      return texts.get(path);
    },
    list: (dir) => {
      if (!listings.has(dir)) listings.set(dir, gitApi.list?.(head, dir) ?? []);
      return listings.get(dir);
    },
  };
  const testOnly = new Map();
  const onlyForTests = (unit, file) => {
    if (!file.endsWith(".rs") || !unit.crateDirs?.some((dir) => file.startsWith(`${dir}/src/`))) return false;
    if (!testOnly.has(file)) testOnly.set(file, testOnlySource(file, unit.crateDirs, atHead));
    return testOnly.get(file);
  };
  const relevant = (unit, sha, files) =>
    files.filter((file) => {
      if (onlyForTests(unit, file)) return false;
      if (file !== "Cargo.lock" && file !== "package-lock.json") return true;
      const { after, names } = lockChange(sha, file);
      const roots = lockRoots(unit)[file === "Cargo.lock" ? "cargo" : "npm"];
      return reaches(after, roots, names);
    });
  return units.map((unit) => {
    const found = live[unit.id] ?? { sha: null, why: "not read" };
    // missing: its Worker does not exist yet (new, or renamed).
    const decision = { unit, since: found.sha, missing: Boolean(found.missing), deploy: false, reason: "", files: [], image: false };
    if (!found.sha) {
      decision.deploy = true;
      decision.reason = found.error ? `could not read what it runs: ${firstLine(found.error)}` : `no known commit (${found.why ?? "unknown"})`;
      decision.image = Boolean(unit.image);
      return decision;
    }
    if (found.sha === head) {
      decision.deploy = force;
      decision.reason = force ? "forced; already at this commit" : "up to date";
      return decision;
    }
    // What runs is newer than this commit: deploying would roll it back
    // (a re-run of an old workflow run, say). Never by accident: only with
    // --rollback, whatever --force says.
    if (gitApi.has(found.sha) && gitApi.isAncestor?.(head, found.sha)) {
      decision.deploy = rollback;
      decision.reason = rollback
        ? `rolling back from ${found.sha.slice(0, 12)}`
        : `runs ${found.sha.slice(0, 12)}, which is newer than this commit; deploying would roll it back (pass --rollback to mean it)`;
      decision.image = rollback && Boolean(unit.image);
      return decision;
    }
    if (!gitApi.has(found.sha)) {
      decision.deploy = true;
      decision.reason = `runs ${found.sha.slice(0, 12)}, which this checkout does not have (fetch full history)`;
      decision.image = Boolean(unit.image);
      return decision;
    }
    const files = relevant(unit, found.sha, changedSince(found.sha));
    const hit = touches(unit, files);
    decision.files = hit ? files.filter((file) => touches(unit, [file])) : [];
    decision.image = touchesImage(unit, files);
    if (hit) {
      decision.deploy = true;
      decision.reason = `${decision.files.length} changed file${decision.files.length === 1 ? "" : "s"} (${hit.file}${hit.via === "its own folder" ? "" : ` via ${hit.via}`})`;
    } else {
      decision.deploy = force;
      decision.reason = force ? "forced; nothing it is built from changed" : "nothing it is built from changed";
    }
    return decision;
  });
}

const firstLine = (text) => String(text).trim().split("\n").find((line) => /error|\[ERROR\]|X /i.test(line)) ?? String(text).trim().split("\n")[0];

/**
 * The plan as data, for `plan --json` and the workflow: the migrations to
 * apply, and each stage's units split into the jobs that build them.
 */
export function planJson(stack, decisions, migrations, head) {
  const deploying = decisions.filter((d) => d.deploy).map((d) => d.unit);
  const stages = {};
  for (const stage of codeStages(stack)) {
    const units = deploying.filter((u) => u.stage === stage);
    stages[stage] = { units: units.map((u) => u.id), jobs: buildGroups(units, decisions.filter((d) => d.deploy && d.image).map((d) => d.unit.id)) };
  }
  return {
    commit: head,
    migrations: Object.entries(migrations)
      .filter(([, m]) => m.pending?.length)
      .map(([id, m]) => ({ unit: id, database: stack.units.find((u) => u.id === id).d1.database, pending: m.pending })),
    migration_errors: Object.entries(migrations)
      .filter(([, m]) => m.error)
      .map(([id, m]) => ({ unit: id, error: m.error })),
    stages,
    units: decisions.map((d) => ({
      unit: d.unit.id,
      stage: d.unit.stage,
      deploy: d.deploy,
      reason: d.reason,
      live_commit: d.since,
      image: d.image,
    })),
    stage_order: byStage(stack, deploying).map((g) => g.stage),
  };
}

/** A plain table. */
export function table(rows, headers) {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i] ?? "").length)));
  const line = (cells) => cells.map((c, i) => String(c ?? "").padEnd(widths[i])).join("  ").trimEnd();
  return [line(headers), line(widths.map((w) => "-".repeat(w))), ...rows.map(line)].join("\n");
}

/** Runs `task` over `items`, at most `limit` at once, in order of start. */
export async function pool(items, limit, task) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await task(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}
