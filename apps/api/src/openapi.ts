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

/** Hand-written entries for the two onboarding routes, which are not operations. */
const ONBOARDING = {
  "/v1/register": {
    post: {
      operationId: "register",
      tags: ["Accounts"],
      summary: "Register",
      description: "Create an account. Sends a confirmation email.",
      security: [],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["username", "email", "password"],
              properties: {
                username: {
                  type: "string",
                  description: "Lowercase letters, digits and single hyphens; at most 39 characters.",
                },
                email: { type: "string", format: "email" },
                password: { type: "string", minLength: 10 },
              },
            },
          },
        },
      },
      responses: {
        "201": { description: "The account was created; a confirmation link was emailed." },
        "409": errorResponse("The username or email is already registered."),
        "422": errorResponse("The input is not valid."),
      },
    },
  },
  "/v1/tokens": {
    post: {
      operationId: "create_token",
      tags: ["Accounts"],
      summary: "Create token",
      description: "Create an access token from a username and password.",
      security: [],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["username", "password"],
              properties: {
                username: { type: "string" },
                password: { type: "string" },
                name: { type: "string", description: "A label for the token." },
              },
            },
          },
        },
      },
      responses: {
        "201": {
          description: "The token, shown once.",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  token: { type: "string" },
                  verified: {
                    type: "boolean",
                    description: "Whether the account's email is confirmed.",
                  },
                },
              },
            },
          },
        },
        "401": errorResponse("Incorrect username or password."),
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
      { name: "Accounts", description: "Registering and getting a token." },
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
