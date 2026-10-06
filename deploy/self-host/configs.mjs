#!/usr/bin/env node
// Writes the Wrangler configs a self-hosted g1t runs with, derived from the
// hosted ones, so the two never drift apart.
//
// Each hosted service's wrangler.jsonc is read and changed only where
// Cloudflare-only things live:
//
// - account, routes, placement, observability and builds are dropped;
// - ARTIFACTS (git storage) becomes a service binding to workers/artifacts,
//   which keeps repositories in the git store (gitstore/server.mjs);
// - EMAIL (Email Sending) becomes a service binding to workers/mail;
// - services that are off in this phase (agents, the context hub, the
//   g1t.page dispatcher, model proxy) are bound to workers/off instead, and
//   events stop queueing work for them;
// - URLs that name g1t.sh name PUBLIC_URL instead, and billing is free.
//
// Usage: node configs.mjs [outDir]
// Environment: PUBLIC_URL, GITSTORE_URL, GITSTORE_SECRET, MAIL_URL,
// ACTIONS_KEY, INTEGRATIONS_KEY, WEBHOOKS_KEY, IDENTITY_KEY, and optionally
// your own GitHub App: GITHUB_APP_ID, GITHUB_APP_SLUG, GITHUB_APP_CLIENT_ID,
// GITHUB_APP_CLIENT_SECRET, GITHUB_APP_PRIVATE_KEY, GITHUB_APP_WEBHOOK_SECRET.
//
// The output is for `wrangler dev` (see start.sh): every Worker in one
// workerd, the site first, with D1, KV and Queues kept on disk.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const out = resolve(process.argv[2] ?? join(here, ".generated"));
mkdirSync(out, { recursive: true });

const PUBLIC_URL = (process.env.PUBLIC_URL ?? "http://localhost:8787").replace(/\/$/, "");

/** Services that run, in the order Wrangler is given them (the site first). */
export const RUNNING = [
  { name: "g1t", dir: "apps/web", web: true },
  { name: "g1t-identity", dir: "services/identity" },
  { name: "g1t-repos", dir: "services/repos" },
  { name: "g1t-work", dir: "services/work" },
  { name: "g1t-events", dir: "services/events" },
  { name: "g1t-projects", dir: "services/projects" },
  { name: "g1t-search", dir: "services/search" },
  { name: "g1t-billing", dir: "services/billing" },
  { name: "g1t-security", dir: "services/security" },
  { name: "g1t-actions", dir: "services/actions" },
  { name: "g1t-webhooks", dir: "services/webhooks" },
  { name: "g1t-integrations", dir: "services/integrations" },
  { name: "g1t-deployments", dir: "services/deployments" },
];

/** Services that are off in phase 1, and what the off Worker calls them. */
const OFF = {
  "g1t-runner": "Agents",
  "g1t-context": "Context search and memory",
};

/** Sealing keys, by the service that holds each (hosted: Wrangler secrets). */
const SECRETS = {
  "g1t-actions": "ACTIONS_KEY",
  "g1t-integrations": "INTEGRATIONS_KEY",
  "g1t-webhooks": "WEBHOOKS_KEY",
};

/**
 * g1t.sh's GitHub App is its own: an installation registers one of its
 * own, or has none, and then no GitHub buttons appear. Its public settings
 * replace the hosted vars; its secrets go only to the service that uses each.
 */
const GITHUB_VARS = ["GITHUB_APP_ID", "GITHUB_APP_SLUG", "GITHUB_APP_CLIENT_ID"];
const GITHUB_SECRETS = {
  "g1t-identity": ["GITHUB_APP_CLIENT_SECRET", "IDENTITY_KEY", "REGISTRATION_MODE"],
  "g1t-integrations": ["GITHUB_APP_PRIVATE_KEY", "GITHUB_APP_WEBHOOK_SECRET"],
};

/** Queues whose consumers are off: events stops sending to them. */
const OFF_QUEUES = new Set(["g1t-events-runner", "g1t-events-context"]);

/** Strips comments and trailing commas from JSONC. Strings are respected. */
function parseJsonc(text) {
  let result = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (inString) {
      result += char;
      if (char === "\\") result += text[++i];
      else if (char === '"') inString = false;
    } else if (char === '"') {
      inString = true;
      result += char;
    } else if (char === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      result += "\n";
    } else if (char === "/" && text[i + 1] === "*") {
      i = text.indexOf("*/", i + 2) + 1;
    } else {
      result += char;
    }
  }
  return JSON.parse(result.replace(/,(\s*[}\]])/g, "$1"));
}

const rel = (path) => relative(out, resolve(root, path)).replaceAll("\\", "/");

function hostedUrl(value) {
  return typeof value === "string" ? value.replace(/https:\/\/(api\.)?g1t\.sh/g, PUBLIC_URL) : value;
}

