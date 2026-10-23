// The runner's image made in the registry (registry.mjs): its layer,
// config and manifest, and the calls it makes, against a registry kept in
// memory.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { gunzipSync } from "node:zlib";

import {
  DOCKER_MANIFEST,
  OCI_MANIFEST,
  RUNNER_BINARY_MODE,
  RUNNER_BINARY_PATH,
  RUNNER_ENTRYPOINT,
  appendRunnerImage,
  bearerChallenge,
  copyImage,
  parseRef,
  repositoryClient,
  runnerConfig,
  runnerLayer,
  runnerManifest,
  sha256,
  tarOf,
} from "./registry.mjs";
import { ROOT } from "./stack.mjs";

/** A tar's entries: name, mode, size, owner, type and bytes, checksums checked. */
function untar(tar) {
  const entries = [];
  for (let at = 0; at + 512 <= tar.length;) {
    const header = tar.subarray(at, at + 512);
    if (header.every((b) => b === 0)) break;
    const field = (start, length) =>
      header
        .subarray(start, start + length)
        .toString("ascii")
        .replace(/\0.*$/s, "")
        .trim();
    const summed = [...header].reduce((sum, byte, i) => sum + (i >= 148 && i < 156 ? 32 : byte), 0);
    assert.equal(Number.parseInt(field(148, 8), 8), summed, "the header's checksum");
    assert.equal(field(257, 6), "ustar");
    const size = Number.parseInt(field(124, 12), 8);
    entries.push({
      name: field(0, 100),
      mode: Number.parseInt(field(100, 8), 8),
      uid: Number.parseInt(field(108, 8), 8),
      gid: Number.parseInt(field(116, 8), 8),
      mtime: Number.parseInt(field(136, 12), 8),
      type: field(156, 1),
      data: tar.subarray(at + 512, at + 512 + size),
    });
    at += 512 + Math.ceil(size / 512) * 512;
  }
  return entries;
}

test("the runner's layer is the binary alone, at its path and mode, owned by root", () => {
  const binary = Buffer.from("\x7fELF a runner, of a length that is not a whole block");
  const layer = runnerLayer(binary, { mtime: 1_760_000_000 });
  const tar = gunzipSync(layer.bytes);
  assert.equal(tar.length % 512, 0);
  assert.equal(layer.digest, sha256(layer.bytes));
  assert.equal(layer.size, layer.bytes.length);
  assert.equal(layer.diffId, sha256(tar));
  const entries = untar(tar);
  assert.equal(entries.length, 1);
  const [entry] = entries;
  assert.deepEqual(
    { name: entry.name, mode: entry.mode, uid: entry.uid, gid: entry.gid, mtime: entry.mtime, type: entry.type },
    { name: "usr/local/bin/g1t-runner", mode: 0o755, uid: 0, gid: 0, mtime: 1_760_000_000, type: "0" },
  );
  assert.ok(entry.data.equals(binary));
  // The same bytes make the same layer.
  assert.equal(runnerLayer(binary, { mtime: 1_760_000_000 }).digest, layer.digest);
  // An exact number of blocks, and an empty file.
  assert.equal(untar(tarOf("a", Buffer.alloc(512, 1)))[0].data.length, 512);
  assert.equal(untar(tarOf("a", Buffer.alloc(0)))[0].data.length, 0);
});

test("the layer and entrypoint are what services/runner/Dockerfile builds", () => {
  const dockerfile = readFileSync(join(ROOT, "services/runner/Dockerfile"), "utf8");
  const copy = /^COPY --chmod=(\d+) g1t-runner (\S+)$/m.exec(dockerfile);
  assert.ok(copy, "the Dockerfile copies the binary in");
  assert.equal(Number.parseInt(copy[1], 8), RUNNER_BINARY_MODE);
  assert.equal(copy[2], `/${RUNNER_BINARY_PATH}`);
  const entrypoint = /^ENTRYPOINT (.+)$/m.exec(dockerfile);
  assert.deepEqual(JSON.parse(entrypoint[1]), RUNNER_ENTRYPOINT);
  // Nothing else that would change the image.
  const instructions = dockerfile
    .split(/\r?\n/)
    .filter((line) => line.trim() && !line.startsWith("#"))
    .map((line) => line.split(" ")[0]);
  assert.deepEqual(instructions, ["ARG", "FROM", "COPY", "ENTRYPOINT"]);
});

