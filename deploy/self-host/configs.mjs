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
// - the packages service keeps files in S3-compatible storage (MinIO)
//   instead of R2, and the repos service its nightly backups (a bucket of
//   their own, BACKUP_S3_BUCKET);
// - services that are off in this phase (agents, the context hub, the
//   g1t.page dispatcher, model proxy) are bound to workers/off instead, and
//   events stop queueing work for them;
// - URLs that name g1t.sh name PUBLIC_URL instead, and billing is free.
//
// Usage: node configs.mjs [outDir]
// Environment: PUBLIC_URL, GITSTORE_URL, GITSTORE_SECRET, MAIL_URL,
// ACTIONS_KEY, INTEGRATIONS_KEY, WEBHOOKS_KEY, IDENTITY_KEY,
// PACKAGES_TOKEN_SECRET, S3_ENDPOINT, S3_BUCKET, BACKUP_S3_BUCKET, S3_REGION,
// S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY, S3_PUBLIC_ENDPOINT, and optionally
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

// What runs, and what is off, is each unit's `self_host` in
// deploy/stack.jsonc: the list hosted g1t deploys from.
const STACK = Object.values(parseJsonc(readFileSync(join(root, "deploy/stack.jsonc"), "utf8")).units);

/** Services that run, in the order Wrangler is given them (the site first). */
export const RUNNING = STACK.filter((unit) => unit.self_host === "run")
  .map((unit) => ({ name: unit.worker, dir: unit.path, web: unit.kind === "react-router" }))
  .sort((a, b) => Number(b.web) - Number(a.web));

/** What the off Worker calls each service that is off in phase 1. */
const OFF_NAMES = {
  "g1t-runner": "Agents",
  "g1t-context": "Context search and memory",
};
const OFF = Object.fromEntries(
  STACK.filter((unit) => unit.self_host === "off").map((unit) => [unit.worker, OFF_NAMES[unit.worker] ?? unit.worker]),
);

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

/**
 * Services whose cron triggers scheduler.mjs runs here: sweeps and
 * reminders that need nothing self-hosting lacks. Not run: actions (its
 * minute would start scheduled workflows with no runner to take them),
 * billing (reconciles against Cloudflare and Stripe), deployments (calls
 * Cloudflare's API) and the services that are off.
 */
const SELF_HOST_CRONS = new Set(["g1t-repos", "g1t-events", "g1t-identity", "g1t-security", "g1t-webhooks", "g1t-packages"]);

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
    // Access requests are summarised to your own address, not g1t.sh's.
    config.vars.WAITLIST_NOTIFY_EMAIL = process.env.WAITLIST_NOTIFY_EMAIL ?? "";
  }
  // Packages' files go to the compose file's MinIO (or any S3-compatible
  // store) instead of R2, with no request size limit, and package
  // addresses start with this installation's host.
  if (hosted.name === "g1t-packages") {
    Object.assign(config.vars, {
      BLOB_STORE: "s3",
      S3_ENDPOINT: process.env.S3_ENDPOINT ?? "http://minio:9000",
      S3_BUCKET: process.env.S3_BUCKET ?? "g1t-packages",
      S3_REGION: process.env.S3_REGION ?? "us-east-1",
      S3_ACCESS_KEY_ID: process.env.S3_ACCESS_KEY_ID ?? "",
      S3_SECRET_ACCESS_KEY: process.env.S3_SECRET_ACCESS_KEY ?? "",
      S3_PUBLIC_ENDPOINT: process.env.S3_PUBLIC_ENDPOINT ?? "",
      MAX_REQUEST_BYTES: "0",
      STORAGE_LIMITS: "off",
      REGISTRY_HOST: new URL(PUBLIC_URL).host,
      PACKAGES_TOKEN_SECRET: process.env.PACKAGES_TOKEN_SECRET ?? "",
    });
    delete config.vars.R2_ACCOUNT_ID;
    delete config.vars.R2_BUCKET;
  }
  // Nightly backups' bundles go to a bucket of their own on the same
  // S3-compatible store, instead of the BACKUPS R2 bucket.
  if (hosted.name === "g1t-repos") {
    Object.assign(config.vars, {
      BACKUP_STORE: "s3",
      BACKUP_S3_BUCKET: process.env.BACKUP_S3_BUCKET ?? "g1t-backups",
      S3_ENDPOINT: process.env.S3_ENDPOINT ?? "http://minio:9000",
      S3_REGION: process.env.S3_REGION ?? "us-east-1",
      S3_ACCESS_KEY_ID: process.env.S3_ACCESS_KEY_ID ?? "",
      S3_SECRET_ACCESS_KEY: process.env.S3_SECRET_ACCESS_KEY ?? "",
    });
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

// What scheduler.mjs runs: each service's own crons, as hosted g1t's Cron
// Triggers run them, for the services in SELF_HOST_CRONS.
const schedules = RUNNING.filter((service) => SELF_HOST_CRONS.has(service.name))
  .map((service) => ({
    worker: service.name,
    crons: parseJsonc(readFileSync(join(root, service.dir, "wrangler.jsonc"), "utf8")).triggers?.crons ?? [],
  }))
  .filter((schedule) => schedule.crons.length > 0);
writeFileSync(join(out, "schedules.json"), `${JSON.stringify(schedules, null, 2)}\n`);

// The status page runs in a workerd of its own (status.sh, the `status`
// service in docker-compose.yml), so it stays up when the site does not:
// not in workers.txt. It checks the site from inside Compose
// (STATUS_CHECK_URL) and links to it at PUBLIC_URL. Parts this
// installation does not run (the API, MCP, docs, g1t.page, the model
// proxy, billing) are left off its page; a public repository of yours in
// STATUS_PROBE_REPO adds the git check.
{
  const hosted = parseJsonc(readFileSync(join(root, "apps/status/wrangler.jsonc"), "utf8"));
  const db = hosted.d1_databases[0];
  write("g1t-status", {
    name: hosted.name,
    main: rel(join("apps/status", hosted.main)),
    compatibility_date: hosted.compatibility_date,
    rules: hosted.rules,
    triggers: hosted.triggers,
    d1_databases: [
      {
        binding: db.binding,
        database_name: db.database_name,
        database_id: db.database_id,
        migrations_dir: rel(join("apps/status", db.migrations_dir)),
      },
    ],
    vars: {
      SITE_URL: (process.env.STATUS_CHECK_URL ?? "http://g1t:8787").replace(/\/$/, ""),
      PUBLIC_SITE_URL: PUBLIC_URL,
      API_URL: "",
      MCP_URL: "",
      DOCS_URL: "",
      PAGES_URL: "",
      MODELS_URL: "",
      PROBE_REPO: process.env.STATUS_PROBE_REPO ?? "",
      SUPPORT_URL: `${PUBLIC_URL}/support`,
      OG_IMAGE: "",
      // Its own address, for links made outside a request. No email
      // binding here: subscribing by email is off, the feeds work.
      STATUS_URL: `http://localhost:${process.env.STATUS_PORT ?? "8788"}`,
      STATUS_ALERT_EMAIL: "",
    },
  });
}
console.log(`Wrote ${files.length} configs to ${out}`);
