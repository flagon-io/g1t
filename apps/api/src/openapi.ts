import { operationsByName } from "./operations";

/** What the OpenAPI document needs to know about a REST route. */
export type RouteDoc = {
  method: "GET" | "POST";
  path: string;
  operation: string;
  tag: string;
};

const ERROR = { $ref: "#/components/schemas/Error" };

function errorResponse(description: string) {
  return {
    description,
    content: { "application/json": { schema: ERROR } },
  };
}

/** A short title from an operation name: `open_intent` is "Open intent". */
function title(operation: string): string {
  if (operation === "whoami") return "Get the current user";
  const words = operation.split("_").join(" ");
  return words[0].toUpperCase() + words.slice(1);
}

/** Hono's `:name` path parameters as OpenAPI's `{name}`. */
function openApiPath(path: string): string {
  return path.replace(/:([a-z_]+)/g, "{$1}");
}

/** Hand-written entries for device sign-in, which is not an operation. */
const ONBOARDING = {
  "/v1/device/code": {
    post: {
      operationId: "device_code",
      tags: ["Accounts"],
      summary: "Start signing in",
      description:
        "Begins a device sign-in. Show the person `verification_uri_complete` and have them open it in a browser, where they sign in or register and approve the code. Then poll `/v1/device/token`.",
      security: [],
      requestBody: {
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: {
                client_name: {
                  type: "string",
                  description: "What is asking, shown to the person approving. For example, Claude Code.",
                },
              },
            },
          },
        },
      },
      responses: {
        "200": {
          description: "The codes for this sign-in.",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  device_code: { type: "string", description: "Secret. Send it to /v1/device/token." },
                  user_code: { type: "string", description: "Shown to the person, like WDJB-MJHT." },
                  verification_uri: { type: "string" },
                  verification_uri_complete: {
                    type: "string",
                    description: "The link to give the person; it carries the code.",
                  },
                  expires_in: { type: "integer", description: "Seconds until the codes expire." },
                  interval: { type: "integer", description: "Seconds to wait between polls." },
                },
              },
            },
          },
        },
      },
    },
  },
  "/v1/device/token": {
    post: {
      operationId: "device_token",
      tags: ["Accounts"],
      summary: "Finish signing in",
      description:
        "Asks whether the person has approved. Poll no faster than the interval. The token is returned once.",
      security: [],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["device_code"],
              properties: { device_code: { type: "string" } },
            },
          },
        },
      },
      responses: {
        "200": {
          description: "The state of the sign-in.",
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["status"],
                properties: {
                  status: { type: "string", enum: ["pending", "approved", "denied", "expired"] },
                  token: { type: "string", description: "Present when approved." },
                  username: { type: "string" },
                  verified: {
                    type: "boolean",
                    description: "Whether the account's email is confirmed.",
                  },
                },
              },
            },
          },
        },
      },
    },
  },
};

/** The OpenAPI document, generated from the same list the routes are. */
export function openApiDocument(routes: RouteDoc[]) {
  const paths: Record<string, Record<string, unknown>> = { ...ONBOARDING };
  for (const route of routes) {
    const operation = operationsByName.get(route.operation)!;
    const pathParams = [...route.path.matchAll(/:([a-z_]+)/g)].map((match) => match[1]);
    // `owner` and `name` in the path stand for the operation's `repo` input.
    const covered = new Set([...pathParams, "repo"]);
    const inputs = Object.entries(operation.input.properties).filter(
      ([name]) => !covered.has(name),
    );
    const required = (operation.input.required ?? []).filter(
      (name) => !covered.has(name),
    );

    const parameters: unknown[] = pathParams.map((name) => ({
      name,
      in: "path",
      required: true,
      schema: { type: name === "number" ? "integer" : "string" },
    }));
    let requestBody: unknown;
    if (route.method === "GET") {
      for (const [name, schema] of inputs) {
        parameters.push({
          // The repository search parameter is `q` on the wire.
          name: route.operation === "list_repos" && name === "query" ? "q" : name,
          in: "query",
          required: false,
          schema,
        });
      }
    } else if (inputs.length > 0) {
      requestBody = {
        required: required.length > 0,
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: Object.fromEntries(inputs),
              ...(required.length > 0 ? { required } : {}),
            },
          },
        },
      };
    }

    const path = openApiPath(route.path);
    paths[path] ??= {};
    paths[path][route.method.toLowerCase()] = {
      operationId: route.operation,
      tags: [route.tag],
      summary: title(route.operation),
      description: operation.description,
      parameters,
      ...(requestBody ? { requestBody } : {}),
      responses: {
        "200": {
          description: "Success.",
          content: { "application/json": { schema: {} } },
        },
        "401": errorResponse("A token is required, or the one sent is not valid."),
        "403": errorResponse("Signed in, but not allowed to do this."),
        "404": errorResponse("It does not exist, or you cannot see it."),
        "409": errorResponse("The request conflicts with the current state."),
        "422": errorResponse("The input is not valid."),
      },
    };
  }

  return {
    openapi: "3.1.0",
    info: {
      title: "g1t API",
      version: "1",
      description:
        "The REST API for g1t, a git forge built for agents. The same operations are available to agents as MCP tools at https://mcp.g1t.sh.",
      license: { name: "MIT", identifier: "MIT" },
    },
    servers: [{ url: "https://api.g1t.sh" }],
    security: [{ token: [] }, {}],
    tags: [
      { name: "Accounts", description: "Signing in from a tool, and the current user." },
      { name: "Repositories" },
      { name: "Intents", description: "Goals stated against a repository." },
      { name: "Attempts", description: "An agent's or person's run at an intent." },
      { name: "Sessions", description: "The record of how an attempt was made." },
    ],
    paths,
    components: {
      securitySchemes: {
        token: {
          type: "http",
          scheme: "bearer",
          description: "An access token, `g1t_…`. Public data needs none.",
        },
      },
      schemas: {
        Error: {
          type: "object",
          required: ["error"],
          properties: {
            error: {
              type: "object",
              required: ["code", "message"],
              properties: {
                code: {
                  type: "string",
                  enum: ["unauthenticated", "forbidden", "not_found", "conflict", "invalid"],
                },
                message: { type: "string" },
              },
            },
          },
        },
      },
    },
  };
}