const BASE_CONFIG = {
  architecture: "amd64",
  os: "linux",
  created: "2026-10-08T19:50:00Z",
  config: { Env: ["PATH=/usr/local/bin:/usr/bin"], Cmd: ["bash"], WorkingDir: "/home/runner", User: "root" },
  rootfs: { type: "layers", diff_ids: ["sha256:" + "1".repeat(64), "sha256:" + "2".repeat(64)] },
  history: [{ created_by: "FROM debian" }, { created_by: "RUN apt-get install" }],
};

test("the config is the base's, with the layer, the entrypoint and no inherited command", () => {
  const before = structuredClone(BASE_CONFIG);
  const diffId = "sha256:" + "3".repeat(64);
  const config = runnerConfig(BASE_CONFIG, { diffId, created: "2026-10-13T00:00:00.000Z" });
  assert.deepEqual(BASE_CONFIG, before, "the base's config is left as it was");
  assert.deepEqual(config.config.Entrypoint, ["g1t-runner"]);
  assert.equal(config.config.Cmd, undefined);
  assert.deepEqual(config.config.Env, BASE_CONFIG.config.Env);
  assert.equal(config.config.WorkingDir, "/home/runner");
  assert.deepEqual(config.rootfs.diff_ids, [...BASE_CONFIG.rootfs.diff_ids, diffId]);
  assert.equal(config.created, "2026-10-13T00:00:00.000Z");
  // History: one entry per layer, plus one that adds none.
  assert.equal(config.history.filter((h) => !h.empty_layer).length - BASE_CONFIG.history.length, 1);
  assert.equal(config.history.at(-1).empty_layer, true);
  assert.throws(() => runnerConfig({ ...BASE_CONFIG, architecture: "arm64" }, { diffId, created: "x" }), /linux\/amd64/);
});

test("the manifest names the base's layers, then the binary's, in the base's format", () => {
  const layers = [
    { mediaType: "application/vnd.docker.image.rootfs.diff.tar.gzip", digest: "sha256:" + "a".repeat(64), size: 10 },
    { mediaType: "application/vnd.docker.image.rootfs.diff.tar.gzip", digest: "sha256:" + "b".repeat(64), size: 20 },
  ];
  const config = { digest: "sha256:" + "c".repeat(64), size: 5 };
  const layer = { digest: "sha256:" + "d".repeat(64), size: 7 };
  const docker = runnerManifest(
    { schemaVersion: 2, mediaType: DOCKER_MANIFEST, config: { mediaType: "application/vnd.docker.container.image.v1+json", digest: "x", size: 1 }, layers },
    { config, layer },
  );
  assert.deepEqual(docker, {
    schemaVersion: 2,
    mediaType: DOCKER_MANIFEST,
    config: { mediaType: "application/vnd.docker.container.image.v1+json", ...config },
    layers: [...layers, { mediaType: "application/vnd.docker.image.rootfs.diff.tar.gzip", ...layer }],
  });
  // OCI, with its type left unsaid.
  const oci = runnerManifest(
    { schemaVersion: 2, config: { mediaType: "application/vnd.oci.image.config.v1+json", digest: "x", size: 1 }, layers: [], annotations: { a: "b" } },
    { config, layer },
  );
  assert.equal(oci.mediaType, OCI_MANIFEST);
  assert.deepEqual(oci.layers, [{ mediaType: "application/vnd.oci.image.layer.v1.tar+gzip", ...layer }]);
  assert.equal(oci.annotations, undefined);
});

