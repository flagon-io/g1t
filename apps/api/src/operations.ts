import {
  type EventsApi,
  type IdentityApi,
  type NewSessionEntry,
  type RepoPath,
  type ReposApi,
  type Result,
  type User,
  type Viewer,
  type WorkApi,
  fail,
  ok,
} from "@g1t/contracts";

export interface ApiEnv {
  IDENTITY: IdentityApi;
  REPOS: ReposApi;
  WORK: WorkApi;
  EVENTS: EventsApi;
}

type Input = Record<string, unknown>;

type JsonSchema = {
  type: "object";
  properties: Record<string, object>;
  required?: string[];
};

/**
 * One thing a client can do. REST routes and MCP tools are both generated
 * from this list, so the two surfaces cannot drift apart.
 */
export type Operation = {
  name: string;
  description: string;
  input: JsonSchema;
  run(env: ApiEnv, viewer: Viewer, input: Input): Promise<Result<unknown>>;
};

const SIGN_IN = fail("unauthenticated", "This needs a g1t access token.");

const REPO = {
  type: "string",
  description: 'Repository as "owner/name", e.g. "syntaqx/hello".',
};

function text(input: Input, key: string): string {
  const value = input[key];
  return typeof value === "string" ? value : "";
}

function repoPath(input: Input): RepoPath | null {
  const [namespace, name, ...rest] = text(input, "repo").split("/");
  return namespace && name && rest.length === 0 ? { namespace, name } : null;
}

const BAD_REPO = fail("invalid", 'Give the repository as "owner/name".');

/** Wraps an operation that needs a signed-in user. */
function authed(
  run: (env: ApiEnv, user: User, input: Input) => Promise<Result<unknown>>,
): Operation["run"] {
  return (env, viewer, input) =>
    viewer ? run(env, viewer, input) : Promise.resolve(SIGN_IN);
}

