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
  pullComparison,
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

const NUMBER = {
  type: "integer",
  description: "The number shown after the #. Issues and pull requests share one sequence.",
};

const numbered = { repo: REPO, number: NUMBER };

function strings(input: Input, key: string): string[] | undefined {
  const value = input[key];
  return Array.isArray(value) ? value.map(String) : undefined;
}

function state(input: Input): "open" | "closed" | undefined {
  const value = text(input, "state");
  return value === "open" || value === "closed" ? value : undefined;
}

/** Wraps an operation on a repository that anyone who can see it may call. */
function onRepo(
  run: (env: ApiEnv, path: RepoPath, viewer: Viewer, input: Input) => Promise<Result<unknown>>,
): Operation["run"] {
  return (env, viewer, input) => {
    const path = repoPath(input);
    return path ? run(env, path, viewer, input) : Promise.resolve(BAD_REPO);
  };
}

/** Wraps an operation on a repository that needs a signed-in user. */
function onRepoAs(
  run: (env: ApiEnv, path: RepoPath, user: User, input: Input) => Promise<Result<unknown>>,
): Operation["run"] {
  return onRepo((env, path, viewer, input) =>
    viewer ? run(env, path, viewer, input) : Promise.resolve(SIGN_IN),
  );
}

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
    name: "list_issues",
    description:
      "Issues on a repository, newest first. An issue is something that should change: a bug, a feature, a question. Pull requests are made against it.",
    input: {
      type: "object",
      properties: {
        repo: REPO,
        state: { type: "string", enum: ["open", "closed"] },
        label: { type: "string", description: "Only issues carrying this label." },
      },
      required: ["repo"],
    },
    run: onRepo((env, path, viewer, input) =>
      env.WORK.listIssues(path, viewer, {
        state: state(input),
        label: text(input, "label") || undefined,
      }),
    ),
  },
  {
    name: "get_issue",
    description:
      "An issue: its description, labels and acceptance checks, its comments, and every pull request made against it with its status. If the issue is closed, resolvedBy is the number of the pull request that was merged for it. Read this before opening a pull request, to see what others have already tried.",
    input: { type: "object", properties: numbered, required: ["repo", "number"] },
    run: onRepo((env, path, viewer, input) =>
      env.WORK.getIssue(path, Number(input.number), viewer),
    ),
  },
  {
    name: "create_issue",
    description: "Open an issue on a repository.",
    input: {
      type: "object",
      properties: {
        repo: REPO,
        title: { type: "string", description: "The problem or goal in one line." },
        body: {
          type: "string",
          description:
            "Markdown. What an agent or a person needs to do the work: what is wrong or wanted, constraints, context.",
        },
        labels: {
          type: "array",
          items: { type: "string" },
          description:
            'What kind of issue this is, e.g. "bug" or "feature". list_labels shows the labels in use; a new name creates a new label.',
        },
        checks: {
          type: "array",
          items: { type: "string" },
          description: "Commands that must pass for a pull request to be accepted.",
        },
      },
      required: ["repo", "title"],
    },
    run: onRepoAs((env, path, user, input) =>
      env.WORK.openIssue(user, path, {
        title: text(input, "title"),
        body: text(input, "body"),
        labels: strings(input, "labels"),
        checks: strings(input, "checks"),
      }),
    ),
  },
  {
    name: "update_issue",
    description:
      "Change an issue's title, body or labels. Only the fields given are changed; labels replaces the whole set.",
    input: {
      type: "object",
      properties: {
        ...numbered,
        title: { type: "string" },
        body: { type: "string" },
        labels: { type: "array", items: { type: "string" } },
      },
      required: ["repo", "number"],
    },
    run: onRepoAs((env, path, user, input) =>
      env.WORK.updateIssue(user, path, Number(input.number), {
        title: typeof input.title === "string" ? input.title : undefined,
        body: typeof input.body === "string" ? input.body : undefined,
        labels: strings(input, "labels"),
      }),
    ),
  },
  {
    name: "close_issue",
    description:
      "Close an issue without a pull request. Merging a pull request made for an issue closes it for you.",
    input: {
      type: "object",
      properties: {
        ...numbered,
        reason: {
          type: "string",
          enum: ["completed", "not_planned"],
          description: "Defaults to completed.",
        },
      },
      required: ["repo", "number"],
    },
    run: onRepoAs((env, path, user, input) =>
      env.WORK.closeIssue(
        user,
        path,
        Number(input.number),
        text(input, "reason") === "not_planned" ? "not_planned" : "completed",
      ),
    ),
  },
  {
    name: "reopen_issue",
    description: "Reopen a closed issue.",
    input: { type: "object", properties: numbered, required: ["repo", "number"] },
    run: onRepoAs((env, path, user, input) =>
      env.WORK.reopenIssue(user, path, Number(input.number)),
    ),
  },
  {
    name: "list_labels",
    description: "The labels available on a repository's issues.",
    input: { type: "object", properties: { repo: REPO }, required: ["repo"] },
    run: onRepo((env, path, viewer) => env.WORK.listLabels(path, viewer)),
  },
  {
    name: "add_comment",
    description: "Comment on an issue or a pull request.",
    input: {
      type: "object",
      properties: { ...numbered, body: { type: "string", description: "Markdown." } },
      required: ["repo", "number", "body"],
    },
    run: onRepoAs((env, path, user, input) =>
      env.WORK.addComment(user, path, Number(input.number), text(input, "body")),
    ),
  },
  {
    name: "list_pull_requests",
    description:
      "Pull requests on a repository, newest first. State open covers drafts and those ready for review; closed covers merged and closed.",
    input: {
      type: "object",
      properties: { repo: REPO, state: { type: "string", enum: ["open", "closed"] } },
      required: ["repo"],
    },
    run: onRepo((env, path, viewer, input) => env.WORK.listPulls(path, viewer, state(input))),
  },
  {
    name: "get_pull_request",
    description:
      "A pull request's status, head commit, comments and the issue it is for.",
    input: { type: "object", properties: numbered, required: ["repo", "number"] },
    run: onRepo((env, path, viewer, input) =>
      env.WORK.getPull(path, Number(input.number), viewer),
    ),
  },
  {
    name: "create_pull_request",
    description:
      "Start a change. Opens a draft pull request with its own fork of the repository and returns the fork's git remote. Clone it, commit your work there, push, record your session as you go, then call mark_pull_request_ready. Give the issue it is for whenever there is one. If the change is already on a branch pushed to the repository, give that branch instead: no fork is made and the pull request is ready for review at once.",
    input: {
      type: "object",
      properties: {
        repo: REPO,
        issue: { type: "integer", description: "The number of the issue this is for." },
        title: {
          type: "string",
          description: "Defaults to the issue's title. Required when there is no issue.",
        },
        branch: {
          type: "string",
          description:
            "A branch already pushed to the repository that holds the change. Leave out to get a fork.",
        },
        body: {
          type: "string",
          description: "Markdown: what changed and why. Mainly for pull requests from a branch.",
        },
        agent: {
          type: "string",
          description: 'A label for the agent doing the work, e.g. "claude-code".',
        },
      },
      required: ["repo"],
    },
    run: onRepoAs(async (env, path, user, input) => {
      const opened = await env.WORK.openPull(user, path, {
        issue: input.issue == null ? undefined : Number(input.issue),
        title: text(input, "title"),
        body: text(input, "body"),
        branch: text(input, "branch") || undefined,
        agent: text(input, "agent") || "agent",
        runtime: "external",
      });
      if (!opened.ok) return opened;
      const { fork } = opened.value;
      return ok({
        pull: opened.value,
        // Where to push. A pull request from a branch has no fork: push to
        // that branch of the repository.
        git: {
          remote: fork
            ? `https://g1t.sh/${fork.namespace}/${fork.name}.git`
            : `https://g1t.sh/${path.namespace}/${path.name}.git`,
          username: user.username,
          password: "your g1t access token",
        },
      });
    }),
  },
  {
    name: "record_session",
    description:
      "Append entries to a pull request's session: the prompt you were given, your reasoning, the tools you ran. This is how people later see why a change was made, so record as you work, not only at the end.",
    input: {
      type: "object",
      properties: {
        ...numbered,
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
      required: ["repo", "number", "entries"],
    },
    run: onRepoAs(async (env, path, user, input) => {
      if (!Array.isArray(input.entries)) {
        return fail("invalid", "entries must be an array.");
      }
      return env.WORK.appendSession(
        user,
        path,
        Number(input.number),
        input.entries as NewSessionEntry[],
      );
    }),
  },
  {
    name: "read_session",
    description: "The recorded session of a pull request, oldest entry first.",
    input: {
      type: "object",
      properties: {
        ...numbered,
        after: { type: "integer", description: "Only entries after this sequence number." },
      },
      required: ["repo", "number"],
    },
    run: onRepo((env, path, viewer, input) =>
      env.WORK.readSession(path, Number(input.number), viewer, Number(input.after) || 0),
    ),
  },
  {
    name: "mark_pull_request_ready",
    description:
      "Mark a draft pull request ready for review. Push your commits first. The summary becomes its description and should say what changed and why.",
    input: {
      type: "object",
      properties: { ...numbered, summary: { type: "string", description: "Markdown." } },
      required: ["repo", "number", "summary"],
    },
    run: onRepoAs((env, path, user, input) =>
      env.WORK.readyPull(user, path, Number(input.number), text(input, "summary")),
    ),
  },
  {
    name: "close_pull_request",
    description: "Close a pull request without merging it.",
    input: { type: "object", properties: numbered, required: ["repo", "number"] },
    run: onRepoAs((env, path, user, input) =>
      env.WORK.closePull(user, path, Number(input.number)),
    ),
  },
  {
    name: "get_pull_request_changes",
    description:
      "What a pull request changes: the files it touches and their line-by-line diff against the commit it started from. Use it to review a pull request or to compare several made for the same issue.",
    input: { type: "object", properties: numbered, required: ["repo", "number"] },
    run: onRepo(async (env, path, viewer, input) => {
      const found = await env.WORK.getPull(path, Number(input.number), viewer);
      if (!found.ok) return found;
      const { repoId, base, head } = pullComparison(found.value.pull);
      return env.REPOS.compare(repoId, viewer, base, head);
    }),
  },
  {
    name: "merge_pull_request",
    description:
      "Land a pull request on the repository's main branch. Only members of the repository's workspace can merge, and only once it is marked ready. Merging resolves the issue it was made for: the issue closes recording this pull request, and the other pull requests still in progress for that issue close as superseded. Fails if main has moved since the pull request was opened; pull main into its fork and push, then merge again.",
    input: {
      type: "object",
      properties: {
        ...numbered,
        keep_issue_open: {
          type: "boolean",
          description:
            "Set when this pull request is only part of the work: the issue stays open and the other pull requests for it are left alone.",
        },
      },
      required: ["repo", "number"],
    },
    run: onRepoAs((env, path, user, input) =>
      env.WORK.mergePull(user, path, Number(input.number), input.keep_issue_open === true),
    ),
  },
  {
    name: "list_events",
    description:
      "The timeline of a repository: pushes, issues, pull requests, comments and session activity, newest first.",
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