test("image references and bearer challenges are read", () => {
  const digest = "sha256:" + "e".repeat(64);
  assert.deepEqual(parseRef("registry.cloudflare.com/acct/g1t-runner:abc"), {
    host: "registry.cloudflare.com",
    name: "acct/g1t-runner",
    tag: "abc",
    digest: null,
  });
  assert.deepEqual(parseRef(`localhost:5000/g1t-runner:base-1@${digest}`), { host: "localhost:5000", name: "g1t-runner", tag: "base-1", digest });
  assert.deepEqual(parseRef(`r.example/x@${digest}`), { host: "r.example", name: "x", tag: null, digest });
  assert.throws(() => parseRef("r.example/x"));
  assert.deepEqual(bearerChallenge('Bearer realm="https://auth.example/token",service="registry",scope="repository:x:pull"'), {
    realm: "https://auth.example/token",
    service: "registry",
    scope: "repository:x:pull",
  });
  assert.equal(bearerChallenge('Basic realm="x"'), null);
  assert.equal(bearerChallenge(null), null);
});

/** A registry in memory: one repository, Basic auth, uploads by POST, PATCH and PUT. */
function fakeRegistry({ name, auth = "Basic " + Buffer.from("u:p").toString("base64") }) {
  const blobs = new Map();
  const manifests = new Map();
  const uploads = new Map();
  const calls = [];
  let next = 0;
  const reply = (status, { headers = {}, body = null } = {}) => ({
    status,
    ok: status >= 200 && status < 300,
    headers: new Headers(headers),
    arrayBuffer: async () => (body ? body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) : new ArrayBuffer(0)),
    text: async () => (body ? body.toString("utf8") : ""),
    json: async () => JSON.parse(body.toString("utf8")),
  });
  const fetchImpl = async (url, init) => {
    const { pathname, searchParams } = new URL(url);
    calls.push(`${init.method} ${pathname}`);
    if (init.headers.authorization !== auth) return reply(401);
    const prefix = `/v2/${name}/`;
    if (!pathname.startsWith(prefix)) return reply(404);
    const path = pathname.slice(prefix.length);
    let match;
    if ((match = /^manifests\/(.+)$/.exec(path))) {
      if (init.method === "PUT") {
        const bytes = Buffer.from(init.body);
        const digest = sha256(bytes);
        for (const ref of [...JSON.parse(bytes).layers, JSON.parse(bytes).config]) {
          if (!blobs.has(ref.digest)) return reply(400, { body: Buffer.from('{"errors":[{"code":"MANIFEST_BLOB_UNKNOWN"}]}') });
        }
        manifests.set(match[1], { bytes, type: init.headers["content-type"] });
        manifests.set(digest, { bytes, type: init.headers["content-type"] });
        return reply(201, { headers: { "docker-content-digest": digest } });
      }
      const found = manifests.get(match[1]);
      return found ? reply(200, { headers: { "content-type": found.type }, body: found.bytes }) : reply(404);
    }
    if ((match = /^blobs\/(sha256:[0-9a-f]{64})$/.exec(path))) {
      const found = blobs.get(match[1]);
      if (!found) return reply(404);
      return init.method === "HEAD" ? reply(200) : reply(200, { body: found });
    }
    if (path === "blobs/uploads/" && init.method === "POST") {
      const id = `u${next++}`;
      uploads.set(id, Buffer.alloc(0));
      return reply(202, { headers: { location: `${prefix}blobs/uploads/${id}` } });
    }
    if ((match = /^blobs\/uploads\/(u\d+)$/.exec(path))) {
      const id = match[1];
      if (init.method === "PATCH") {
        uploads.set(id, Buffer.concat([uploads.get(id), Buffer.from(init.body)]));
        return reply(202, { headers: { location: `${prefix}blobs/uploads/${id}?state=1` } });
      }
      if (init.method === "PUT") {
        const bytes = uploads.get(id);
        if (sha256(bytes) !== searchParams.get("digest")) return reply(400);
        blobs.set(searchParams.get("digest"), bytes);
        return reply(201);
      }
    }
    return reply(405);
  };
  return { blobs, manifests, calls, fetchImpl };
}

