// The runner's image made in the registry, with no Docker: the base's
// manifest and config are read from Cloudflare's registry, one layer
// holding the runner binary is uploaded beside the base's layers, and a
// new config and manifest that name the base's layers and that one are
// written under the runner's tag. Nothing of the base is downloaded, so a
// deploy job needs no room for the 4.5 GB base, which a `docker build`
// pulls and unpacks on the same disk the job runs on.
//
// What it makes is what services/runner/Dockerfile builds on the same
// base: the binary at /usr/local/bin/g1t-runner with mode 0755 (COPY
// --chmod=0755), ENTRYPOINT ["g1t-runner"] with the base's CMD cleared
// (as a Dockerfile's ENTRYPOINT clears an inherited one), for linux/amd64.
// A test holds the Dockerfile to these.
//
// The calls are the OCI distribution API (docs.docker.com/registry/spec/api/),
// as `docker push` makes them: HEAD a blob to skip one already there; POST
// to start an upload, PATCH its bytes, PUT with its digest to finish; PUT
// the manifest by tag.

import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";

export const RUNNER_BINARY_PATH = "usr/local/bin/g1t-runner";
export const RUNNER_BINARY_MODE = 0o755;
export const RUNNER_ENTRYPOINT = ["g1t-runner"];

export const OCI_MANIFEST = "application/vnd.oci.image.manifest.v1+json";
export const DOCKER_MANIFEST = "application/vnd.docker.distribution.manifest.v2+json";
const OCI_INDEX = "application/vnd.oci.image.index.v1+json";
const DOCKER_LIST = "application/vnd.docker.distribution.manifest.list.v2+json";
const ACCEPT = [OCI_MANIFEST, DOCKER_MANIFEST, OCI_INDEX, DOCKER_LIST].join(", ");

/** Each manifest type's gzipped layer type. */
const LAYER_TYPE = {
  [OCI_MANIFEST]: "application/vnd.oci.image.layer.v1.tar+gzip",
  [DOCKER_MANIFEST]: "application/vnd.docker.image.rootfs.diff.tar.gzip",
};

export const sha256 = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

/** What one upload request carries at most: under g1t.sh's 100 MB, as `g1t push` sends. */
export const CHUNK_BYTES = 90 * 1024 * 1024;

const isIndex = (json) => [OCI_INDEX, DOCKER_LIST].includes(json.mediaType) || Array.isArray(json.manifests);

/**
 * Copies the image `digest` from one repository (`from`, a
 * repositoryClient) to another (`to`) exactly: each blob the target lacks
 * streams across in chunks (`putBlobChunked`), nothing is kept on the
 * machine, and the manifest's own bytes are written, so the target has
 * the same digest. An index's images go first, by digest. Writes the top
 * manifest under `tag`. A blob that fails is tried again from its start.
 */
export async function copyImage({ from, to, digest, tag, onLine = () => {}, attempts = 3, chunkSize = CHUNK_BYTES }) {
  const copyBlob = async (blob) => {
    if (await to.hasBlob(blob.digest)) return;
    const size = blob.size ? ` (${(blob.size / 1e6).toFixed(1)} MB)` : "";
    for (let attempt = 1; ; attempt += 1) {
      try {
        const started = Date.now();
        const response = await from.blobStream(blob.digest);
        const sent = await to.putBlobChunked(response.body, blob.digest, { chunkSize });
        onLine(`  ${blob.digest.slice(0, 19)}${size}: ${Math.ceil(sent / chunkSize) || 1} chunk(s) in ${Math.round((Date.now() - started) / 1000)}s`);
        return;
      } catch (error) {
        if (attempt >= attempts) throw error;
        onLine(`  ${blob.digest.slice(0, 19)}: ${error.message ?? error}; trying again`);
      }
    }
  };
  const copyManifest = async (reference, writeAs) => {
    const manifest = await from.manifest(reference);
    if (manifest.digest !== reference && reference.startsWith("sha256:")) {
      throw new Error(`${from.name}@${reference} came back as ${manifest.digest}`);
    }
    if (isIndex(manifest.json)) {
      for (const child of manifest.json.manifests) await copyManifest(child.digest, child.digest);
    } else {
      for (const blob of [manifest.json.config, ...manifest.json.layers]) await copyBlob(blob);
    }
    const type = manifest.json.mediaType ?? manifestType(manifest.json);
    await to.putManifest(writeAs, manifest.bytes, type);
    return manifest.digest;
  };
  return copyManifest(digest, tag);
}

