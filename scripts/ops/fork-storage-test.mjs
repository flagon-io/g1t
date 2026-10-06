#!/usr/bin/env node
// Do Artifacts forks copy their source's objects, or share them?
//
// Cloudflare does not document it (docs/ARTIFACTS.md, M2), and it decides
// how much every pull request costs in storage. This makes a throwaway
// repository holding ~100 MB that cannot be compressed, forks it five
// times, and reads whatever storage figures Cloudflare reports before and
// after, then deletes everything it made. Nothing of g1t's is touched: it
// works in its own namespace (default `g1t-storage-test`), straight
// against Cloudflare's API, never through g1t.sh.
//
//   export CLOUDFLARE_API_TOKEN=<token: Artifacts edit, Account Analytics read>
//   (or a global API key: CLOUDFLARE_API_KEY with CLOUDFLARE_EMAIL)
//   node scripts/ops/fork-storage-test.mjs run        # make, fork 5x, measure for 20 min, delete
//   node scripts/ops/fork-storage-test.mjs run --keep # ... and keep it, to measure again tomorrow
//   node scripts/ops/fork-storage-test.mjs measure    # read the figures again (e.g. the next day)
//   node scripts/ops/fork-storage-test.mjs cleanup    # delete the test repositories
//   node scripts/ops/fork-storage-test.mjs schema     # list the analytics datasets Cloudflare offers for Artifacts
//
// Options: --namespace <name> (default g1t-storage-test), --mb <size> (100),
// --forks <n> (5), --minutes <n> to keep measuring (20).
//
// How to read the result: docs/ARTIFACTS.md, "R2: the fork storage test".
// Needs git on PATH. Costs a few cents of Artifacts storage and operations.

import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { cloudflareAuth } from "../deploy/cloudflare.mjs";

const ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID || "1e6f2cffa3f445920836e8ebe446bb58";
const API = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}`;
const args = process.argv.slice(2);
const command = args[0] ?? "run";
const option = (name, fallback) => {
  const at = args.indexOf(name);
  return at >= 0 && args[at + 1] ? args[at + 1] : fallback;
};
const NAMESPACE = option("--namespace", "g1t-storage-test");
const MB = Number(option("--mb", "100"));
const FORKS = Number(option("--forks", "5"));
const MINUTES = Number(option("--minutes", "20"));
const KEEP = args.includes("--keep");
const SOURCE = "fork-test-source";
const forkName = (n) => `fork-test-copy-${n}`;

const auth = cloudflareAuth();
if (!auth) {
  console.error("Set CLOUDFLARE_API_TOKEN (Artifacts edit, Account Analytics read), or CLOUDFLARE_API_KEY and CLOUDFLARE_EMAIL.");
  process.exit(2);
}

async function api(method, path, body) {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: { ...auth, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await response.json().catch(() => ({}));
  return { status: response.status, ok: response.ok && json.success !== false, json };
}

async function graphql(query, variables = {}) {
  const response = await fetch("https://api.cloudflare.com/client/v4/graphql", {
    method: "POST",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const json = await response.json();
  if (json.errors?.length) throw new Error(JSON.stringify(json.errors).slice(0, 500));
  return json.data;
}

/** The account's analytics datasets about Artifacts, and their numeric fields. */
async function datasets() {
  const data = await graphql(`{ __type(name: "account") { fields { name type { name ofType { name ofType { name ofType { name } } } } } } }`);
  const fields = data.__type?.fields ?? [];
  const found = [];
  for (const field of fields.filter((f) => /artifact/i.test(f.name))) {
    let type = field.type;
    while (type && !type.name) type = type.ofType;
    while (type?.ofType) type = type.ofType;
    const typeName = type?.name;
    const shape = typeName ? await graphql(`{ __type(name: "${typeName}") { fields { name type { name kind ofType { name kind } } } } }`) : null;
    found.push({ dataset: field.name, type: typeName, fields: (shape?.__type?.fields ?? []).map((f) => f.name) });
  }
  return found;
}

/** Every storage-looking figure Cloudflare reports for the test repositories. */
async function storageFigures() {
  const out = {};
  const sets = await datasets();
  const start = new Date(Date.now() - 2 * 24 * 3600 * 1000).toISOString();
  const end = new Date().toISOString();
  for (const set of sets) {
    if (set.dataset === "artifactsEventsAdaptiveGroups") continue;
    // A dataset other than events: ask for its sums, maxes and dimensions,
    // filtered to this namespace where it can be.
    for (const aggregate of ["max", "sum", "avg"]) {
      if (!set.fields.includes(aggregate)) continue;
      try {
        const inner = await graphql(`{ __type(name: "${set.type}") { fields { name type { name ofType { name } } } } }`);
        const aggregateType = inner.__type.fields.find((f) => f.name === aggregate)?.type;
        const aggregateName = aggregateType?.name ?? aggregateType?.ofType?.name;
        const numeric = aggregateName ? await graphql(`{ __type(name: "${aggregateName}") { fields { name } } }`) : null;
        const names = (numeric?.__type?.fields ?? []).map((f) => f.name);
        if (!names.length) continue;
        const data = await graphql(
          `query Q($account: String!, $start: Time!, $end: Time!) { viewer { accounts(filter: { accountTag: $account }) {
            ${set.dataset}(limit: 1000, filter: { datetime_geq: $start, datetime_leq: $end }) {
              ${aggregate} { ${names.join(" ")} } dimensions { repositoryNamespace repositoryName date }
            } } } }`,
          { account: ACCOUNT_ID, start, end },
        );
        const rows = data.viewer.accounts[0][set.dataset].filter((row) => !row.dimensions?.repositoryNamespace || row.dimensions.repositoryNamespace === NAMESPACE);
        out[`${set.dataset}.${aggregate}`] = rows;
      } catch (error) {
        out[`${set.dataset}.${aggregate}`] = `not readable: ${String(error.message).slice(0, 200)}`;
      }
    }
  }
  // The events themselves: errors such as storageLimitReached, and pushes.
  const events = await graphql(
    `query Q($account: String!, $start: Time!, $end: Time!, $ns: String!) { viewer { accounts(filter: { accountTag: $account }) {
      artifactsEventsAdaptiveGroups(limit: 1000, filter: { datetime_geq: $start, datetime_leq: $end, repositoryNamespace: $ns }) {
        count sum { durationMs } dimensions { repositoryName eventKind eventType }
      } } } }`,
    { account: ACCOUNT_ID, start, end, ns: NAMESPACE },
  );
  out.events = events.viewer.accounts[0].artifactsEventsAdaptiveGroups;
  return out;
}

async function repoInfo(name) {
  const got = await api("GET", `/artifacts/namespaces/${NAMESPACE}/repos/${name}`);
  return got.ok ? got.json.result : null;
}

async function setup() {
  const made = await api("POST", "/artifacts/namespaces", { namespace: NAMESPACE });
  if (!made.ok && made.status !== 409) console.log(`namespace: ${made.status} ${JSON.stringify(made.json.errors ?? "")}`);
  const created = await api("POST", `/artifacts/namespaces/${NAMESPACE}/repos`, { name: SOURCE, description: "g1t fork storage test; safe to delete" });
  if (!created.ok) throw new Error(`create: ${created.status} ${JSON.stringify(created.json.errors ?? created.json)}`);
  const { remote, token: repoToken } = created.json.result;
  console.log(`made ${NAMESPACE}/${SOURCE}`);
  // ~MB of random bytes, in files under the 32 MB limit, so nothing compresses.
  const dir = mkdtempSync(join(tmpdir(), "g1t-fork-test-"));
  try {
    const git = (...a) => execFileSync("git", a, { cwd: dir, stdio: ["ignore", "pipe", "pipe"] }).toString();
    git("init", "-q", "-b", "main");
    git("config", "user.email", "fork-test@g1t.invalid");
    git("config", "user.name", "g1t fork test");
    const files = Math.ceil(MB / 25);
    for (let n = 0; n < files; n++) writeFileSync(join(dir, `random-${n}.bin`), randomBytes(Math.min(25, MB - n * 25) * 1024 * 1024));
    git("add", ".");
    git("commit", "-q", "-m", "incompressible data");
    const started = Date.now();
    execFileSync("git", ["-c", `http.extraHeader=Authorization: Bearer ${repoToken}`, "push", "-q", remote, "main"], { cwd: dir, stdio: "inherit" });
    console.log(`pushed ${MB} MB in ${((Date.now() - started) / 1000).toFixed(1)} s`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const forks = [];
  for (let n = 1; n <= FORKS; n++) {
    const started = Date.now();
    const forked = await api("POST", `/artifacts/namespaces/${NAMESPACE}/repos/${SOURCE}/fork`, { name: forkName(n), default_branch_only: true });
    const ms = Date.now() - started;
    forks.push({ name: forkName(n), status: forked.status, ms, result: forked.json.result ?? forked.json.errors });
    console.log(`fork ${n}: ${forked.status} in ${ms} ms ${JSON.stringify(forked.json.result ?? forked.json.errors ?? {}).slice(0, 300)}`);
  }
  return forks;
}

async function cleanup() {
  for (const name of [SOURCE, ...Array.from({ length: FORKS }, (_, n) => forkName(n + 1))]) {
    const deleted = await api("DELETE", `/artifacts/namespaces/${NAMESPACE}/repos/${name}`);
    console.log(`delete ${name}: ${deleted.status}`);
  }
  console.log(`The namespace ${NAMESPACE} is left, empty (the API has no call to delete one).`);
}

async function measure(label) {
  const figures = await storageFigures();
  const info = {};
  for (const name of [SOURCE, ...Array.from({ length: FORKS }, (_, n) => forkName(n + 1))]) info[name] = await repoInfo(name);
  console.log(`\n== ${label} (${new Date().toISOString()}) ==`);
  console.log(JSON.stringify({ figures, repos: info }, null, 2));
  return figures;
}

async function main() {
  if (command === "schema") {
    console.log(JSON.stringify(await datasets(), null, 2));
    return;
  }
  if (command === "cleanup") return cleanup();
  if (command === "measure") {
    await measure("now");
    return;
  }
  if (command !== "run") throw new Error(`unknown command ${command}`);
  console.log("Artifacts analytics datasets:", JSON.stringify((await datasets()).map((d) => d.dataset)));
  await measure("before");
  let forks;
  try {
    forks = await setup();
    await measure("right after");
    const until = Date.now() + MINUTES * 60 * 1000;
    while (Date.now() < until) {
      await new Promise((resolve) => setTimeout(resolve, 5 * 60 * 1000));
      await measure(`after, ${Math.round((MINUTES * 60 * 1000 - (until - Date.now())) / 60000)} min`);
    }
  } finally {
    if (KEEP) console.log(`\nKept. Run \`measure\` tomorrow, then \`cleanup\`.`);
    else await cleanup();
  }
  console.log("\nForks:", JSON.stringify(forks, null, 2));
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
