#!/usr/bin/env node
// What is on g1t's Cloudflare account that nothing declares? Lists the
// account's Workers, Worker custom domains, D1 databases, R2 buckets, KV
// namespaces, queues, Vectorize indexes, dispatch namespaces, Durable Object
// namespaces and container applications, and names each one no unit's
// wrangler.jsonc (deploy/stack.jsonc) binds, routes or deploys.
//
// What it finds is most often what a deleted service left behind: its
// database, queues and domain stay until someone deletes them by hand, and
// they did, unseen, for weeks. Apps the deployments service runs for
// projects (in the dispatch namespace a unit binds) are its own to tidy, and
// are not counted.
//
// Read-only: it lists and compares, and deletes nothing. Something listed may
// be made by hand ahead of the change that binds it; that is for whoever
// reads the report to say.
//
//   CLOUDFLARE_API_TOKEN=<token> node scripts/ops/cloudflare-drift.mjs [--json] [--account <id>]
//
// The token reads each listing (Workers Scripts, D1, Workers R2 Storage,
// Workers KV Storage, Queues, Vectorize, Containers: Read). A listing it may
// not read is a note in the report, never a clean one. With
// GITHUB_STEP_SUMMARY set, the report is also the run's summary.
//
// Exits 1 when anything is undeclared or a listing failed, so a scheduled run
// (.g1t/workflows/cloudflare-drift.yml) goes red.

import { appendFileSync } from "node:fs";
import { ACCOUNT_ID, cloudflareAuth } from "../deploy/cloudflare.mjs";
import { loadStack } from "../deploy/stack.mjs";

const API = "https://api.cloudflare.com/client/v4";

/** What the units' configs declare, by kind. `configs` are parsed wrangler.jsonc files. */
export function declared(configs) {
  const d = {
    workers: new Set(),
    domains: new Set(),
    d1: new Set(),
    r2: new Set(),
    kv: new Set(),
    queues: new Set(),
    vectorize: new Set(),
    dispatch: new Set(),
  };
  const walk = (config) => {
    if (config.name) d.workers.add(config.name);
    for (const route of config.routes ?? []) if (route.custom_domain) d.domains.add(route.pattern);
    for (const db of config.d1_databases ?? []) d.d1.add(db.database_id);
    for (const bucket of config.r2_buckets ?? []) d.r2.add(bucket.bucket_name);
    for (const ns of config.kv_namespaces ?? []) d.kv.add(ns.id);
    for (const producer of config.queues?.producers ?? []) d.queues.add(producer.queue);
    for (const consumer of config.queues?.consumers ?? []) {
      d.queues.add(consumer.queue);
      if (consumer.dead_letter_queue) d.queues.add(consumer.dead_letter_queue);
    }
    for (const index of config.vectorize ?? []) d.vectorize.add(index.index_name);
    for (const ns of config.dispatch_namespaces ?? []) d.dispatch.add(ns.namespace);
    for (const env of Object.values(config.env ?? {})) walk(env);
  };
  for (const config of configs) walk(config);
  return d;
}

/**
 * Each of the account's resources nothing declares, as `{ kind, name, detail }`.
 * `account` holds each listing as Cloudflare answers it; `dispatchScripts`
 * the scripts in the declared dispatch namespaces, whose own Durable Object
 * namespaces and containers are theirs.
 */
export function drift(account, d) {
  const found = [];
  const add = (kind, name, detail = "") => found.push({ kind, name, detail });
  const apps = new Set(account.dispatchScripts ?? []);
  const ownedByWorker = (name) => [...d.workers].some((worker) => name.startsWith(`${worker}-`));
  for (const w of account.workers) if (!d.workers.has(w.id)) add("Worker", w.id, `last deployed ${day(w.modified_on)}`);
  for (const dom of account.domains) if (!d.domains.has(dom.hostname)) add("Custom domain", dom.hostname, `on ${dom.service}`);
  for (const db of account.d1) if (!d.d1.has(db.uuid)) add("D1 database", db.name, `${db.uuid}, created ${day(db.created_at)}`);
  for (const bucket of account.r2) if (!d.r2.has(bucket.name)) add("R2 bucket", bucket.name, `created ${day(bucket.creation_date)}`);
  for (const ns of account.kv) if (!d.kv.has(ns.id)) add("KV namespace", ns.title, ns.id);
  for (const q of account.queues) if (!d.queues.has(q.queue_name)) add("Queue", q.queue_name, `created ${day(q.created_on)}`);
  for (const index of account.vectorize) if (!d.vectorize.has(index.name)) add("Vectorize index", index.name, `created ${day(index.created_on)}`);
  for (const ns of account.dispatchNamespaces)
    if (!d.dispatch.has(ns.namespace_name)) add("Dispatch namespace", ns.namespace_name, `${ns.script_count ?? "?"} scripts`);
  for (const ns of account.durableObjects) {
    if (ns.dispatch_namespace ? d.dispatch.has(ns.dispatch_namespace) : d.workers.has(ns.script)) continue;
    add("Durable Object namespace", `${ns.script ?? "?"}.${ns.class}`, ns.dispatch_namespace ? `in ${ns.dispatch_namespace}` : "");
  }
  for (const app of account.containers) {
    if (ownedByWorker(app.name) || apps.has(app.name.replace(/^g1t-/, ""))) continue;
    add("Container application", app.name, `${app.instances ?? "?"} instances`);
  }
  return found;
}

