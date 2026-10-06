// The Artifacts binding, for self-hosted g1t.
//
// The repos service is written against Cloudflare Artifacts' Workers
// binding (services/repos/src/store.rs). Self-hosted, its ARTIFACTS binding
// is a service binding to this Worker instead, which offers the same
// methods and keeps the repositories in the git store (gitstore/server.mjs):
// plain bare repositories on disk. Hosted g1t never runs this.
//
// Only what g1t calls is implemented: create, get and delete on the namespace;
// info, createToken, log, readCommit, readTree, readBlob, readFile and fork
// on a repository.

import { RpcTarget, WorkerEntrypoint } from "cloudflare:workers";

class ArtifactsError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ArtifactsError";
    this.code = code;
  }
}

async function store(env, path, init = {}) {
  const base = (env.GITSTORE_URL ?? "http://gitstore:8080").replace(/\/$/, "");
  const response = await fetch(`${base}/api/repos${path}`, {
    ...init,
    headers: {
      "x-gitstore-secret": env.GITSTORE_SECRET ?? "",
      ...(init.body ? { "content-type": "application/json" } : {}),
    },
  });
  return response;
}

async function json(response) {
  if (response.ok) return response.json();
  let code = "INTERNAL_ERROR";
  let message = `git store answered ${response.status}`;
  try {
    const body = await response.json();
    code = body.code ?? code;
    message = body.message ?? message;
  } catch {}
  throw new ArtifactsError(code, message);
}

/** Bytes as something with `arrayBuffer()`, the way a Blob is read. */
async function bytes(response) {
  if (response.status === 404) return null;
  if (!response.ok) await json(response);
  return new Response(await response.arrayBuffer(), {
    headers: { "content-type": response.headers.get("content-type") ?? "application/octet-stream" },
  });
}

class Repo extends RpcTarget {
  #env;
  #name;

  constructor(env, name) {
    super();
    this.#env = env;
    this.#name = name;
  }

  #path(rest = "") {
    return `/${encodeURIComponent(this.#name)}${rest}`;
  }

  async info() {
    return json(await store(this.#env, this.#path()));
  }

  async createToken(scope = "write", ttl = 86400) {
    return json(
      await store(this.#env, this.#path("/tokens"), {
        method: "POST",
        body: JSON.stringify({ scope, ttl }),
      }),
    );
  }

  async log(opts = {}) {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(opts ?? {})) {
      if (value !== undefined && value !== null) query.set(key, String(value));
    }
    return json(await store(this.#env, this.#path(`/log?${query}`)));
  }

  async readCommit(hash) {
    return json(await store(this.#env, this.#path(`/commits/${encodeURIComponent(hash)}`)));
  }

  async readTree(hash) {
    return json(await store(this.#env, this.#path(`/trees/${encodeURIComponent(hash)}`)));
  }

  async readBlob(hash) {
    return bytes(await store(this.#env, this.#path(`/blobs/${encodeURIComponent(hash)}`)));
  }

  async readFile({ ref, path }) {
    const query = new URLSearchParams({ ref, path });
    return bytes(await store(this.#env, this.#path(`/file?${query}`)));
  }

  async fork(name, opts = {}) {
    const created = await json(
      await store(this.#env, this.#path("/fork"), {
        method: "POST",
        body: JSON.stringify({ ...opts, name }),
      }),
    );
    const token = await new Repo(this.#env, name).createToken("write");
    return { ...created, token: token.plaintext };
  }
}

export default class Artifacts extends WorkerEntrypoint {
  async create(name, opts = {}) {
    const created = await json(
      await store(this.env, "", {
        method: "POST",
        body: JSON.stringify({
          name,
          description: opts?.description,
          defaultBranch: opts?.setDefaultBranch,
          readOnly: opts?.readOnly,
        }),
      }),
    );
    const token = await new Repo(this.env, name).createToken("write");
    return { ...created, token: token.plaintext };
  }

  async get(name) {
    // Artifacts answers NOT_FOUND here for a repository that does not exist.
    await json(await store(this.env, `/${encodeURIComponent(name)}`));
    return new Repo(this.env, name);
  }

  async delete(name) {
    const response = await store(this.env, `/${encodeURIComponent(name)}`, { method: "DELETE" });
    if (response.status === 404) return false;
    await json(response);
    return true;
  }

  async fetch() {
    return new Response("The Artifacts binding for self-hosted g1t. Bind to it; do not browse it.", {
      status: 404,
    });
  }
}
