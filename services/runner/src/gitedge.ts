/**
 * The git edge (#237): a container per active repository that keeps a
 * well-packed mirror of it and answers clones and fetches with real git
 * (crates/runner, `MODE=gitedge`). Cloudflare Artifacts stays the source
 * of truth and takes every push; the edge only makes clones smaller and
 * faster, and whenever it is cold, behind or failing the repos service
 * answers from Artifacts as it always did.
 *
 * The repos service reaches it through the runner Worker as
 * `/gitedge/<repo_id>/<endpoint>`, and the `GitEdge` Durable Object
 * (index.ts) of that repository answers. What each endpoint does is
 * decided here, apart from the containers library, so it can be tested on
 * its own.
 */

/** The port the edge's server listens on inside its container. */
export const GIT_EDGE_PORT = 8080;

/**
 * What the edge's container is started with: the runner binary as the
 * edge's server. It runs nobody's code, so the watch for mining
 * (crates/runner abuse.rs) is off: a long `git repack` is the edge at work.
 */
export const GIT_EDGE_ENV: Record<string, string> = {
  MODE: "gitedge",
  GITEDGE_PORT: String(GIT_EDGE_PORT),
  G1T_ABUSE: "off",
};

/**
 * What the edge answers, and the method each is asked with: a sync to a
 * version of the repository, its state, and git's two read requests. A
 * push never reaches the edge; it goes to Artifacts.
 */
const ENDPOINTS = {
  sync: "POST",
  state: "GET",
  "info/refs": "GET",
  "git-upload-pack": "POST",
} as const;
export type EdgeEndpoint = keyof typeof ENDPOINTS;

/**
 * A repository's id as the repos service makes them: a short lower-case
 * type prefix, an underscore and a base32 suffix (`rep_01jb2k7x…`). Its
 * Durable Object is named by it, so nothing else names one.
 */
const REPO_ID = /^[a-z]{1,16}_[0-9a-z]{1,64}$/;

/** A request to the edge, as the runner Worker was asked it. */
export type EdgeRoute = { repoId: string; endpoint: EdgeEndpoint };

/**
 * The repository and endpoint `/gitedge/<repo_id>/<endpoint>` names, when
 * it names one the edge answers with the method it is answered for, and
 * `info/refs` asks for upload-pack. Null for anything else, which is not
 * found.
 */
export function edgeRoute(method: string, url: URL): EdgeRoute | null {
  const match = /^\/gitedge\/([^/]+)\/(.+)$/.exec(url.pathname);
  if (!match) return null;
  const [, repoId, endpoint] = match as unknown as [string, string, string];
  if (!REPO_ID.test(repoId) || !Object.hasOwn(ENDPOINTS, endpoint)) return null;
  const known = endpoint as EdgeEndpoint;
  if (method.toUpperCase() !== ENDPOINTS[known]) return null;
  if (known === "info/refs" && url.searchParams.get("service") !== "git-upload-pack") return null;
  return { repoId, endpoint: known };
}

/** A namespace of `GitEdge` objects, as much of one as the route uses. */
export type EdgeNamespace = {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): { fetch(request: Request): Promise<Response> };
};

/**
 * The runner Worker's route to the edge: the request, as it came, to the
 * `GitEdge` object of its repository. A path the edge does not answer is
 * not found; a g1t that did not deploy the edge says it is off, which the
 * repos service takes like any other miss and answers from Artifacts.
 */
export async function routeToEdge(request: Request, namespace: EdgeNamespace | undefined): Promise<Response> {
  const route = edgeRoute(request.method, new URL(request.url));
  if (!route) return notFound();
  if (!namespace) return edgeMiss(503, "off", "The git edge is not deployed here.\n");
  return namespace.get(namespace.idFromName(route.repoId)).fetch(request);
}

/**
 * The container behind one `GitEdge` object, as `answerEdge` uses it:
 * whether it is running and listening, starting it (and waiting until it
 * listens), a request sent to it, and work kept going after the answer.
 */
export type EdgeBox = {
  ready(): Promise<boolean>;
  /** Starts the container for `repoId` and restores its snapshot, if one is kept. */
  start(repoId: string): Promise<void>;
  forward(request: Request): Promise<Response>;
  background(work: Promise<unknown>): void;
  /** Keeps a snapshot of the mirror once the sync to `version` has ended. */
  keep?: (repoId: string, version: number) => Promise<void>;
  log?: (...data: unknown[]) => void;
};