test("the runner's image is made in the registry from the base's manifest and one new layer, pulling none of the base", async () => {
  const registry = fakeRegistry({ name: "acct/g1t-runner" });
  // The base, as `docker push` left it.
  const layerBlobs = [Buffer.from("base layer one"), Buffer.from("base layer two")];
  for (const blob of layerBlobs) registry.blobs.set(sha256(blob), blob);
  const configBytes = Buffer.from(JSON.stringify(BASE_CONFIG));
  registry.blobs.set(sha256(configBytes), configBytes);
  const baseManifest = Buffer.from(
    JSON.stringify({
      schemaVersion: 2,
      mediaType: OCI_MANIFEST,
      config: { mediaType: "application/vnd.oci.image.config.v1+json", digest: sha256(configBytes), size: configBytes.length },
      layers: layerBlobs.map((blob) => ({ mediaType: "application/vnd.oci.image.layer.v1.tar+gzip", digest: sha256(blob), size: blob.length })),
    }),
  );
  registry.manifests.set(sha256(baseManifest), { bytes: baseManifest, type: OCI_MANIFEST });
  const base = `registry.cloudflare.com/acct/g1t-runner:base-20261008-a314499af03b@${sha256(baseManifest)}`;
  const ref = "registry.cloudflare.com/acct/g1t-runner:0123456789abcdef";
  const binary = Buffer.from("the runner binary");
  const credentials = async () => ({ username: "u", password: "p" });

  const digest = await appendRunnerImage({ ref, base, binary, credentials, fetchImpl: registry.fetchImpl, created: "2026-10-13T00:00:00.000Z" });
  const made = registry.manifests.get("0123456789abcdef");
  assert.equal(sha256(made.bytes), digest);
  assert.equal(made.type, OCI_MANIFEST);
  const manifest = JSON.parse(made.bytes);
  assert.deepEqual(
    manifest.layers.slice(0, 2).map((l) => l.digest),
    layerBlobs.map(sha256),
  );
  assert.equal(manifest.layers.length, 3);
  const config = JSON.parse(registry.blobs.get(manifest.config.digest));
  assert.deepEqual(config.config.Entrypoint, ["g1t-runner"]);
  assert.equal(config.rootfs.diff_ids.at(-1), sha256(gunzipSync(registry.blobs.get(manifest.layers[2].digest))));
  assert.ok(untar(gunzipSync(registry.blobs.get(manifest.layers[2].digest)))[0].data.equals(binary));
  // The base's layers were asked about, never downloaded.
  for (const blob of layerBlobs) assert.ok(!registry.calls.includes(`GET /v2/acct/g1t-runner/blobs/${sha256(blob)}`));

  // Made again: the layer is already there, so only the config and manifest are written.
  const before = registry.calls.length;
  await appendRunnerImage({ ref, base, binary, credentials, fetchImpl: registry.fetchImpl, created: "2026-10-13T00:00:00.000Z" });
  assert.ok(!registry.calls.slice(before).some((call) => call.startsWith("PATCH")));
});

test("a manifest is asked for by tag or digest, and one that is not there is no error", async () => {
  const registry = fakeRegistry({ name: "acct/r" });
  const bytes = Buffer.from(JSON.stringify({ schemaVersion: 2, layers: [] }));
  registry.manifests.set(sha256(bytes), { bytes, type: OCI_MANIFEST });
  const client = repositoryClient("r.example", "acct/r", { credentials: async () => ({ username: "u", password: "p" }), fetchImpl: registry.fetchImpl });
  assert.equal(await client.hasManifest(sha256(bytes)), true);
  assert.equal(await client.hasManifest("sha256:" + "0".repeat(64)), false);
  assert.ok(
    registry.calls.every((call) => call.startsWith("HEAD ")),
    "nothing is downloaded",
  );
  const refused = repositoryClient("r.example", "acct/r", { credentials: async () => ({ username: "u", password: "no" }), fetchImpl: registry.fetchImpl });
  await assert.rejects(refused.hasManifest(sha256(bytes)), /401/);
});