export const operations: Operation[] = [
  {
    name: "whoami",
    description: "The account the access token belongs to, and its workspaces.",
    input: { type: "object", properties: {} },
    run: authed(async (_env, user) => ok(user)),
  },
  {
    name: "create_workspace",
    description:
      "Create a workspace. A workspace owns repositories and is the first part of their address, g1t.sh/<workspace>/<repo>. The whoami tool lists the ones you already belong to.",
    input: {
      type: "object",
      properties: {
        slug: {
          type: "string",
          description: "Its name in URLs: lowercase letters, digits and single hyphens.",
        },
        name: { type: "string", description: "A display name." },
      },
      required: ["slug"],
    },
    run: authed((env, user, input) =>
      env.IDENTITY.createWorkspace(user, text(input, "slug"), text(input, "name")),
    ),
  },
  {
    name: "list_repos",
    description: "Repositories you can see, optionally filtered by a search query.",
    input: {
      type: "object",
      properties: { query: { type: "string", description: "Matches name or description." } },
    },
    run: async (env, viewer, input) =>
      ok(await env.REPOS.list(viewer, { query: text(input, "query") })),
  },
  {
    name: "get_repo",
    description: "One repository's details.",
    input: { type: "object", properties: { repo: REPO }, required: ["repo"] },
    run: async (env, viewer, input) => {
      const path = repoPath(input);
      return path ? env.REPOS.get(path, viewer) : BAD_REPO;
    },
  },
  {
    name: "create_repo",
    description: "Create a repository in one of your workspaces.",
    input: {
      type: "object",
      properties: {
        workspace: {
          type: "string",
          description:
            "The workspace to create it in. May be left out if you belong to exactly one.",
        },
        name: { type: "string" },
        description: { type: "string" },
        private: { type: "boolean" },
      },
      required: ["name"],
    },
    run: authed((env, user, input) =>
      env.REPOS.create(user, {
        namespace:
          text(input, "workspace") ||
          (user.workspaces?.length === 1 ? user.workspaces[0].slug : ""),
        name: text(input, "name"),
        description: text(input, "description"),
        isPrivate: input.private === true,
      }),
    ),
  },
  {
    name: "list_intents",
    description:
      "Intents on a repository. An intent is a goal that agents attempt in parallel; it replaces issues and pull requests.",
    input: {
      type: "object",
      properties: {
        repo: REPO,
        status: { type: "string", enum: ["open", "shipped", "withdrawn"] },
      },
      required: ["repo"],
    },
    run: async (env, viewer, input) => {
      const path = repoPath(input);
      const status = text(input, "status");
      if (!path) return BAD_REPO;
      return env.WORK.listIntents(
        path,
        viewer,
        status === "open" || status === "shipped" || status === "withdrawn"
          ? status
          : undefined,
      );
    },
  },
  {
    name: "get_intent",
    description:
      "An intent's brief, its acceptance checks, and every attempt made at it so far. Read this before starting an attempt.",
    input: {
      type: "object",
      properties: { repo: REPO, number: { type: "integer" } },
      required: ["repo", "number"],
    },
    run: async (env, viewer, input) => {
      const path = repoPath(input);
      return path
        ? env.WORK.getIntent(path, Number(input.number), viewer)
        : BAD_REPO;
    },
  },
  {
    name: "open_intent",
    description: "State a new goal for a repository.",
    input: {
      type: "object",
      properties: {
        repo: REPO,
        title: { type: "string", description: "The goal in one line." },
        brief: {
          type: "string",
          description: "What an agent needs to do the work: outcome, constraints, context.",
        },
        checks: {
          type: "array",
          items: { type: "string" },
          description: "Commands that must pass for an attempt to be accepted.",
        },
      },
      required: ["repo", "title", "brief"],
    },
    run: authed(async (env, user, input) => {
      const path = repoPath(input);
      if (!path) return BAD_REPO;
      return env.WORK.openIntent(user, path, {
        title: text(input, "title"),
        brief: text(input, "brief"),
        checks: Array.isArray(input.checks) ? input.checks.map(String) : [],
      });
    }),
  },
  {
    name: "start_attempt",
    description:
      "Begin working on an intent. Creates a private fork for this attempt and returns its git remote. Clone it, commit your work there, push, record your session as you go, then call submit_attempt.",
    input: {
      type: "object",
      properties: {
        intent_id: { type: "string" },
        agent: {
          type: "string",
          description: 'A label for the agent doing the work, e.g. "claude-code".',
        },
      },
      required: ["intent_id"],
    },
    run: authed(async (env, user, input) => {
      const started = await env.WORK.startAttempt(user, text(input, "intent_id"), {
        agent: text(input, "agent") || "agent",
        runtime: "external",
      });
      if (!started.ok) return started;
      const { fork } = started.value;
      return ok({
        attempt: started.value,
        git: {
          remote: `https://g1t.sh/${fork.namespace}/${fork.name}.git`,
          username: user.username,
          password: "your g1t access token",
        },
      });
    }),
  },
  {
    name: "get_attempt",
    description: "An attempt's status, head commit and the intent it belongs to.",
    input: {
      type: "object",
      properties: { attempt_id: { type: "string" } },
      required: ["attempt_id"],
    },
    run: (env, viewer, input) =>
      env.WORK.getAttempt(text(input, "attempt_id"), viewer),
  },
  {
    name: "record_session",
    description:
      "Append entries to an attempt's session: the prompt you were given, your reasoning, the tools you ran. This is how people later see why a change was made, so record as you work, not only at the end.",
    input: {
      type: "object",
      properties: {
        attempt_id: { type: "string" },
        entries: {
          type: "array",
          items: {
            type: "object",
            properties: {
              kind: {
                type: "string",
                enum: ["prompt", "message", "tool_call", "tool_result", "note"],
              },
              text: { type: "string" },
              tool: { type: "string", description: "Tool name, for tool entries." },
            },
            required: ["kind", "text"],
          },
        },
      },
      required: ["attempt_id", "entries"],
    },
    run: authed(async (env, user, input) => {
      if (!Array.isArray(input.entries)) {
        return fail("invalid", "entries must be an array.");
      }
      return env.WORK.appendSession(
        user,
        text(input, "attempt_id"),
        input.entries as NewSessionEntry[],
      );
    }),
  },
  {
    name: "read_session",
    description: "The recorded session of an attempt, oldest entry first.",
    input: {
      type: "object",
      properties: {
        attempt_id: { type: "string" },
        after: { type: "integer", description: "Only entries after this sequence number." },
      },
      required: ["attempt_id"],
    },
    run: (env, viewer, input) =>
      env.WORK.readSession(
        text(input, "attempt_id"),
        viewer,
        Number(input.after) || 0,
      ),
  },
  {
    name: "submit_attempt",
    description:
      "Mark an attempt ready to be compared and shipped. Push your commits first. The summary should say what changed and why.",
    input: {
      type: "object",
      properties: { attempt_id: { type: "string" }, summary: { type: "string" } },
      required: ["attempt_id", "summary"],
    },
    run: authed((env, user, input) =>
      env.WORK.submitAttempt(user, text(input, "attempt_id"), text(input, "summary")),
    ),
  },
  {
    name: "abandon_attempt",
    description: "Give up on an attempt.",
    input: {
      type: "object",
      properties: { attempt_id: { type: "string" } },
      required: ["attempt_id"],
    },
    run: authed((env, user, input) =>
      env.WORK.abandonAttempt(user, text(input, "attempt_id")),
    ),
  },
  {
    name: "get_attempt_changes",
    description:
      "What an attempt changed: the files it touched and their line-by-line diff against the commit it started from. Use it to review an attempt or to compare several attempts at the same intent.",
    input: {
      type: "object",
      properties: { attempt_id: { type: "string" } },
      required: ["attempt_id"],
    },
    run: async (env, viewer, input) => {
      const found = await env.WORK.getAttempt(text(input, "attempt_id"), viewer);
      if (!found.ok) return found;
      const { forkRepoId, landedBase } = found.value.attempt;
      return env.REPOS.compare(forkRepoId, viewer, landedBase);
    },
  },
  {
    name: "ship_attempt",
    description:
      "Land an attempt on the repository's main branch and close its intent. Only the repository's owner can ship. Fails if main has moved since the attempt started; the attempt must then pull main into its fork and push before shipping again.",
    input: {
      type: "object",
      properties: { attempt_id: { type: "string" } },
      required: ["attempt_id"],
    },
    run: authed((env, user, input) =>
      env.WORK.shipAttempt(user, text(input, "attempt_id")),
    ),
  },
  {
    name: "list_events",
    description:
      "The timeline of a repository: pushes, intents, attempts and session activity, newest first.",
    input: {
      type: "object",
      properties: {
        repo: REPO,
        before: { type: "string", description: "Event id to page back from." },
      },
      required: ["repo"],
    },
    run: async (env, viewer, input) => {
      const path = repoPath(input);
      if (!path) return BAD_REPO;
      const repo = await env.REPOS.get(path, viewer);
      if (!repo.ok) return repo;
      return ok(
        await env.EVENTS.list({
          repoId: repo.value.id,
          before: text(input, "before") || undefined,
        }),
      );
    },
  },
];

export const operationsByName = new Map(
  operations.map((operation) => [operation.name, operation]),
);
