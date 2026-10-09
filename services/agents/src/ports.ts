/**
 * The reply's audience and tools, wired to g1t's services. Each call here
 * runs only after `Audience` and `ToolBox` decided it may (audience.ts,
 * tools.ts); the backing services check the viewer again, as they do for
 * every request.
 */
import {
  type Result,
  type ServiceBinding,
  type User,
  chatClient,
  docsClient,
  foliosClient,
  identityClient,
  reposClient,
  searchClient,
  workClient,
} from "@g1t/contracts";

import type { AudiencePorts, RepoRef } from "./audience.ts";
import type { FolioDone, FoliosPorts, FoundMessage, ToolPorts } from "./tools.ts";
import { RECALL_LIMIT, passageSource } from "./recall.ts";

export type PortsEnv = {
  DB: D1Database;
  CHAT: ServiceBinding;
  IDENTITY: ServiceBinding;
  REPOS: ServiceBinding;
  WORK: ServiceBinding;
  SEARCH: ServiceBinding;
  /** The docs service, for agents reading and writing artifacts; absent on an installation without it. */
  DOCS?: ServiceBinding;
};

const refOf = (repo: { id: string; namespace: string; name: string; isPrivate: boolean; defaultBranch: string; forkOf?: string | null }): RepoRef => ({
  id: repo.id,
  namespace: repo.namespace,
  name: repo.name,
  isPrivate: repo.isPrivate,
  defaultBranch: repo.defaultBranch,
  forkOf: repo.forkOf ?? null,
});

export function audiencePorts(env: PortsEnv, workspace: string, channelId: string): AudiencePorts {
  const repos = reposClient(env.REPOS);
  return {
    async info() {
      const found = await chatClient(env.CHAT).audience(workspace, channelId);
      if (!found.ok) throw new Error(`the conversation's audience could not be read: ${found.error.message}`);
      return found.value;
    },
    users: (ids) => identityClient(env.IDENTITY).usersForAudience(ids),
    workspaceRepos: async (viewer) => (await repos.list(viewer, { namespace: workspace, memberOnly: true })).map(refOf),
    readable: async (ids, viewer) => (await repos.readable(ids.slice(0, 500), viewer)).map(refOf),
  };
}

const found = (m: { channel_id: string; channel: string | null; message: { id: string; author: { name: string }; body: string; created_at: string; card: { title: string } | null } }): FoundMessage => ({
  channel: m.channel,
  channel_id: m.channel_id,
  id: m.message.id,
  author: m.message.author.name,
  body: m.message.body || (m.message.card ? `[card: ${m.message.card.title}]` : ""),
  created_at: m.message.created_at,
});