const day = (at) => (at ? String(at).slice(0, 10) : "?");

/** The report, as Markdown. */
export function report(found, notes) {
  const lines = ["# Cloudflare drift", ""];
  if (found.length === 0 && notes.length === 0) {
    lines.push("Everything on the account is declared by a unit's wrangler.jsonc.");
    return lines.join("\n");
  }
  if (found.length > 0) {
    lines.push(
      `${found.length} on the account that no unit's wrangler.jsonc declares. Delete what a removed service left behind; declare what is meant to stay.`,
      "",
    );
    lines.push("| Kind | Name | |", "| --- | --- | --- |");
    for (const f of found) lines.push(`| ${f.kind} | \`${f.name}\` | ${f.detail} |`);
  }
  if (notes.length > 0) {
    lines.push("", "Not checked, so this report is not complete:", "");
    for (const note of notes) lines.push(`- ${note}`);
  }
  return lines.join("\n");
}

async function listAll(path, headers, notes, label) {
  const all = [];
  for (let page = 1; ; page++) {
    const url = new URL(API + path);
    url.searchParams.set("page", String(page));
    url.searchParams.set("per_page", url.pathname.endsWith("/r2/buckets") ? "1000" : "100");
    const response = await fetch(url, { headers });
    const body = await response.json().catch(() => ({}));
    if (!body.success) {
      notes.push(`${label}: ${response.status} ${JSON.stringify(body.errors ?? body).slice(0, 200)}`);
      return [];
    }
    const result = Array.isArray(body.result) ? body.result : (body.result?.buckets ?? []);
    all.push(...result);
    // R2 answers every bucket at once; the rest page.
    const info = body.result_info;
    if (!Array.isArray(body.result) || result.length === 0 || !info?.total_pages || page >= info.total_pages) return all;
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help")) {
    console.log(
      "node scripts/ops/cloudflare-drift.mjs [--json] [--account <id>]\n\nLists what is on the Cloudflare account that no unit's wrangler.jsonc declares.",
    );
    return;
  }
  const at = args.indexOf("--account");
  const account = at >= 0 ? args[at + 1] : (process.env.CLOUDFLARE_ACCOUNT_ID ?? ACCOUNT_ID);
  const headers = cloudflareAuth();
  if (!headers) {
    console.error("Needs CLOUDFLARE_API_TOKEN, or CLOUDFLARE_API_KEY with CLOUDFLARE_EMAIL.");
    process.exit(2);
  }
  const d = declared(
    loadStack()
      .units.map((unit) => unit.config)
      .filter(Boolean),
  );
  const notes = [];
  const a = `/accounts/${account}`;
  const [workers, domains, d1, r2, kv, queues, vectorize, dispatchNamespaces, durableObjects, containers] = await Promise.all([
    listAll(`${a}/workers/scripts`, headers, notes, "Workers"),
    listAll(`${a}/workers/domains`, headers, notes, "Custom domains"),
    listAll(`${a}/d1/database`, headers, notes, "D1"),
    listAll(`${a}/r2/buckets`, headers, notes, "R2"),
    listAll(`${a}/storage/kv/namespaces`, headers, notes, "KV"),
    listAll(`${a}/queues`, headers, notes, "Queues"),
    listAll(`${a}/vectorize/v2/indexes`, headers, notes, "Vectorize"),
    listAll(`${a}/workers/dispatch/namespaces`, headers, notes, "Dispatch namespaces"),
    listAll(`${a}/workers/durable_objects/namespaces`, headers, notes, "Durable Objects"),
    listAll(`${a}/containers/applications`, headers, notes, "Containers"),
  ]);
  const dispatchScripts = [];
  for (const ns of dispatchNamespaces.filter((ns) => d.dispatch.has(ns.namespace_name))) {
    const scripts = await listAll(`${a}/workers/dispatch/namespaces/${ns.namespace_name}/scripts`, headers, notes, `Scripts in ${ns.namespace_name}`);
    dispatchScripts.push(...scripts.map((script) => script.id));
  }
  const found = drift({ workers, domains, d1, r2, kv, queues, vectorize, dispatchNamespaces, durableObjects, containers, dispatchScripts }, d);
  if (args.includes("--json")) console.log(JSON.stringify({ found, notes }, null, 2));
  else console.log(report(found, notes));
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${report(found, notes)}\n`);
  if (found.length > 0 || notes.length > 0) process.exitCode = 1;
}

if (process.argv[1]?.replaceAll("\\", "/").endsWith("scripts/ops/cloudflare-drift.mjs")) {
  main().catch((error) => {
    console.error(`cloudflare-drift: ${error.message}`);
    process.exit(1);
  });
}