/**
 * A `GitEdge` object's answer to a request routed to it (`routeToEdge`):
 *
 * - `sync` starts the container if it is not running, waits for it, and
 *   passes the request to its `/sync`, answering what it answers (202).
 * - `info/refs` and `git-upload-pack` never wait for a container to start:
 *   a cold one is started in the background and the answer is a `503`
 *   with `x-g1t-edge: cold` at once, so the repos service answers from
 *   Artifacts and asks for a sync. A running one is sent the request at
 *   `/git/<endpoint>`, with its query string, headers and body as they
 *   came, and its answer is streamed back; a pack is never held whole.
 * - `state` is the container's `/state`, or `{"version":null,"cold":true}`
 *   when it is not running; asking it starts nothing.
 */
export async function answerEdge(request: Request, box: EdgeBox): Promise<Response> {
  const url = new URL(request.url);
  const route = edgeRoute(request.method, url);
  if (!route) return notFound();
  const log = box.log ?? console.log;
  switch (route.endpoint) {
    case "sync": {
      try {
        await box.start(route.repoId);
      } catch (error) {
        log("git edge not started for a sync", route.repoId, String(error));
        return edgeMiss(503, "cold", "The git edge could not start.\n");
      }
      // A few hundred bytes: read, for the version it syncs to, and sent on.
      const body = await request.text();
      const answer = await send(box, new Request(request, { body }), "/sync", "", route, log);
      const version = syncVersion(body);
      if (answer.status === 202 && version !== null && box.keep) {
        box.background(box.keep(route.repoId, version).catch((error: unknown) => log("git edge snapshot not kept", route.repoId, String(error))));
      }
      return answer;
    }
    case "state": {
      if (!(await box.ready())) return Response.json({ version: null, cold: true });
      return send(box, request, "/state", "", route, log);
    }
    case "info/refs":
    case "git-upload-pack": {
      if (!(await box.ready())) {
        // Started for the next clone, which this one makes no slower.
        box.background(box.start(route.repoId).catch((error: unknown) => log("git edge not started", route.repoId, String(error))));
        return edgeMiss(503, "cold", "The git edge is starting.\n");
      }
      return send(box, request, `/git/${route.endpoint}`, url.search, route, log);
    }
  }
}

/**
 * Passes `request` to the container at `path`: its method, headers and
 * body as they came, the body streamed. A container that cannot be
 * reached is a miss, never thrown.
 */
async function send(box: EdgeBox, request: Request, path: string, search: string, route: EdgeRoute, log: (...data: unknown[]) => void): Promise<Response> {
  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  const init = {
    method: request.method,
    headers: request.headers,
    body: hasBody ? request.body : null,
    // A streamed body needs this outside Workers (Node's fetch); Workers
    // ignores it.
    duplex: "half",
  } as RequestInit;
  try {
    return await box.forward(new Request(`http://gitedge${path}${search}`, init));
  } catch (error) {
    log("git edge request failed", route.repoId, route.endpoint, String(error));
    return edgeMiss(502, "error", "The git edge could not be reached.\n");
  }
}

/** The version a sync's body asks for, or null when it names none. */
export function syncVersion(body: string): number | null {
  try {
    const version = (JSON.parse(body) as { version?: unknown }).version;
    return typeof version === "number" && Number.isSafeInteger(version) && version >= 0 ? version : null;
  } catch {
    return null;
  }
}

/**
 * Snapshots of a repository's mirror. A container loses its disk when it
 * sleeps, and a cold edge used to clone the whole repository from
 * Artifacts again (the first clone after the edge's deploy took 116 s
 * while it did). So once a sync has ended, the mirror is kept in R2 as the
 * container's `GET /snapshot` makes it (a tar of the packed mirror, with
 * the version it is at), and the next start restores it (`PUT /snapshot`)
 * before its first sync, which then fetches only what is newer. In the
 * packs bucket under `packs/`, so the bucket's 7-day rule deletes the
 * snapshot of a repository nobody has cloned since.
 */
export const SNAPSHOT_EVERY_MS = 10 * 60 * 1000;
/** How long a snapshot waits for the sync it follows to end. */
export const SNAPSHOT_WAIT_MS = 10 * 60 * 1000;

