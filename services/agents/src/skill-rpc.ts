/**
 * The skill library's RPC methods (@g1t/contracts skill-library.ts
 * `skillLibraryClient`), and what the library reads from identity, repos
 * and chat for them. The rules are in skill-library.ts.
 */
import { type RepoPath, type Result, type User, chatClient, fail, identityClient, ok, reposClient } from "@g1t/contracts";

import { metered } from "./meter.ts";
import { type SessionEnv, sessionRow } from "./sessions.ts";
import { saveDraft, DRAFT_SYSTEM, transcriptText } from "./skill-draft.ts";
import { Library, type LibraryPorts, onPush } from "./skill-library.ts";
import type { Row } from "./store.ts";
import { runTurn } from "./turn.ts";
import type { ViewContext } from "./views.ts";

/** Reads repositories without a viewer: only after the viewer's access was checked, or for a linked repository. */
function repoFiles(env: { REPOS: SessionEnv["REPOS"] }): Pick<LibraryPorts, "listFiles" | "blobs"> {
  const repos = reposClient(env.REPOS);
  return {
    listFiles: (repoId, ref) => repos.listFiles(repoId, ref, 10_000),
    blobs: async (repoId, hashes) => (await repos.rawBlobs(repoId, hashes, 1024 * 1024)).map((blob) => ({ hash: blob.hash, data: blob.data })),
  };
}

export function libraryFor(ctx: ViewContext, audit: (action: string, name: string, message: string) => void): Library {
  const env = ctx.env;
  const identity = identityClient(env.IDENTITY);
  const ports: LibraryPorts = {
    teams: async () => {
      const listed = await identity.listTeams(ctx.viewer, ctx.slug).catch(() => null);
      return listed?.ok ? listed.value.map((t) => ({ slug: t.slug, name: t.name, can_manage: t.can_manage })) : null;
    },
    repo: async (full) => {
      const [namespace, name] = full.split("/") as [string, string];
      const found = await reposClient(env.REPOS)
        .get({ namespace, name } as RepoPath, ctx.viewer)
        .catch(() => null);
      return found?.ok ? { id: found.value.id, full: `${found.value.namespace}/${found.value.name}`, default_branch: found.value.defaultBranch } : null;
    },
    ...repoFiles(env),
    agentTeams: async (agent) => (await identity.agentTeams(ctx.slug, agent.id, agent.team)).map((t) => ({ slug: t.slug, name: t.name })),
    audit,
  };
  return new Library({ db: ctx.db, workspaceId: ctx.workspaceId, slug: ctx.slug, viewer: { id: ctx.viewer.id, username: ctx.viewer.username, kind: ctx.viewer.kind }, owner: ctx.owner, ports });
}

/** Save as skill: the session's agent drafts it from the transcript, on its own budget. */
async function draftSkill(ctx: ViewContext, library: Library, id: unknown): Promise<Result<unknown>> {
  if ((ctx.viewer.kind ?? "user") !== "user") return fail("forbidden", "People save sessions as skills.");
  const row = await sessionRow(ctx.db, String(id ?? ""));
  if (!row || row.workspace_id !== ctx.workspaceId) return fail("not_found", "There is no such session.");
  const audience = await chatClient(ctx.env.CHAT)
    .audience(ctx.slug, row.channel_id)
    .catch(() => null);
  const visible = !!audience?.ok && (audience.value.kind === "public" || audience.value.member_user_ids.includes(ctx.viewer.id));
  if (!visible) return fail("not_found", "There is no such session.");
  if (row.status !== "done") return fail("invalid", "Save a session as a skill once it is done.");
  const agent = await ctx.db.prepare("SELECT * FROM agents WHERE id = ?").bind(row.agent_id).first<Row>();
  if (!agent) return fail("not_found", "The session's agent is gone.");
  const events = await ctx.db
    .prepare("SELECT kind, by_name, body, tool FROM agent_session_events WHERE session_id = ? ORDER BY seq LIMIT 600")
    .bind(row.id)
    .all<{ kind: string; by_name: string | null; body: string; tool: string | null }>();
  const transcript = transcriptText({ title: row.title, goal: row.goal, result: row.summary }, events.results);
  return saveDraft(library, { id: row.id, title: row.title, agent_handle: agent.handle }, async () => {
    const done = await metered(
      ctx.env,
      { row: agent, payer: agent, slug: ctx.slug, task: "session", start: "small", askerName: ctx.viewer.username, person: ctx.viewer.username },
      async (model) => {
        const answer = await runTurn(model.send, {
          model: model.model.model,
          system: DRAFT_SYSTEM,
          messages: [{ role: "user", content: transcript }],
          tools: null,
          price: model.ownModel ? null : model.model.price,
          maxRounds: 1,
          maxOutput: 4096,
        });
        return { ...answer, cost: model.ownModel ? 0 : answer.cost };
      },
    ).catch((error: unknown) => ({ ok: false as const, reason: "error", message: error instanceof Error ? error.message : String(error) }));
    if (!done.ok) return fail(done.reason === "error" ? "unavailable" : "limit", done.reason === "error" ? "The draft couldn't be written just now. Try again in a moment." : done.message);
    return ok(done.value.text);
  });
}

/** The library's methods, or null for one that isn't the library's. */
export async function skillRpc(
  method: string,
  args: any,
  view: <T>(a: { workspace: string; viewer: User | null }, run: (ctx: ViewContext) => Promise<Result<T>>) => Promise<Result<T>>,
  audit: (viewer: User, workspace: string, action: string, name: string, message: string) => void,
): Promise<Result<unknown> | null> {
  const library = (ctx: ViewContext) => libraryFor(ctx, (action, name, message) => audit(ctx.viewer, ctx.slug, action, name, message));
  switch (method) {
    case "skill_library":
      return view(args, (ctx) => library(ctx).library());
    case "skill":
      return view(args, (ctx) => library(ctx).detail(args.name, args.version));
    case "save_skill":
      return view(args, (ctx) => library(ctx).save(args.name, args.input));
    case "import_skill":
      return view(args, (ctx) => library(ctx).import(args.source, args.replace === true));
    case "attach_skill":
      return view(args, (ctx) => library(ctx).attach(args.name, args.scope, args.target));
    case "detach_skill":
      return view(args, (ctx) => library(ctx).detach(args.name, args.attachment));
    case "pin_skill":
      return view(args, (ctx) => library(ctx).pin(args.name, args.attachment, args.version ?? null));
    case "delete_skill":
      return view(args, (ctx) => library(ctx).remove(args.name));
    case "agent_skills":
      return view(args, (ctx) => library(ctx).agentSkills(args.handle));
    case "draft_skill":
      return view(args, (ctx) => draftSkill(ctx, library(ctx), args.session));
    case "set_skill_mirror":
      return view(args, (ctx) => library(ctx).setMirror(args.repo ?? null));
    case "sync_skill_mirror":
      return view(args, (ctx) => library(ctx).sync());
    default:
      return null;
  }
}

/** After pushes: libraries that follow a pushed repository's default branch read it again. */
export async function skillPushes(env: { DB: D1Database; REPOS: SessionEnv["REPOS"] }, pushed: { repoId: string }[]): Promise<void> {
  const repos = [...new Set(pushed.map((p) => p.repoId))];
  for (const repoId of repos) {
    await onPush(env.DB, repoFiles(env), repoId).catch((error: unknown) => console.error("agents: skills not read after a push", repoId, String(error)));
  }
}