/** A tar header field: octal, zero-padded, ending in NUL. */
function octal(value, width) {
  return `${value.toString(8).padStart(width - 1, "0")}\0`;
}

/**
 * A tar archive (ustar) of one regular file, owned by root. Only the file:
 * its folders are the base's, so a layer that names them would replace
 * their owner, mode and time with its own.
 */
export function tarOf(path, data, { mode = 0o644, mtime = 0 } = {}) {
  if (Buffer.byteLength(path) > 100) throw new Error(`a path this layer cannot hold: ${path}`);
  const header = Buffer.alloc(512);
  header.write(path, 0, 100, "utf8");
  header.write(octal(mode, 8), 100, 8, "ascii");
  header.write(octal(0, 8), 108, 8, "ascii"); // uid
  header.write(octal(0, 8), 116, 8, "ascii"); // gid
  header.write(octal(data.length, 12), 124, 12, "ascii");
  header.write(octal(Math.floor(mtime), 12), 136, 12, "ascii");
  header.write("        ", 148, 8, "ascii"); // the checksum, as spaces while it is summed
  header.write("0", 156, 1, "ascii"); // a regular file
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  header.write("root", 265, 32, "ascii");
  header.write("root", 297, 32, "ascii");
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  const padding = Buffer.alloc((512 - (data.length % 512)) % 512);
  return Buffer.concat([header, data, padding, Buffer.alloc(1024)]);
}

/**
 * The runner's layer: the binary at its path and mode, gzipped. Returns
 * the compressed bytes with their digest and size, and the uncompressed
 * tar's digest (the config's diff_id).
 */
export function runnerLayer(binary, { mtime = 0 } = {}) {
  const tar = tarOf(RUNNER_BINARY_PATH, binary, { mode: RUNNER_BINARY_MODE, mtime });
  const bytes = gzipSync(tar, { level: 9 });
  return { bytes, digest: sha256(bytes), size: bytes.length, diffId: sha256(tar) };
}

/**
 * The runner image's config from the base's: one more layer, the
 * entrypoint, and the history a Dockerfile build would add.
 */
export function runnerConfig(base, { diffId, created }) {
  if (base.os !== "linux" || base.architecture !== "amd64") {
    throw new Error(`the base is ${base.os}/${base.architecture}, not linux/amd64`);
  }
  const config = structuredClone(base);
  config.created = created;
  config.config = { ...(config.config ?? {}), Entrypoint: [...RUNNER_ENTRYPOINT] };
  // An ENTRYPOINT clears the CMD a Dockerfile inherited.
  delete config.config.Cmd;
  config.rootfs = { type: "layers", diff_ids: [...(base.rootfs?.diff_ids ?? []), diffId] };
  config.history = [
    ...(base.history ?? []),
    { created, created_by: `COPY --chmod=0755 g1t-runner /${RUNNER_BINARY_PATH} # g1t deploy`, comment: "scripts/deploy/registry.mjs" },
    { created, created_by: `ENTRYPOINT ${JSON.stringify(RUNNER_ENTRYPOINT)}`, comment: "scripts/deploy/registry.mjs", empty_layer: true },
  ];
  return config;
}

