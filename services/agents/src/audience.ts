/**
 * Who will read an agent's answer, and so what it may read to write it
 * (docs.g1t.sh/guides/agent-access/, "What an agent can and can't
 * know"). Built once per reply; every tool asks it before reading anything.
 *
 * The rules, decided here in code, never by the model:
 * - The audience is the conversation's people: a DM's or a private
 *   channel's members. A public channel, or more than 50 people, is the
 *   whole workspace (`shared`).
 * - Code, issues and pull requests come only from repositories of this
 *   workspace that every person in the audience can read: the repos
 *   service is asked once per person (`readable`) and the answers are
 *   intersected. Anyone in the audience without Code access, or anyone
 *   who could not be resolved, means no code at all.
 * - A shared audience reads no code. Every member would have to be able to
 *   read it, and g1t cannot yet tell whether every member of a workspace
 *   has Code access; when in doubt, it denies.
 * - The model's arguments never widen this: a repository is looked up only
 *   in the allow-list, by this workspace's name for it.
 *
 * The person who asked is one of the audience, so anything every member
 * may read, they may too: tools call the backing services as them, after
 * this check.
 */
import type { User } from "@g1t/contracts";

export type AudienceInfo = { kind: "dm" | "private" | "public"; member_user_ids: string[]; member_count: number };

/** A repository as the allow-list keeps it. */
export type RepoRef = { id: string; namespace: string; name: string; isPrivate: boolean; defaultBranch: string; forkOf?: string | null };

/** What building an audience reaches outside this module. */
export interface AudiencePorts {
  /** Who reads the conversation (the chat service works it out from the channel). */
  info(): Promise<AudienceInfo>;
  /** People by id, with their workspaces and grants; ids it cannot resolve are left out. */
  users(ids: string[]): Promise<User[]>;
  /** The workspace's repositories `viewer` can see. */
  workspaceRepos(viewer: User): Promise<RepoRef[]>;
  /** Of these ids, the repositories `viewer` can read. */
  readable(ids: string[], viewer: User): Promise<RepoRef[]>;
}

/** Past this many people, an audience is the whole workspace's. */
export const SHARED_OVER = 50;

/** What a tool says when the audience may not see something: never whether it exists. */
export const WITHHELD = "Not available in this conversation.";

export class Audience {
  readonly workspace: string;
  readonly kind: AudienceInfo["kind"];
  readonly shared: boolean;
  /** The people, resolved; empty for a shared audience. */
  readonly members: User[];
  /** The person who asked, resolved, or null. */
  readonly asker: User | null;
  /** Whether every person could be resolved. */
  readonly complete: boolean;
  /** Stable for the same people: recorded with every tool call. */
  readonly hash: string;
  private readonly ports: AudiencePorts;
  private allowed: Promise<Map<string, RepoRef>> | null = null;

  private constructor(fields: {
    workspace: string;
    kind: AudienceInfo["kind"];
    shared: boolean;
    members: User[];
    asker: User | null;
    complete: boolean;
    hash: string;
    ports: AudiencePorts;
  }) {
    this.workspace = fields.workspace;
    this.kind = fields.kind;
    this.shared = fields.shared;
    this.members = fields.members;
    this.asker = fields.asker;
    this.complete = fields.complete;
    this.hash = fields.hash;
    this.ports = fields.ports;
  }

  static async build(workspace: string, askerId: string, ports: AudiencePorts): Promise<Audience> {
    const slug = workspace.toLowerCase();
    const info = await ports.info();
    const ids = [...new Set(info.member_user_ids)];
    const shared = info.kind === "public" || ids.length > SHARED_OVER || info.member_count > SHARED_OVER;
    const wanted = shared ? [askerId] : ids;
    const people = wanted.length ? await ports.users(wanted) : [];
    const asker = people.find((user) => user.id === askerId) ?? null;
    const members = shared ? [] : people;
    // Everyone found, the asker among them: anything less, and code is off.
    const complete = !shared && ids.length > 0 && ids.every((id) => people.some((user) => user.id === id)) && ids.includes(askerId);
    return new Audience({
      workspace: slug,
      kind: info.kind,
      shared,
      members,
      asker,
      complete,
      hash: audienceHash(info.kind, shared ? [] : ids),
      ports,
    });
  }

  /** Whether code, issues and pull requests may be read at all for this audience. */
  codeAllowed(): boolean {
    if (this.shared || !this.complete || !this.asker) return false;
    return this.members.every((user) => {
      const membership = user.workspaces?.find((m) => m.slug.toLowerCase() === this.workspace);
      // An outside collaborator reads through grants; a Chat-only member reads no code at all.
      return membership ? membership.code_access !== false : (user.grants ?? []).some((grant) => grant.workspace.toLowerCase() === this.workspace);
    });
  }

  /** The repositories every person in the audience can read, by lowercase `namespace/name`. */
  repos(): Promise<Map<string, RepoRef>> {
    this.allowed ??= this.computeRepos();
    return this.allowed;
  }

  private async computeRepos(): Promise<Map<string, RepoRef>> {
    const out = new Map<string, RepoRef>();
    if (!this.codeAllowed() || !this.asker) return out;
    const candidates = (await this.ports.workspaceRepos(this.asker)).filter(
      (repo) => repo.namespace.toLowerCase() === this.workspace && !repo.forkOf,
    );
    let ids = new Set(candidates.map((repo) => repo.id));
    for (const member of this.members) {
      if (!ids.size) break;
      const readable = new Set((await this.ports.readable([...ids], member)).map((repo) => repo.id));
      ids = new Set([...ids].filter((id) => readable.has(id)));
    }
    for (const repo of candidates) {
      if (ids.has(repo.id) && agentScopesAllow(repo)) out.set(`${repo.namespace}/${repo.name}`.toLowerCase(), repo);
    }
    return out;
  }

  /**
   * A repository the model named (`name` or `namespace/name`), only if it
   * is on the allow-list. Another workspace's, a private one someone can't
   * read, or one that does not exist: all null, alike.
   */
  async repo(named: unknown): Promise<RepoRef | null> {
    if (typeof named !== "string") return null;
    const trimmed = named.trim().replace(/^\/+|\/+$/g, "").toLowerCase();
    if (!trimmed || trimmed.split("/").length > 2) return null;
    const full = trimmed.includes("/") ? trimmed : `${this.workspace}/${trimmed}`;
    return (await this.repos()).get(full) ?? null;
  }
}

/**
 * Whether the agent's own scopes allow reading `repo`. Agents have no
 * scopes field yet: within its workspace, an agent may read what its
 * audience may. When scopes land, they narrow here.
 */
export function agentScopesAllow(_repo: RepoRef): boolean {
  return true;
}

/** A short, stable fingerprint of who reads: kind and sorted people. */
export function audienceHash(kind: string, ids: string[]): string {
  const text = `${kind}:${[...ids].sort().join(",")}`;
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < text.length; i++) {
    h1 = Math.imul(h1 ^ text.charCodeAt(i), 16777619) >>> 0;
    h2 = Math.imul(h2 + text.charCodeAt(i), 2654435761) >>> 0;
  }
  return `${h1.toString(16).padStart(8, "0")}${h2.toString(16).padStart(8, "0")}`;
}