export function snapshotKey(repoId: string): string {
  return `packs/edge/${repoId}/mirror.tar`;
}

/** Where snapshots are kept: R2, as much of it as snapshots use. */
export type SnapshotStore = {
  head(key: string): Promise<{ version: number; uploaded: number } | null>;
  get(key: string): Promise<{ version: number; size: number; body: ReadableStream } | null>;
  put(key: string, body: ReadableStream, size: number, version: number): Promise<void>;
};

/** Snapshots in an R2 bucket, the version each was made at in its metadata. */
export function snapshotStore(bucket: R2Bucket): SnapshotStore {
  const versionOf = (object: R2Object) => Number(object.customMetadata?.version ?? Number.NaN);
  return {
    async head(key) {
      const object = await bucket.head(key);
      return object && Number.isSafeInteger(versionOf(object)) ? { version: versionOf(object), uploaded: object.uploaded.getTime() } : null;
    },
    async get(key) {
      const object = await bucket.get(key);
      if (!object) return null;
      if (!Number.isSafeInteger(versionOf(object))) {
        await object.body.cancel();
        return null;
      }
      return { version: versionOf(object), size: object.size, body: object.body };
    },
    async put(key, body, size, version) {
      // R2 takes a stream only with its length known.
      const { readable, writable } = new FixedLengthStream(size);
      const piped = body.pipeTo(writable);
      await Promise.all([bucket.put(key, readable, { customMetadata: { version: String(version) } }), piped]);
    },
  };
}

/**
 * Restores the kept snapshot of `repoId` into a container that has just
 * started. Whether one was restored; a missing or refused one leaves the
 * edge empty, and its first sync fetches everything, as before.
 */
export async function restoreSnapshot(
  repoId: string,
  store: SnapshotStore,
  forward: (request: Request) => Promise<Response>,
  log: (...data: unknown[]) => void = console.log,
): Promise<boolean> {
  const kept = await store.get(snapshotKey(repoId));
  if (!kept) return false;
  const answer = await forward(
    new Request("http://gitedge/snapshot", {
      method: "PUT",
      headers: { "x-g1t-edge-version": String(kept.version), "content-length": String(kept.size) },
      body: kept.body,
      duplex: "half",
    } as RequestInit),
  );
  if (answer.status !== 204) log("git edge snapshot not restored", repoId, answer.status);
  return answer.status === 204;
}

/**
 * Keeps a snapshot of `repoId`'s mirror once the sync to `version` has
 * ended: only when it ended at that version (a newer sync keeps its own),
 * the kept one is older, and none was kept in the last
 * `SNAPSHOT_EVERY_MS`, so a busy repository's pushes do not each upload
 * the whole mirror.
 */
export async function keepSnapshot(
  repoId: string,
  version: number,
  deps: {
    store: SnapshotStore;
    forward: (request: Request) => Promise<Response>;
    now?: () => number;
    wait?: (ms: number) => Promise<void>;
  },
): Promise<boolean> {
  const now = deps.now ?? Date.now;
  const wait = deps.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const until = now() + SNAPSHOT_WAIT_MS;
  let state: { version: number | null; syncing: boolean };
  for (;;) {
    state = (await (await deps.forward(new Request("http://gitedge/state"))).json()) as typeof state;
    if (!state.syncing) break;
    if (now() > until) return false;
    await wait(3000);
  }
  if (state.version !== version) return false;
  const key = snapshotKey(repoId);
  const kept = await deps.store.head(key);
  if (kept && (kept.version >= version || now() - kept.uploaded < SNAPSHOT_EVERY_MS)) return false;
  const made = await deps.forward(new Request("http://gitedge/snapshot"));
  const size = Number(made.headers.get("content-length"));
  const at = Number(made.headers.get("x-g1t-edge-version"));
  if (made.status !== 200 || !made.body || !Number.isSafeInteger(size) || size <= 0 || !Number.isSafeInteger(at)) {
    await made.body?.cancel();
    return false;
  }
  await deps.store.put(key, made.body, size, at);
  return true;
}

/** An answer the repos service takes as a miss: why, in `x-g1t-edge`. */
function edgeMiss(status: number, why: string, text: string): Response {
  return new Response(text, { status, headers: { "x-g1t-edge": why, "content-type": "text/plain; charset=utf-8" } });
}

function notFound(): Response {
  return new Response("Not found\n", { status: 404 });
}