test("a base that is not where it should be, or not what base.json says, stops it", async () => {
  const registry = fakeRegistry({ name: "acct/g1t-runner" });
  const credentials = async () => ({ username: "u", password: "p" });
  const digest = "sha256:" + "f".repeat(64);
  const options = { binary: Buffer.from("x"), credentials, fetchImpl: registry.fetchImpl, attempts: 1 };
  await assert.rejects(
    appendRunnerImage({ ...options, ref: "registry.cloudflare.com/acct/g1t-runner:t", base: `registry.cloudflare.com/acct/other:b@${digest}` }),
    /not in the runner's repository/,
  );
  await assert.rejects(
    appendRunnerImage({ ...options, ref: "registry.cloudflare.com/acct/g1t-runner:t", base: `registry.cloudflare.com/acct/g1t-runner:b@${digest}` }),
    /404/,
  );
  // Wrong credentials: the registry's answer is the error.
  await assert.rejects(
    appendRunnerImage({
      ...options,
      credentials: async () => ({ username: "u", password: "wrong" }),
      ref: "registry.cloudflare.com/acct/g1t-runner:t",
      base: `registry.cloudflare.com/acct/g1t-runner:b@${digest}`,
    }),
    /401/,
  );
});

test("a registry that asks for a bearer token is given the one its realm trades the credentials for", async () => {
  const registry = fakeRegistry({ name: "acct/r", auth: "Bearer tok" });
  const inner = registry.fetchImpl;
  const asked = [];
  const fetchImpl = async (url, init) => {
    if (url.startsWith("https://auth.example/")) {
      asked.push([url, init.headers.authorization]);
      return { ok: true, status: 200, json: async () => ({ token: "tok" }) };
    }
    const answer = await inner(url, init);
    if (answer.status === 401) answer.headers.set("www-authenticate", 'Bearer realm="https://auth.example/token",service="r.example"');
    return answer;
  };
  const config = Buffer.from(JSON.stringify(BASE_CONFIG));
  registry.blobs.set(sha256(config), config);
  const manifest = Buffer.from(
    JSON.stringify({
      schemaVersion: 2,
      mediaType: DOCKER_MANIFEST,
      config: { mediaType: "application/vnd.docker.container.image.v1+json", digest: sha256(config), size: config.length },
      layers: [],
    }),
  );
  registry.manifests.set("base", { bytes: manifest, type: DOCKER_MANIFEST });
  await appendRunnerImage({
    ref: "r.example/acct/r:new",
    base: "r.example/acct/r:base",
    binary: Buffer.from("x"),
    credentials: async () => ({ username: "u", password: "p" }),
    fetchImpl,
  });
  assert.ok(registry.manifests.has("new"));
  assert.equal(asked.length, 1, "one token, kept");
  assert.equal(asked[0][0], "https://auth.example/token?service=r.example&scope=repository%3Aacct%2Fr%3Apull%2Cpush");
  assert.equal(asked[0][1], `Basic ${Buffer.from("u:p").toString("base64")}`);
});

/**
 * Two registries in memory: `from` has an image, `to` refuses a request
 * over `limit` bytes (413) as g1t.sh refuses one over 100 MB, and keeps
 * what an upload's chunks add up to once it is finished by its digest.
 */