/** The runner image's manifest: the base's layers, then the runner's. */
export function runnerManifest(base, { config, layer }) {
  const type = manifestType(base);
  if (!LAYER_TYPE[type]) throw new Error(`a manifest of a type this cannot extend: ${type}`);
  const manifest = {
    schemaVersion: 2,
    mediaType: type,
    config: { mediaType: base.config.mediaType, digest: config.digest, size: config.size },
    layers: [...base.layers, { mediaType: LAYER_TYPE[type], digest: layer.digest, size: layer.size }],
  };
  return manifest;
}

/** A manifest's type: its own, or (OCI lets it go unsaid) its config's. */
export function manifestType(manifest) {
  return manifest.mediaType ?? (manifest.config?.mediaType === "application/vnd.oci.image.config.v1+json" ? OCI_MANIFEST : DOCKER_MANIFEST);
}

/** A `WWW-Authenticate: Bearer realm=...,service=...,scope=...` challenge, or null. */
export function bearerChallenge(header) {
  if (!header || !/^bearer\s/i.test(header)) return null;
  const params = Object.fromEntries([...header.slice(7).matchAll(/(\w+)="([^"]*)"/g)].map((m) => [m[1].toLowerCase(), m[2]]));
  return params.realm ? params : null;
}

/** `host/name:tag`, `host/name@digest` or `host/name:tag@digest`, split. */
export function parseRef(ref) {
  const match = /^([^/]+)\/(.+?)(?::([^:/@]+))?(?:@(sha256:[0-9a-f]{64}))?$/.exec(ref);
  if (!match || (!match[3] && !match[4])) throw new Error(`not an image reference with a tag or digest: ${ref}`);
  const [, host, name, tag, digest] = match;
  return { host, name, tag: tag ?? null, digest: digest ?? null };
}

/**
 * A client for one repository: requests carry Basic auth from
 * `credentials` (none when it returns null), or the bearer token a
 * registry that asks for one gives for them; paths are under /v2/<name>/.
 */
export function repositoryClient(host, name, { credentials, fetchImpl = fetch, scheme = "https" }) {
  const root = `${scheme}://${host}`;
  let bearer = null;
  const basic = async () => {
    const auth = await credentials();
    return auth ? `Basic ${Buffer.from(`${auth.username}:${auth.password}`).toString("base64")}` : null;
  };
  const once = async (method, url, headers, body) => {
    const authorization = bearer ? `Bearer ${bearer}` : await basic();
    return fetchImpl(new URL(url, root).toString(), { method, headers: authorization ? { ...headers, authorization } : headers, body });
  };
  const send = async (method, url, { headers = {}, body } = {}) => {
    const response = await once(method, url, headers, body);
    const challenge = response.status === 401 ? bearerChallenge(response.headers.get("www-authenticate")) : null;
    if (!challenge) return response;
    // The token flow: the realm trades the credentials for a token.
    const realm = new URL(challenge.realm);
    if (challenge.service) realm.searchParams.set("service", challenge.service);
    realm.searchParams.set("scope", challenge.scope ?? `repository:${name}:pull,push`);
    const authorization = await basic();
    const got = await fetchImpl(realm.toString(), { method: "GET", headers: authorization ? { authorization } : {} });
    if (!got.ok) return response;
    const json = await got.json();
    bearer = json.token ?? json.access_token ?? null;
    return bearer ? once(method, url, headers, body) : response;
  };
  const at = (path) => `${root}/v2/${name}/${path}`;
  const fail = async (what, response) => {
    let detail = "";
    try {
      detail = (await response.text()).slice(0, 500);
    } catch {}
    return new Error(`${what}: the registry answered ${response.status}${detail ? ` ${detail}` : ""}`);
  };
  return {
    name,
    async manifest(reference) {
      const response = await send("GET", at(`manifests/${reference}`), { headers: { accept: ACCEPT } });
      if (!response.ok) throw await fail(`reading ${name} ${reference}`, response);
      const bytes = Buffer.from(await response.arrayBuffer());
      return { bytes, digest: sha256(bytes), json: JSON.parse(bytes.toString("utf8")) };
    },
    /** Whether the repository has a manifest by that tag or digest. */
    async hasManifest(reference) {
      const response = await send("HEAD", at(`manifests/${reference}`), { headers: { accept: ACCEPT } });
      if (response.status === 404) return false;
      if (!response.ok) throw await fail(`asking for ${name} ${reference}`, response);
      return true;
    },
    async blob(digest) {
      const response = await send("GET", at(`blobs/${digest}`));
      if (!response.ok) throw await fail(`reading blob ${digest}`, response);
      const bytes = Buffer.from(await response.arrayBuffer());
      if (sha256(bytes) !== digest) throw new Error(`blob ${digest} came back as ${sha256(bytes)}`);
      return bytes;
    },
    async hasBlob(digest) {
      const response = await send("HEAD", at(`blobs/${digest}`));
      if (response.status === 404) return false;
      if (!response.ok) throw await fail(`asking for blob ${digest}`, response);
      return true;
    },
    /** Uploads `bytes` unless the repository has them. Returns whether it did. */
    async putBlob(bytes, digest = sha256(bytes)) {
      if (await this.hasBlob(digest)) return false;
      const started = await send("POST", at("blobs/uploads/"));
      if (started.status !== 202) throw await fail(`starting an upload of ${digest}`, started);
      const location = started.headers.get("location");
      if (!location) throw new Error(`the registry started an upload of ${digest} without saying where`);
      const patched = await send("PATCH", location, {
        headers: { "content-type": "application/octet-stream" },
        body: bytes,
      });
      if (patched.status !== 202) throw await fail(`uploading ${digest}`, patched);
      const done = new URL(patched.headers.get("location") ?? location, root);
      done.searchParams.set("digest", digest);
      const put = await send("PUT", done.toString());
      if (put.status !== 201) throw await fail(`finishing the upload of ${digest}`, put);
      return true;
    },
    /** A blob as it streams: the registry's response, whose `body` is its bytes. */
    async blobStream(digest) {
      const response = await send("GET", at(`blobs/${digest}`));
      if (!response.ok || !response.body) throw await fail(`reading blob ${digest}`, response);
      return response;
    },
    /**
     * Uploads a blob from `body` (bytes as they stream) in chunks of
     * `chunkSize`, each its own request, as `g1t push` does: g1t.sh takes
     * at most 100 MB a request, and a layer is often more. The bytes are
     * hashed as they go, and a blob that isn't `digest` is never finished.
     */
    async putBlobChunked(body, digest, { chunkSize = CHUNK_BYTES, onChunk = () => {} } = {}) {
      const started = await send("POST", at("blobs/uploads/"));
      if (started.status !== 202) throw await fail(`starting an upload of ${digest}`, started);
      let location = started.headers.get("location");
      if (!location) throw new Error(`the registry started an upload of ${digest} without saying where`);
      const hash = createHash("sha256");
      let offset = 0;
      let held = Buffer.alloc(0);
      const patch = async (chunk) => {
        const patched = await send("PATCH", location, {
          headers: { "content-type": "application/octet-stream", "content-range": `${offset}-${offset + chunk.length - 1}` },
          body: chunk,
        });
        if (patched.status !== 202) throw await fail(`uploading ${digest} at byte ${offset}`, patched);
        location = new URL(patched.headers.get("location") ?? location, root).toString();
        offset += chunk.length;
        onChunk(offset);
      };
      for await (const piece of body) {
        hash.update(piece);
        held = held.length ? Buffer.concat([held, piece]) : Buffer.from(piece);
        while (held.length >= chunkSize) {
          await patch(held.subarray(0, chunkSize));
          held = held.subarray(chunkSize);
        }
      }
      if (held.length) await patch(held);
      const got = `sha256:${hash.digest("hex")}`;
      if (got !== digest) throw new Error(`blob ${digest} came as ${got}: not finishing its upload`);
      const done = new URL(location, root);
      done.searchParams.set("digest", digest);
      const put = await send("PUT", done.toString());
      if (put.status !== 201) throw await fail(`finishing the upload of ${digest}`, put);
      return offset;
    },
    async putManifest(tag, bytes, type) {
      const response = await send("PUT", at(`manifests/${tag}`), { headers: { "content-type": type }, body: bytes });
      if (response.status !== 201) throw await fail(`writing ${name}:${tag}`, response);
      return response.headers.get("docker-content-digest");
    },
  };
}

/**
 * Makes the runner's image `ref` in the registry from the base `base` (by
 * digest, as base.json records it) and the binary's bytes. Returns the new
 * manifest's digest. The base must be in the same registry; its layers
 * are named, not copied, so it must be in the same repository too.
 */
export async function appendRunnerImage({
  ref,
  base,
  binary,
  credentials,
  fetchImpl = fetch,
  scheme = "https",
  created = new Date().toISOString(),
  onLine = () => {},
  attempts = 3,
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  const target = parseRef(ref);
  const from = parseRef(base);
  if (!target.tag) throw new Error(`the runner's image needs a tag: ${ref}`);
  if (from.host !== target.host || from.name !== target.name) {
    throw new Error(`the base ${base} is not in the runner's repository ${target.host}/${target.name}`);
  }
  const client = repositoryClient(target.host, target.name, { credentials, fetchImpl, scheme });

  let manifest = await client.manifest(from.digest ?? from.tag);
  if (from.digest && manifest.digest !== from.digest) throw new Error(`the base's manifest came back as ${manifest.digest}, not ${from.digest}`);
  const listed = manifest.json.mediaType;
  if (listed === OCI_INDEX || listed === DOCKER_LIST) {
    // An index: its linux/amd64 image, as `docker build --platform linux/amd64` would pick.
    const entry = manifest.json.manifests.find((m) => m.platform?.os === "linux" && m.platform?.architecture === "amd64");
    if (!entry) throw new Error(`the base ${base} has no linux/amd64 image`);
    manifest = await client.manifest(entry.digest);
  }
  const baseConfig = JSON.parse((await client.blob(manifest.json.config.digest)).toString("utf8"));
  // Every layer the new manifest names must be there.
  for (const layer of manifest.json.layers) {
    if (!(await client.hasBlob(layer.digest))) throw new Error(`the base's layer ${layer.digest} is not in ${target.name}`);
  }

  const layer = runnerLayer(binary, { mtime: Date.parse(created) / 1000 });
  const configBytes = Buffer.from(JSON.stringify(runnerConfig(baseConfig, { diffId: layer.diffId, created })));
  const config = { digest: sha256(configBytes), size: configBytes.length };
  const type = manifestType(manifest.json);
  const manifestBytes = Buffer.from(JSON.stringify(runnerManifest(manifest.json, { config, layer })));
  const digest = sha256(manifestBytes);

  onLine(
    `${target.tag}: the binary's layer ${layer.digest.slice(7, 19)}, ${(layer.size / 1e6).toFixed(1)} MB, on ${manifest.json.layers.length} layers of the base`,
  );
  for (let attempt = 1; ; attempt++) {
    try {
      if (await client.putBlob(layer.bytes, layer.digest)) onLine(`uploaded the binary's layer`);
      await client.putBlob(configBytes, config.digest);
      const answered = await client.putManifest(target.tag, manifestBytes, type);
      if (answered && answered !== digest) throw new Error(`the registry kept ${target.tag} as ${answered}, not ${digest}`);
      onLine(`${target.tag}: ${digest}`);
      return digest;
    } catch (error) {
      // Cloudflare's registry can answer "blob unknown" for a blob it has
      // just taken; asking again finds it there.
      if (attempt >= attempts) throw error;
      onLine(`making ${target.tag} in the registry did not finish (attempt ${attempt} of ${attempts}): ${error.message ?? error}; trying again`);
      await wait(2000 * attempt);
    }
  }
}
