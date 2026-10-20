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
  start(): Promise<void>;
  forward(request: Request): Promise<Response>;
  background(work: Promise<unknown>): void;
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
        await box.start();
      } catch (error) {
        log("git edge not started for a sync", route.repoId, String(error));
        return edgeMiss(503, "cold", "The git edge could not start.\n");
      }
      return send(box, request, "/sync", "", route, log);
    }
    case "state": {
      if (!(await box.ready())) return Response.json({ version: null, cold: true });
      return send(box, request, "/state", "", route, log);
    }
    case "info/refs":
    case "git-upload-pack": {
      if (!(await box.ready())) {
        // Started for the next clone, which this one makes no slower.
        box.background(box.start().catch((error: unknown) => log("git edge not started", route.repoId, String(error))));
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

/** An answer the repos service takes as a miss: why, in `x-g1t-edge`. */
function edgeMiss(status: number, why: string, text: string): Response {
  return new Response(text, { status, headers: { "x-g1t-edge": why, "content-type": "text/plain; charset=utf-8" } });
}

function notFound(): Response {
  return new Response("Not found\n", { status: 404 });
}