export function toolPorts(
  env: PortsEnv,
  workspace: string,
  workspaceId: string,
  channelId: string,
  consult: ToolPorts["consult"],
  agentId: string | null = null,
): ToolPorts {
  const repos = reposClient(env.REPOS);
  const work = workClient(env.WORK);
  const path = (repo: RepoRef) => ({ namespace: repo.namespace, name: repo.name });
  return {
    async readFile(repo, viewer, ref, file) {
      const blob = await repos.blob(path(repo), viewer, ref, file);
      return blob.ok ? { text: blob.value.text, size: blob.value.size } : null;
    },
    async searchCode(viewer, query, repo) {
      const results = await searchClient(env.SEARCH).search(viewer, repo ? `${query} repo:${repo.namespace}/${repo.name}` : query, { type: "code", perPage: 20 });
      if (!results.ok) return [];
      return results.value.hits
        .filter((hit) => hit.kind === "code" && hit.repo && hit.path)
        .map((hit) => ({
          repo: hit.repo!,
          path: hit.path!,
          snippet: hit.lines.map((line) => `${line.number}: ${line.parts.map((part) => part.text).join("")}`).join("\n"),
        }));
    },
    async listIssues(repo, viewer, state) {
      const issues = await work.listIssues(path(repo), viewer, { state });
      return issues.ok ? issues.value.map((i) => ({ number: i.number, title: i.title, state: i.state, labels: i.labels })) : null;
    },
    async getIssue(repo, number, viewer) {
      const detail = await work.getIssue(path(repo), number, viewer);
      if (!detail.ok) return null;
      const { issue, comments } = detail.value;
      return {
        number: issue.number,
        title: issue.title,
        state: issue.state,
        body: issue.body,
        comments: comments.filter((c) => c.kind === "comment").slice(-20).map((c) => ({ author: c.author.username, body: c.body })),
      };
    },
    async getPull(repo, number, viewer) {
      const detail = await work.getPull(path(repo), number, viewer);
      if (!detail.ok) return null;
      const { pull, checks } = detail.value;
      return {
        number: pull.number,
        title: pull.title,
        status: pull.status,
        body: pull.body ?? "",
        checks: checks ? `${checks.status}${checks.results.length ? `: ${checks.results.map((r) => `${r.command} ${r.passed ? "passed" : "failed"}`).join(", ")}` : ""}` : null,
      };
    },
    async recentPulls(list, viewer) {
      const byId = new Map(list.map((repo) => [repo.id, repo]));
      const groups = await work.pullsForRepos([...byId.keys()], viewer, 5);
      return groups
        .flatMap((group) => [...group.open, ...group.closed].map((pull) => ({ pull, repo: byId.get(group.repoId) })))
        .filter((entry) => entry.repo)
        .map(({ pull, repo }) => ({
          repo: `${repo!.namespace}/${repo!.name}`,
          number: pull.number,
          title: pull.title,
          status: pull.status,
          updated_at: pull.mergedAt ?? pull.updatedAt,
        }))
        .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
        .slice(0, 25);
    },
    async searchMessages(query) {
      const result = await chatClient(env.CHAT).searchForAgent(workspace, channelId, query, 20);
      return result.ok ? result.value.map(found) : null;
    },
    async readThread(target, id) {
      const result = await chatClient(env.CHAT).threadForAgent(workspace, channelId, target, id);
      return result.ok ? result.value.map(found) : null;
    },
    async roster(viewer: User | null) {
      const identity = identityClient(env.IDENTITY);
      const [members, teams, agents] = await Promise.all([
        viewer ? identity.listMembers(workspace, viewer).catch(() => null) : Promise.resolve(null),
        viewer ? identity.listTeams(viewer, workspace).catch(() => null) : Promise.resolve(null),
        env.DB.prepare("SELECT handle, display_name, title, role FROM agents WHERE workspace_id = ? AND archived_at IS NULL ORDER BY builtin DESC, handle")
          .bind(workspaceId)
          .all<{ handle: string; display_name: string; title: string; role: string }>(),
      ]);
      const people = members?.ok ? members.value.map((m) => `- @${m.username}${m.name ? ` (${m.name})` : ""}, ${m.role}`).join("\n") : "(people could not be listed)";
      const teamLines = teams?.ok ? teams.value.map((t) => `- ${t.slug}: ${t.name}${t.description ? `, ${t.description}` : ""}`).join("\n") : "";
      const agentLines = agents.results.map((a) => `- @${a.handle} (${a.display_name}): ${a.title || a.role}`).join("\n");
      return `People:\n${people}${teamLines ? `\n\nTeams:\n${teamLines}` : ""}\n\nAgents:\n${agentLines}`;
    },
    consult,
    ...(env.DOCS && agentId ? { folios: folioPorts(env.DOCS, env.CHAT, workspace, agentId) } : {}),
  };
}

/** A call's result as the tools take it: the value, or the error's code and sentence. */
const done = <T>(result: Result<T>): FolioDone<T> => (result.ok ? result : { ok: false, code: result.error.code, message: result.error.message });

/**
 * Artifacts (folios) as an agent reads and writes them: Markdown in,
 * Markdown out, every call checked by the docs service. Spaces still come
 * from the docs service's `spaces_for_agent`: spaces are shared by pages
 * and folios, and have no folio method of their own.
 */