function twoRegistries({ limit }) {
  const config = Buffer.from('{"architecture":"amd64"}');
  const big = Buffer.alloc(250, 7);
  const manifest = Buffer.from(
    JSON.stringify({
      schemaVersion: 2,
      mediaType: OCI_MANIFEST,
      config: { digest: sha256(config), size: config.length },
      layers: [{ digest: sha256(big), size: big.length }],
    }),
  );
  const source = new Map([
    [sha256(config), config],
    [sha256(big), big],
  ]);
  const kept = new Map();
  const manifests = new Map();
  const uploads = new Map();
  const requests = [];
  const fetchImpl = async (url, init) => {
    const { host, pathname, searchParams } = new URL(url);
    const body = init.body ? Buffer.from(init.body) : Buffer.alloc(0);
    requests.push([host, init.method, pathname, body.length]);
    const answer = (status, headers = {}, bytes) => new Response(bytes ?? null, { status, headers });
    if (host === "from.test") {
      if (pathname.endsWith(`/manifests/${sha256(manifest)}`)) return answer(200, { "content-type": OCI_MANIFEST }, manifest);
      const blob = source.get(pathname.split("/blobs/")[1]);
      return blob ? answer(200, {}, blob) : answer(404);
    }
    if (init.method === "PATCH" && body.length > limit) return answer(413);
    if (init.method === "HEAD") return answer(kept.has(pathname.split("/blobs/")[1]) ? 200 : 404);
    if (init.method === "POST") {
      const id = `u${uploads.size}`;
      uploads.set(id, []);
      return answer(202, { location: `/v2/img/blobs/uploads/${id}` });
    }
    const id = pathname.split("/uploads/")[1];
    if (init.method === "PATCH") {
      const [start] = init.headers["content-range"].split("-").map(Number);
      const parts = uploads.get(id);
      assert.equal(
        start,
        parts.reduce((n, part) => n + part.length, 0),
        "each chunk starts where the last ended",
      );
      parts.push(body);
      return answer(202, { location: `/v2/img/blobs/uploads/${id}` });
    }
    if (init.method === "PUT" && id) {
      kept.set(searchParams.get("digest"), Buffer.concat(uploads.get(id)));
      return answer(201);
    }
    if (init.method === "PUT") {
      manifests.set(pathname.split("/manifests/")[1], body);
      return answer(201);
    }
    return answer(400);
  };
  const credentials = async () => null;
  return {
    from: repositoryClient("from.test", "img", { credentials, fetchImpl }),
    to: repositoryClient("to.test", "img", { credentials, fetchImpl }),
    digest: sha256(manifest),
    manifest,
    source,
    kept,
    manifests,
    requests,
  };
}

test("an image is copied registry to registry in chunks under the target's request limit, exactly", async () => {
  const r = twoRegistries({ limit: 100 });
  assert.equal(await copyImage({ from: r.from, to: r.to, digest: r.digest, tag: "base-1", chunkSize: 100 }), r.digest);
  for (const [digest, bytes] of r.source) assert.deepEqual(r.kept.get(digest), bytes, `${digest} as it was`);
  assert.deepEqual(r.manifests.get("base-1"), r.manifest, "the manifest's own bytes, so the same digest");
  const patches = r.requests.filter(([host, method]) => host === "to.test" && method === "PATCH").map(([, , , n]) => n);
  assert.deepEqual(patches, [24, 100, 100, 50], "the config whole, the layer in three chunks");
  // A second copy finds every blob there and sends none.
  r.requests.length = 0;
  await copyImage({ from: r.from, to: r.to, digest: r.digest, tag: "base-1", chunkSize: 100 });
  assert.ok(!r.requests.some(([, method]) => method === "PATCH"));
});

test("a copy whose chunks are over the target's limit fails, and finishes no blob", async () => {
  const r = twoRegistries({ limit: 100 });
  await assert.rejects(copyImage({ from: r.from, to: r.to, digest: r.digest, tag: "base-1", chunkSize: 200, attempts: 1 }), /413/);
  assert.ok(!r.manifests.has("base-1"));
});
