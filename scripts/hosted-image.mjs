#!/usr/bin/env node
// g1t's machine image, published where runners can pull it: the base that
// services/runner/base.json records (services/runner/base/Dockerfile,
// built by `node scripts/deploy.mjs build-base`) is only in Cloudflare's
// private registry, which a workspace's runner cannot pull from. A runner
// release copies it to the public g1t.sh/flagon-io/g1t-hosted under the
// base's tag, by digest, and the signed manifest's sandbox section names
// it (scripts/sandbox-image.mjs `section`), so the sandbox's runner runs
// jobs asking for g1t's machines in it (crates/runner/src/selfhosted/).
//
//   node scripts/hosted-image.mjs publish [--base services/runner/base.json] [--to g1t.sh/flagon-io/g1t-hosted]
//   node scripts/hosted-image.mjs ref     [--base …] [--to …]   the reference it is published as, asking nothing
//
// `publish` asks g1t.sh for the base's digest first and copies nothing
// when it is there. Otherwise it copies registry to registry, with no
// Docker (scripts/deploy/registry.mjs `copyImage`): it reads Cloudflare's
// registry with Wrangler's short-lived credentials, as deploys do
// (scripts/deploy/image.mjs), and writes g1t.sh with G1T_TOKEN. Each layer
// streams across in 90 MiB chunks, each its own request, as `g1t push`
// sends them: g1t.sh takes at most 100 MB a request, which `docker buildx
// imagetools create` sends a layer in whole (413, runner release #18).
// Nothing is pulled or unpacked on the machine, so it needs no room for the
// 5.6 GB image. The manifest's own bytes are written, so g1t.sh then has
// the same digest; when it doesn't, it fails.
//
// It prints the reference by digest (g1t.sh/flagon-io/g1t-hosted@sha256:…)
// and, in a workflow, writes `hosted_image` and `hosted_image_size` to
// $GITHUB_OUTPUT.

import { appendFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { registryCredentials } from "./deploy/image.mjs";
import { copyImage, parseRef, repositoryClient } from "./deploy/registry.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export const BASE_LOCK = join(ROOT, "services/runner/base.json");
export const HOSTED_REPOSITORY = "g1t.sh/flagon-io/g1t-hosted";

/** The base base.json records: its reference, digest and size, checked. */
export function readBase(text) {
  const lock = JSON.parse(text);
  if (!lock.pushed) throw new Error("base.json records a base that was never pushed: node scripts/deploy.mjs build-base");
  if (!/^sha256:[0-9a-f]{64}$/.test(lock.digest ?? "")) throw new Error(`base.json records no digest: ${lock.digest}`);
  const { host, name, tag } = parseRef(lock.image);
  if (!tag) throw new Error(`base.json's image has no tag: ${lock.image}`);
  return { host, name, tag, digest: lock.digest, size: Number(lock.size_bytes) || null };
}

/** Where the base comes from and goes to: by digest, and under its tag. */
export function refsFor(base, to = HOSTED_REPOSITORY) {
  return {
    source: `${base.host}/${base.name}@${base.digest}`,
    tagged: `${to}:${base.tag}`,
    pinned: `${to}@${base.digest}`,
  };
}

/** Whether `ref` (host/name@digest) is in its registry. */
export function registryHas(ref, { fetchImpl = fetch, credentials = async () => null } = {}) {
  const { host, name, tag, digest } = parseRef(ref);
  return repositoryClient(host, name, { credentials, fetchImpl }).hasManifest(digest ?? tag);
}

/** g1t.sh's credentials, from G1T_TOKEN: none, and the image is public. */
export function g1tCredentials(env = process.env) {
  const token = env.G1T_TOKEN?.trim();
  return async () => (token ? { username: "g1t", password: token } : null);
}

/**
 * Copies the base to `to` unless its digest is there. `has` is the
 * registry check, and `copy` copies `{ digest, tag }` (`copyImage` between
 * the two registries). Returns the reference by digest and whether it copied.
 */
export async function publish({ base, to = HOSTED_REPOSITORY, has, copy, onLine = () => {} }) {
  const { source, tagged, pinned } = refsFor(base, to);
  let there = false;
  try {
    there = await has(pinned);
  } catch (error) {
    // A repository g1t.sh doesn't have yet answers 401, not 404, to one
    // who may not create it: the copy says whether we may.
    onLine(`could not ask g1t.sh for ${pinned} (${error.message ?? error}); copying it`);
  }
  if (there) {
    onLine(`${pinned} is in g1t.sh already: nothing to copy`);
    return { ref: pinned, copied: false };
  }
  onLine(`copying ${source} to ${tagged}`);
  const started = Date.now();
  try {
    await copy({ digest: base.digest, tag: base.tag });
  } catch (error) {
    throw new Error(`copying ${source} to ${tagged} failed: ${error.message ?? error}`);
  }
  if (!(await has(pinned))) {
    throw new Error(`${tagged} was copied, but g1t.sh has no ${base.digest}: the copy is not exact, so runners would pull an image the manifest doesn't name`);
  }
  onLine(`copied in ${Math.round((Date.now() - started) / 1000)}s: ${pinned}`);
  return { ref: pinned, copied: true };
}

if (process.argv[1]?.replaceAll("\\", "/").endsWith("scripts/hosted-image.mjs")) {
  const [command, ...rest] = process.argv.slice(2);
  const option = (name) => {
    const at = rest.indexOf(`--${name}`);
    return at >= 0 ? rest[at + 1] : undefined;
  };
  try {
    const base = readBase(readFileSync(option("base") ?? BASE_LOCK, "utf8"));
    const to = option("to") ?? HOSTED_REPOSITORY;
    let ref;
    switch (command) {
      case "ref":
        ref = refsFor(base, to).pinned;
        break;
      case "publish": {
        const credentials = g1tCredentials();
        const target = parseRef(`${to}:${base.tag}`);
        ({ ref } = await publish({
          base,
          to,
          has: (pinned) => registryHas(pinned, { credentials }),
          copy: ({ digest, tag }) =>
            copyImage({
              from: repositoryClient(base.host, base.name, { credentials: () => registryCredentials() }),
              to: repositoryClient(target.host, target.name, { credentials }),
              digest,
              tag,
              onLine: (line) => console.log(line),
            }),
          onLine: (line) => console.log(line),
        }));
        break;
      }
      default:
        console.error("usage: node scripts/hosted-image.mjs publish|ref [--base FILE] [--to REPOSITORY]");
        process.exit(2);
    }
    console.log(ref);
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `hosted_image=${ref}\nhosted_image_size=${base.size ?? ""}\n`);
  } catch (error) {
    console.error(String(error.message ?? error));
    process.exit(1);
  }
}