function folioPorts(docs: ServiceBinding, chatBinding: ServiceBinding, workspace: string, agentId: string): FoliosPorts {
  const folios = foliosClient(docs);
  const where = (f: { title: string; path: string; id: string }) => `${f.title} (${f.path}, id ${f.id})`;
  return {
    async spaces(viewer, audience) {
      const found = await docsClient(docs).spacesForAgent(workspace, agentId, viewer, audience);
      if (!found.ok) return null;
      return found.value.map((s) => ({ id: s.id, slug: s.slug, name: s.name, description: s.description, kind: s.kind, projects: s.projects ?? [], can: s.can }));
    },
    async recall(viewer, audience, query, spaces, kinds) {
      const found = await folios.recallForAgent(workspace, agentId, viewer, { query, limit: RECALL_LIMIT, spaces, kinds: kinds ?? null }, audience);
      return found.ok ? found.value : null;
    },
    async search(viewer, audience, input) {
      const kinds = input.kind ? [input.kind] : null;
      // Passages too, when the search isn't narrowed to a space or project: recall can't be.
      const [list, passages] = await Promise.all([
        folios.foliosForAgent(workspace, agentId, viewer, { tab: "all", q: input.query, kinds, space_id: input.space_id, project: input.project, limit: 10 }, audience),
        input.space_id || input.project ? Promise.resolve(null) : folios.recallForAgent(workspace, agentId, viewer, { query: input.query, limit: 4, kinds }, audience).catch(() => null),
      ]);
      if (!list.ok) return null;
      const lines = list.value.items.map((f) => {
        const space = f.space ? `in ${f.space.name}` : "not in a space";
        return `- ${where(f)}: a ${f.kind} ${space}, edited ${f.edited_at.slice(0, 10)}${f.stale ? ", possibly out of date" : ""}${f.excerpt ? `: ${f.excerpt.replace(/\s+/g, " ").slice(0, 300)}` : ""}`;
      });
      const found = passages?.ok ? passages.value.map((p) => `### ${passageSource(p)}\n${p.text.trim().slice(0, 800)}`) : [];
      if (!lines.length && !found.length) return "No artifacts found.";
      return [lines.length ? lines.join("\n") : "No artifacts matched by title or words.", ...(found.length ? ["", "Passages that match:", "", found.join("\n\n")] : [])].join("\n");
    },
    read: async (viewer, audience, folioId) => done(await folios.readForAgent(workspace, agentId, viewer, folioId, audience)),
    async stale(viewer, audience, repo) {
      const found = await folios.staleForAgent(workspace, agentId, viewer, { repo }, audience);
      if (!found.ok) return null;
      if (!found.value.length) return "No artifacts are marked possibly out of date.";
      return found.value
        .map((f) => {
          const can = f.viewer_role === "edit" || f.viewer_role === "manage" ? (f.agent_mode === "edit" ? "you can edit" : "you can suggest") : f.viewer_role === "comment" ? "you can suggest" : "read only";
          return `- ${where(f)}, a ${f.kind} ${f.space ? `in ${f.space.name}` : "not in a space"} (${can}), edited ${f.edited_at.slice(0, 10)}`;
        })
        .join("\n");
    },
    async create(viewer, input) {
      const made = await folios.createAsAgent(workspace, agentId, viewer, {
        kind: input.kind,
        title: input.title,
        content: input.markdown === null ? null : { markdown: input.markdown },
        template_id: input.template_id,
        where: input.where,
        parent_id: input.parent_id,
        source: input.source,
      });
      return done(made);
    },
    edit: async (viewer, folioId, edit) => done(await folios.editAsAgent(workspace, agentId, viewer, folioId, edit)),
    async share(viewer, audience, folioId, userIds, role) {
      const shared = await folios.shareAsAgent(workspace, agentId, viewer, folioId, { user_ids: userIds, role }, audience);
      return shared.ok ? { ok: true, value: null } : done(shared);
    },
    async sendLink(asker, link, note) {
      const chat = chatClient(chatBinding);
      const dm = await chat.openDm(workspace, asker, [{ kind: "agent", id: agentId }]);
      if (!dm.ok) return false;
      // No mention, so it wakes nobody.
      const posted = await chat.postAsAgent(workspace, dm.value.id, agentId, { body: `${note} [${link.title.replace(/[[\]]/g, "")}](${link.path})`, asked_by: asker.id });
      return posted.ok;
    },
  };
}
