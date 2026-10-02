import { Hono } from "hono";
import { cors } from "hono/cors";

import {
  type ServiceBinding,
  type Viewer,
  eventsClient,
  httpStatus,
  identityClient,
  reposClient,
  workClient,
} from "@g1t/contracts";

import { handleMcp } from "./mcp";
import { MCP_CHALLENGE, oauth } from "./oauth";
import { openApiDocument } from "./openapi";
import { type ApiEnv, operations, operationsByName } from "./operations";

type Input = Record<string, unknown>;
/** The Worker's raw bindings; Rust services are reached through clients. */
type Bindings = {
  EVENTS: ServiceBinding;
  IDENTITY: ServiceBinding;
  REPOS: ServiceBinding;
  WORK: ServiceBinding;
};
type App = { Bindings: Bindings; Variables: { viewer: Viewer; services: ApiEnv } };

/**
 * REST routes. Each maps an HTTP request onto one operation; `input` builds
 * the operation's input from the path, query string and JSON body.
 */
const ROUTES: {
  method: "GET" | "POST" | "PATCH";
  path: string;
  operation: string;
  input?: (params: Record<string, string>, query: Input, body: Input) => Input;
}[] = [
  { method: "GET", path: "/v1/user", operation: "whoami" },
  { method: "POST", path: "/v1/workspaces", operation: "create_workspace", input: (_p, _q, b) => b },
  { method: "GET", path: "/v1/repos", operation: "list_repos", input: (_p, q) => ({ query: q.q }) },
  { method: "POST", path: "/v1/repos", operation: "create_repo", input: (_p, _q, b) => b },
  { method: "GET", path: "/v1/repos/:owner/:name", operation: "get_repo", input: repo },
  { method: "GET", path: "/v1/repos/:owner/:name/events", operation: "list_events", input: (p, q) => ({ ...repo(p), before: q.before }) },
  { method: "GET", path: "/v1/repos/:owner/:name/labels", operation: "list_labels", input: repo },
  { method: "GET", path: "/v1/repos/:owner/:name/issues", operation: "list_issues", input: (p, q) => ({ ...repo(p), state: q.state, label: q.label }) },
  { method: "POST", path: "/v1/repos/:owner/:name/issues", operation: "create_issue", input: (p, _q, b) => ({ ...b, ...repo(p) }) },
  { method: "GET", path: "/v1/repos/:owner/:name/issues/:number", operation: "get_issue", input: numbered },
  { method: "PATCH", path: "/v1/repos/:owner/:name/issues/:number", operation: "update_issue", input: numbered },
  { method: "POST", path: "/v1/repos/:owner/:name/issues/:number/close", operation: "close_issue", input: numbered },
  { method: "POST", path: "/v1/repos/:owner/:name/issues/:number/reopen", operation: "reopen_issue", input: numbered },
  { method: "POST", path: "/v1/repos/:owner/:name/issues/:number/comments", operation: "add_comment", input: numbered },
  { method: "GET", path: "/v1/repos/:owner/:name/pulls", operation: "list_pull_requests", input: (p, q) => ({ ...repo(p), state: q.state }) },
  { method: "POST", path: "/v1/repos/:owner/:name/pulls", operation: "create_pull_request", input: (p, _q, b) => ({ ...b, ...repo(p) }) },
  { method: "GET", path: "/v1/repos/:owner/:name/pulls/:number", operation: "get_pull_request", input: numbered },
  { method: "GET", path: "/v1/repos/:owner/:name/pulls/:number/changes", operation: "get_pull_request_changes", input: numbered },
  { method: "GET", path: "/v1/repos/:owner/:name/pulls/:number/session", operation: "read_session", input: (p, q) => ({ ...numbered(p), after: Number(q.after) || 0 }) },
  { method: "POST", path: "/v1/repos/:owner/:name/pulls/:number/session", operation: "record_session", input: numbered },
  { method: "POST", path: "/v1/repos/:owner/:name/pulls/:number/ready", operation: "mark_pull_request_ready", input: numbered },
  { method: "POST", path: "/v1/repos/:owner/:name/pulls/:number/close", operation: "close_pull_request", input: numbered },
  { method: "POST", path: "/v1/repos/:owner/:name/pulls/:number/merge", operation: "merge_pull_request", input: numbered },
];

function repo(params: Record<string, string>): Input {
  return { repo: `${params.owner}/${params.name}` };
}

/** An issue or pull request named in the path, with the body's fields. */
function numbered(params: Record<string, string>, _query: Input = {}, body: Input = {}): Input {
  return { ...body, ...repo(params), number: Number(params.number) };
}