function selfHosted(service) {
  const hosted = parseJsonc(readFileSync(join(root, service.dir, "wrangler.jsonc"), "utf8"));
  const config = {
    name: hosted.name,
    compatibility_date: hosted.compatibility_date,
    compatibility_flags: hosted.compatibility_flags,
    rules: hosted.rules,
    vars: {},
  };

  if (service.web) {
    // The site as React Router built it (apps/web/build), not its sources.
    config.main = rel(`${service.dir}/build/server/index.js`);
    config.no_bundle = true;
    config.rules = [{ type: "ESModule", globs: ["**/*.js", "**/*.mjs"] }];
    config.assets = { directory: rel(`${service.dir}/build/client`) };
  } else {
    config.main = rel(join(service.dir, hosted.main));
  }

  for (const [key, value] of Object.entries(hosted.vars ?? {})) config.vars[key] = hostedUrl(value);

  if (hosted.d1_databases) {
    config.d1_databases = hosted.d1_databases.map((db) => ({
      binding: db.binding,
      database_name: db.database_name,
      database_id: db.database_id,
      migrations_dir: rel(join(service.dir, db.migrations_dir ?? "migrations")),
    }));
  }
  if (hosted.kv_namespaces) config.kv_namespaces = hosted.kv_namespaces.map(({ binding, id }) => ({ binding, id }));
  if (hosted.triggers) config.triggers = hosted.triggers;

  if (hosted.queues) {
    config.queues = {};
    if (hosted.queues.producers) {
      config.queues.producers = hosted.queues.producers.filter((producer) => !OFF_QUEUES.has(producer.queue));
    }
    if (hosted.queues.consumers) config.queues.consumers = hosted.queues.consumers;
  }

  config.services = (hosted.services ?? []).map((binding) =>
    OFF[binding.service] ? { binding: binding.binding, service: offName(binding.service) } : binding,
  );

  // Cloudflare-only bindings, and what stands in for them.
  if (hosted.artifacts) {
    for (const artifacts of hosted.artifacts) {
      config.services.push({ binding: artifacts.binding, service: "g1t-artifacts" });
    }
  }
  if (hosted.send_email) {
    for (const email of hosted.send_email) config.services.push({ binding: email.name, service: "g1t-mail" });
  }

  // Secrets the hosted services hold, given here from the environment, each
  // only to the service that uses it.
  const secret = SECRETS[hosted.name];
  if (secret && process.env[secret]) config.vars[secret] = process.env[secret];
  for (const name of GITHUB_VARS) {
    if (name in config.vars) config.vars[name] = process.env[name] ?? "";
  }
  for (const name of GITHUB_SECRETS[hosted.name] ?? []) {
    if (process.env[name]) config.vars[name] = process.env[name];
  }

  // Self-hosted g1t charges nothing: billing records usage at cost and never
  // stops work for it.
  if (hosted.name === "g1t-billing") config.vars.FREE_WHILE_BUILDING = "true";
  // Anyone may register on an installation of your own unless you set
  // REGISTRATION_MODE=invite; invites then work as on g1t.sh, and the owners
  // of INVITE_STAFF_WORKSPACES (yours, not g1t.sh's) invite without limit.
  if (hosted.name === "g1t-identity") {
    config.vars.REGISTRATION_MODE = process.env.REGISTRATION_MODE || "open";
    config.vars.INVITE_STAFF_WORKSPACES = process.env.INVITE_STAFF_WORKSPACES ?? "";
    if (process.env.INVITES_PER_USER) config.vars.INVITES_PER_USER = process.env.INVITES_PER_USER;
  }
  // Nothing to deploy to: deployments are off (no Cloudflare API token).
  if (hosted.name === "g1t-deployments") delete config.vars.CUSTOM_HOSTNAMES_ZONE_ID;

  return config;
}

function offName(service) {
  return `${service}-off`;
}

function write(name, config) {
  const path = join(out, `${name}.json`);
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
  return path;
}

const files = [];
for (const service of RUNNING) files.push(write(service.name, selfHosted(service)));

const compatibility_date = "2026-09-26";
files.push(
  write("g1t-artifacts", {
    name: "g1t-artifacts",
    main: rel("deploy/self-host/workers/artifacts/index.js"),
    compatibility_date,
    vars: {
      GITSTORE_URL: process.env.GITSTORE_URL ?? "http://gitstore:8080",
      GITSTORE_SECRET: process.env.GITSTORE_SECRET ?? "",
    },
  }),
);
files.push(
  write("g1t-mail", {
    name: "g1t-mail",
    main: rel("deploy/self-host/workers/mail/index.js"),
    compatibility_date,
    vars: {
      PUBLIC_URL,
      MAIL_URL: process.env.MAIL_URL ?? "",
      MAIL_FROM: process.env.MAIL_FROM ?? "",
    },
  }),
);
for (const [service, feature] of Object.entries(OFF)) {
  files.push(
    write(offName(service), {
      name: offName(service),
      main: rel("deploy/self-host/workers/off/index.js"),
      compatibility_date,
      vars: { OFF_NAME: feature },
    }),
  );
}

// The order Wrangler takes them in: the site first, as the one that serves.
writeFileSync(join(out, "workers.txt"), `${files.map((file) => relative(out, file)).join("\n")}\n`);
console.log(`Wrote ${files.length} configs to ${out}`);