/** The section of the API reference an operation is listed under. */
function tagFor(operation: string): string {
  if (operation === "whoami" || operation.includes("workspace")) return "Accounts";
  if (operation.includes("session")) return "Sessions";
  if (operation.includes("pull_request")) return "Pull requests";
  if (/issue|label|comment/.test(operation)) return "Issues";
  return "Repositories";
}

const app = new Hono<App>();

// The API is called from browsers too: the reference's explorer, and apps
// built on g1t. It carries no cookies, so any origin may call it.
app.use(cors({
    origin: "*",
    allowHeaders: ["authorization", "content-type"],
    allowMethods: ["GET", "POST", "PATCH", "OPTIONS"],
  }));

// `Authorization: Bearer g1t_…`. A missing token is an anonymous viewer; a
// wrong one is rejected so a typo does not silently look signed out.
app.use(async (c, next) => {
  const [scheme, token] = (c.req.header("authorization") ?? "").split(" ");
  const services: ApiEnv = {
    EVENTS: eventsClient(c.env.EVENTS),
    IDENTITY: identityClient(c.env.IDENTITY),
    REPOS: reposClient(c.env.REPOS),
    WORK: workClient(c.env.WORK),
  };
  c.set("services", services);
  let viewer: Viewer = null;
  if (scheme?.toLowerCase() === "bearer" && token) {
    viewer = await services.IDENTITY.userForAccessToken(token);
    if (!viewer) {
      return c.json(
        { error: { code: "unauthenticated", message: "Invalid access token." } },
        401,
        // Tells an MCP client where to sign in again.
        { "www-authenticate": `${MCP_CHALLENGE}, error="invalid_token"` },
      );
    }
  }
  c.set("viewer", viewer);
  await next();
});

// Signing in with OAuth. Served on both hosts: an MCP client looks for the
// metadata next to the MCP server.
app.route("/", oauth);

app.all("*", async (c, next) => {
  if (!new URL(c.req.url).hostname.startsWith("mcp.")) return next();
  const viewer = c.get("viewer");
  // The MCP server needs a signed-in user. Saying so this way is what
  // makes a client open the browser to sign in.
  if (!viewer) {
    return c.json(
      {
        error: {
          code: "unauthenticated",
          message: "Sign in to use the g1t MCP server.",
        },
      },
      401,
      { "www-authenticate": MCP_CHALLENGE },
    );
  }
  return handleMcp(c.req.raw, c.get("services"), viewer);
});

// Signing in from a tool. Accounts are created, and passwords typed, only
// in a browser; a tool gets its token by having a person approve a code.

async function jsonBody(request: Request): Promise<Record<string, unknown>> {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

app.post("/v1/device/code", async (c) => {
  const body = await jsonBody(c.req.raw);
  const started = await c
    .get("services")
    .IDENTITY.deviceStart(String(body.client_name ?? ""));
  return c.json({
    device_code: started.deviceCode,
    user_code: started.userCode,
    verification_uri: "https://g1t.sh/device",
    verification_uri_complete: `https://g1t.sh/device?code=${started.userCode}`,
    expires_in: started.expiresIn,
    interval: started.interval,
  });
});

app.post("/v1/device/token", async (c) => {
  const body = await jsonBody(c.req.raw);
  const claim = await c
    .get("services")
    .IDENTITY.deviceClaim(String(body.device_code ?? ""));
  if (claim.status !== "approved") return c.json({ status: claim.status });
  return c.json({
    status: "approved",
    token: claim.token,
    username: claim.user.username,
    verified: claim.user.verified === true,
  });
});

app.get("/openapi.json", (c) =>
  c.json(
    openApiDocument(
      ROUTES.map(({ method, path, operation }) => ({
        method,
        path,
        operation,
        tag: tagFor(operation),
      })),
    ),
  ),
);

app.get("/", (c) =>
  c.json({
    name: "g1t API",
    version: "v1",
    documentation: "https://docs.g1t.sh/api",
    openapi: "https://api.g1t.sh/openapi.json",
    operations: operations.map(({ name, description }) => ({ name, description })),
  }),
);

for (const route of ROUTES) {
  const operation = operationsByName.get(route.operation)!;
  app.on(route.method, route.path, async (c) => {
    let body: Input = {};
    if (route.method !== "GET") {
      try {
        body = await c.req.json();
      } catch {
        // An empty or non-JSON body is treated as no input.
      }
    }
    const input = route.input?.(c.req.param(), c.req.query(), body) ?? {};
    const outcome = await operation.run(c.get("services"), c.get("viewer"), input);
    if (outcome.ok) return c.json(outcome.value);
    return c.json(
      { error: outcome.error },
      httpStatus(outcome.error) as 401 | 403 | 404 | 409 | 422,
    );
  });
}

app.notFound((c) =>
  c.json({ error: { code: "not_found", message: "No such endpoint." } }, 404),
);

export default app;
