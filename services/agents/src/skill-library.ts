/**
 * The skill library (docs.g1t.sh/guides/agent-skills/, @g1t/contracts
 * skill-library.ts): a workspace's own skills, every change a new version,
 * attached to agents, teams or the whole workspace at a pinned version.
 *
 * - **Sources:** written in the editor; imported from an upload (SKILL.md
 *   or a zip) or a repository folder at one commit; drafted by an agent
 *   from a finished session and published once a person reviews it; or
 *   followed from the repository the library is linked to
 *   (`.g1t/skills/<name>/` on its default branch, read again after every
 *   push there). Writing back to that repository is coming.
 * - **Who:** everyone in the workspace sees the library and can save a
 *   draft from a session they can see; team maintainers write and import
 *   skills, edit their own, publish drafts and attach to their teams;
 *   owners do everything, for any skill.
 * - **Versions:** each attachment pins one. Saving moves the attachments
 *   the person saving may change (unless they say not to); the others show
 *   an update available. A push to the linked repository moves every
 *   attachment of the skills it changed: the repository's review is the
 *   review.
 * - **Never a permission:** a skill names tools agents have; it gives none.
 *
 * Identity and repositories come through `LibraryPorts`, so this runs
 * against SQLite in tests.
 */
import type { Result, SkillAttachment, SkillDetail, SkillFileEntry, SkillImport, SkillInput, SkillLibrary, SkillMirror, SkillOrigin, SkillScope, SkillStatus, SkillVersionEntry } from "@g1t/contracts";
import type { AgentSkillLine, AgentSkills, LibrarySkill } from "../../../packages/contracts/src/skill-library.ts";

import { newId } from "../../../packages/contracts/src/ids.ts";
import { fail, ok } from "../../../packages/contracts/src/result.ts";
import {
  type CheckedSkill,
  type SkillFile,
  SKILLS_PER_AGENT_MAX,
  SKILLS_REPO_DIR,
  SKILL_FILES_MAX,
  SKILL_FOLDER_MAX_BYTES,
  checkSkillFolder,
  parseFrontMatter,
  renderSkillMd,
  skillFileBytes,
  skillNameProblem,
  splitFrontMatter,
} from "../../../packages/contracts/src/skill-format.ts";
import { FOUNDATIONAL_SKILLS, FOUNDATIONAL_SKILLS_VERSION } from "../../../packages/contracts/src/skills.ts";
import { asSkillFile, readUpload } from "./skill-zip.ts";
import type { StoredVersion } from "./skills.ts";

/** The most skills one workspace's library holds. */
export const LIBRARY_MAX = 1000;
/** Text files up to this size are shown on a skill's page. */
const SHOWN_FILE_BYTES = 200 * 1024;

export type SkillRow = {
  id: string;
  workspace_id: string;
  name: string;
  status: SkillStatus;
  version: number;
  description: string;
  tools: string;
  requires_computer: number;
  files: number;
  bytes: number;
  origin: string;
  mirrored: number;
  created_by: string;
  created_at: string;
  updated_by: string;
  updated_at: string;
};

export type AttachmentRow = { id: string; skill_id: string; scope: SkillScope; target: string; version: number; attached_by: string; attached_at: string };

type VersionRow = {
  version: number;
  description: string;
  tools: string;
  requires_computer: number;
  skill_md: string;
  files: string;
  bytes: number;
  origin: string;
  note: string | null;
  created_by: string;
  created_at: string;
};

type MirrorRow = { workspace_id: string; repo_id: string; repo: string; branch: string; commit_sha: string | null; synced_at: string | null; error: string | null; linked_by: string; linked_at: string };

/** What the library needs from identity and repositories, as the viewer. */
export type LibraryPorts = {
  /** The workspace's teams the viewer can see, and whether they may manage each; null when identity didn't answer. */
  teams(): Promise<{ slug: string; name: string; can_manage: boolean }[] | null>;
  /** A repository the viewer can read, by `workspace/name`. */
  repo(full: string): Promise<{ id: string; full: string; default_branch: string } | null>;
  /** Every file at a branch, tag or commit (the default branch when null), without a viewer: check access first. */
  listFiles(repoId: string, ref: string | null): Promise<{ commit: string | null; files: { path: string; hash: string | null }[]; truncated: boolean }>;
  /** Blobs as base64; null data for one missing or over 1 MB. */
  blobs(repoId: string, hashes: string[]): Promise<{ hash: string; data: string | null }[]>;
  /** The visible teams an agent is on. */
  agentTeams(agentId: string): Promise<{ slug: string; name: string }[]>;
  /** The workspace's visible teams, each with the agents on it, by id. */
  teamAgentIndex(): Promise<{ slug: string; agent_ids: string[] }[]>;
  /** The workspace's audit log. */
  audit(action: string, name: string, message: string): void;
};

export type LibraryContext = {
  db: D1Database;
  workspaceId: string;
  slug: string;
  viewer: { id: string; username: string; kind?: string };
  /** Owns the workspace (or is its token). */
  owner: boolean;
  ports: LibraryPorts;
  now?: Date;
};

/** What the viewer may do: owners everything; maintainers for their teams. */
export type Actor = { username: string; owner: boolean; maintains: ReadonlySet<string> };

export function mayWrite(actor: Actor): boolean {
  return actor.owner || actor.maintains.size > 0;
}

export function mayChange(actor: Actor, scope: SkillScope, target: string): boolean {
  return actor.owner || (scope === "team" && actor.maintains.has(target));
}

export function mayEdit(actor: Actor, row: Pick<SkillRow, "status" | "created_by" | "mirrored">): boolean {
  if (row.mirrored) return false;
  if (!mayWrite(actor)) return false;
  return actor.owner || row.status === "draft" || row.created_by === actor.username;
}

export function mayDelete(actor: Actor, row: Pick<SkillRow, "status" | "created_by">, attachments: readonly Pick<AttachmentRow, "scope" | "target">[]): boolean {
  if (actor.owner) return true;
  if (row.status === "draft") return mayWrite(actor) || row.created_by === actor.username;
  return mayWrite(actor) && row.created_by === actor.username && attachments.every((a) => a.scope === "team" && actor.maintains.has(a.target));
}

function json<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export async function digestOf(skillMd: string, files: readonly SkillFile[]): Promise<string> {
  const data = new TextEncoder().encode(`${skillMd}\u0000${JSON.stringify(files.map((f) => [f.path, f.encoding ?? "utf8", f.content]))}`);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** A version's SKILL.md and files, for `use_skill`. */
export async function readVersion(db: D1Database, skillId: string, version: number): Promise<StoredVersion | null> {
  const row = await db.prepare("SELECT skill_md, files FROM skill_versions WHERE skill_id = ? AND version = ?").bind(skillId, version).first<{ skill_md: string; files: string }>();
  return row ? { skill_md: row.skill_md, files: json<SkillFile[]>(row.files, []) } : null;
}

async function skillByName(db: D1Database, workspaceId: string, name: string): Promise<SkillRow | null> {
  return db.prepare("SELECT * FROM skills WHERE workspace_id = ? AND name = ? AND archived_at IS NULL").bind(workspaceId, name).first<SkillRow>();
}

async function attachmentsOf(db: D1Database, skillIds: string[]): Promise<AttachmentRow[]> {
  if (!skillIds.length) return [];
  const rows = await db
    .prepare("SELECT id, skill_id, scope, target, version, attached_by, attached_at FROM skill_attachments WHERE skill_id IN (SELECT value FROM json_each(?)) ORDER BY attached_at")
    .bind(JSON.stringify(skillIds))
    .all<AttachmentRow>();
  return rows.results;
}

/**
 * Writes `checked` as the skill's next version (a new skill when there is
 * none), or publishes a draft in place, and moves the attachments `move`
 * picks to it. An unchanged folder writes nothing. Safe against two saves
 * at once: the second is told to look again.
 */
export async function writeVersion(
  db: D1Database,
  input: {
    workspaceId: string;
    existing: SkillRow | null;
    checked: CheckedSkill;
    origin: SkillOrigin;
    note: string | null;
    by: string;
    now: Date;
    status: SkillStatus;
    mirrored: boolean;
    move: (attachment: AttachmentRow) => boolean;
  },
): Promise<Result<{ id: string; version: number; changed: boolean; moved: number }>> {
  const { existing, checked, now } = input;
  const at = now.toISOString();
  const digest = await digestOf(checked.skill_md, checked.files);
  const filesJson = JSON.stringify(checked.files);
  const tools = JSON.stringify(checked.tools);
  const origin = JSON.stringify(input.origin);
  const summary = [checked.name, checked.description, tools, checked.requires_computer ? 1 : 0, checked.files.length, checked.bytes, origin, input.mirrored ? 1 : 0] as const;

  if (!existing) {
    const count = await db.prepare("SELECT COUNT(*) AS n FROM skills WHERE workspace_id = ? AND archived_at IS NULL").bind(input.workspaceId).first<{ n: number }>();
    if ((count?.n ?? 0) >= LIBRARY_MAX) return fail("invalid", `A workspace's library holds at most ${LIBRARY_MAX} skills.`);
    const id = newId("skl", now.getTime());
    try {
      await db.batch([
        db
          .prepare(
            `INSERT INTO skills (id, workspace_id, name, description, tools, requires_computer, files, bytes, origin, mirrored, status, version, created_by, created_at, updated_by, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 1, ?12, ?13, ?12, ?13)`,
          )
          .bind(id, input.workspaceId, ...summary, input.status, input.by, at),
        versionInsert(db, id, 1, checked, filesJson, origin, input.note, digest, input.by, at),
      ]);
    } catch (error) {
      if (String(error).includes("UNIQUE")) return fail("conflict", `The library already has a skill called ${checked.name}.`);
      throw error;
    }
    return ok({ id, version: 1, changed: true, moved: 0 });
  }

  if (checked.name !== existing.name) {
    const taken = await skillByName(db, input.workspaceId, checked.name);
    if (taken && taken.id !== existing.id) return fail("conflict", `The library already has a skill called ${checked.name}.`);
  }

  // A draft is published in place: it has no history yet.
  if (existing.status === "draft") {
    const [updated] = await db.batch([
      db
        .prepare(
          `UPDATE skills SET name = ?1, description = ?2, tools = ?3, requires_computer = ?4, files = ?5, bytes = ?6, origin = ?7, mirrored = ?8, status = ?9, updated_by = ?10, updated_at = ?11
           WHERE id = ?12 AND version = ?13 AND status = 'draft'`,
        )
        .bind(...summary, input.status, input.by, at, existing.id, existing.version),
      db
        .prepare(
          `UPDATE skill_versions SET description = ?1, tools = ?2, requires_computer = ?3, skill_md = ?4, files = ?5, bytes = ?6, note = ?7, digest = ?8, created_by = ?9, created_at = ?10
           WHERE skill_id = ?11 AND version = ?12`,
        )
        .bind(checked.description, tools, checked.requires_computer ? 1 : 0, checked.skill_md, filesJson, checked.bytes, input.note, digest, input.by, at, existing.id, existing.version),
    ]);
    if (!updated?.meta?.changes) return fail("conflict", `${existing.name} was changed meanwhile. Reload it and try again.`);
    return ok({ id: existing.id, version: existing.version, changed: true, moved: 0 });
  }

  const latest = await db.prepare("SELECT digest FROM skill_versions WHERE skill_id = ? AND version = ?").bind(existing.id, existing.version).first<{ digest: string }>();
  const attachments = await attachmentsOf(db, [existing.id]);
  if (latest?.digest === digest && checked.name === existing.name) {
    // Nothing new; a stale attachment may still be moved on request.
    const stale = attachments.filter((a) => a.version !== existing.version && input.move(a));
    if (stale.length) await db.prepare("UPDATE skill_attachments SET version = ? WHERE id IN (SELECT value FROM json_each(?))").bind(existing.version, JSON.stringify(stale.map((a) => a.id))).run();
    if (!!existing.mirrored !== input.mirrored) await db.prepare("UPDATE skills SET mirrored = ? WHERE id = ?").bind(input.mirrored ? 1 : 0, existing.id).run();
    return ok({ id: existing.id, version: existing.version, changed: false, moved: stale.length });
  }
  const version = existing.version + 1;
  const moving = attachments.filter(input.move).map((a) => a.id);
  try {
    const [updated] = await db.batch([
      db
        .prepare(
          `UPDATE skills SET name = ?1, description = ?2, tools = ?3, requires_computer = ?4, files = ?5, bytes = ?6, origin = ?7, mirrored = ?8, version = ?9, updated_by = ?10, updated_at = ?11
           WHERE id = ?12 AND version = ?13`,
        )
        .bind(...summary, version, input.by, at, existing.id, existing.version),
      versionInsert(db, existing.id, version, checked, filesJson, origin, input.note, digest, input.by, at),
      db
        .prepare("UPDATE skill_attachments SET version = ?1 WHERE id IN (SELECT value FROM json_each(?2)) AND EXISTS (SELECT 1 FROM skills WHERE id = ?3 AND version = ?1)")
        .bind(version, JSON.stringify(moving), existing.id),
    ]);
    if (!updated?.meta?.changes) return fail("conflict", `${existing.name} was changed meanwhile. Reload it and try again.`);
  } catch (error) {
    if (String(error).includes("UNIQUE")) return fail("conflict", `${existing.name} was changed meanwhile. Reload it and try again.`);
    throw error;
  }
  return ok({ id: existing.id, version, changed: true, moved: moving.length });
}

function versionInsert(db: D1Database, id: string, version: number, checked: CheckedSkill, files: string, origin: string, note: string | null, digest: string, by: string, at: string): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO skill_versions (skill_id, version, description, tools, requires_computer, skill_md, files, bytes, origin, note, digest, created_by, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)`,
    )
    .bind(id, version, checked.description, JSON.stringify(checked.tools), checked.requires_computer ? 1 : 0, checked.skill_md, files, checked.bytes, origin, note, digest, by, at);
}

/** A version note, tidied: one line, at most 200 characters. */
function cleanNote(note: unknown): string | null {
  if (typeof note !== "string") return null;
  const line = note.replace(/\s+/g, " ").trim().slice(0, 200);
  return line || null;
}

/** Text from a repository blob, or its bytes as base64. */
function blobFile(path: string, data: string): SkillFile {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return asSkillFile(path, bytes);
}

/** A skill's folder read from a repository: every file under `dir` at the listing's commit. */
async function readRepoFolder(
  ports: Pick<LibraryPorts, "blobs">,
  repoId: string,
  listing: { path: string; hash: string | null }[],
  dir: string,
): Promise<Result<SkillFile[]>> {
  const prefix = dir ? `${dir}/` : "";
  const wanted = listing.filter((f): f is { path: string; hash: string } => !!f.hash && f.path.startsWith(prefix));
  if (!wanted.length) return fail("not_found", `There are no files in ${dir || "the repository's top folder"}.`);
  if (wanted.length > SKILL_FILES_MAX) return fail("invalid", `A skill holds at most ${SKILL_FILES_MAX} files; ${dir || "that folder"} has ${wanted.length}.`);
  const data = new Map<string, string | null>();
  const hashes = [...new Set(wanted.map((f) => f.hash))];
  for (let i = 0; i < hashes.length; i += 100) {
    for (const blob of await ports.blobs(repoId, hashes.slice(i, i + 100))) data.set(blob.hash, blob.data);
  }
  const files: SkillFile[] = [];
  let bytes = 0;
  for (const file of wanted) {
    const content = data.get(file.hash);
    if (content == null) return fail("invalid", `${file.path} is too large for a skill (at most 1 MB for the whole folder).`);
    const one = blobFile(file.path.slice(prefix.length), content);
    bytes += skillFileBytes(one);
    if (bytes > SKILL_FOLDER_MAX_BYTES) return fail("invalid", `${dir || "That folder"} is over 1 MB, the most a skill holds.`);
    files.push(one);
  }
  return ok(files);
}

/**
 * Reads the repository a library follows: each `.g1t/skills/<name>/`
 * folder becomes or updates the skill of its name (moving its
 * attachments), and skills whose folder is gone stop following it.
 * Returns what changed and what couldn't be read.
 */
export async function syncMirror(
  db: D1Database,
  ports: Pick<LibraryPorts, "listFiles" | "blobs">,
  mirror: MirrorRow,
  now: Date,
): Promise<{ changed: string[]; problems: string[]; commit: string | null }> {
  const changed: string[] = [];
  const problems: string[] = [];
  let commit: string | null = null;
  try {
    const listing = await ports.listFiles(mirror.repo_id, null);
    commit = listing.commit;
    const base = `${SKILLS_REPO_DIR}/`;
    const folders = [...new Set(listing.files.filter((f) => f.path.startsWith(base) && f.path.slice(base.length).includes("/")).map((f) => f.path.slice(base.length).split("/")[0]!))].sort();
    if (listing.truncated) problems.push("The repository has more files than g1t reads at once, so some skills may be missing.");
    const seen = new Set<string>();
    for (const folder of folders.slice(0, 200)) {
      seen.add(folder);
      const files = await readRepoFolder(ports, mirror.repo_id, listing.files, `${base}${folder}`);
      if (!files.ok) {
        problems.push(`${folder}: ${files.error.message}`);
        continue;
      }
      const checked = checkSkillFolder(files.value, { expectName: folder });
      if (!checked.ok) {
        problems.push(`${folder}: ${checked.message}`);
        continue;
      }
      const existing = await skillByName(db, mirror.workspace_id, checked.skill.name);
      if (existing && !existing.mirrored) {
        problems.push(`${folder}: the library already has a skill called ${folder} that isn't from this repository. Rename one of them.`);
        continue;
      }
      const written = await writeVersion(db, {
        workspaceId: mirror.workspace_id,
        existing,
        checked: checked.skill,
        origin: { kind: "mirror", repo: mirror.repo, path: `${base}${folder}`, commit: commit ?? "" },
        note: commit ? `From ${mirror.repo} at ${commit.slice(0, 8)}` : null,
        by: mirror.linked_by,
        now,
        status: "published",
        mirrored: true,
        // The repository's own review is the review: every attachment follows.
        move: () => true,
      });
      if (!written.ok) problems.push(`${folder}: ${written.error.message}`);
      else if (written.value.changed) changed.push(folder);
    }
    // Gone from the repository: kept in the library, editable here again.
    const following = await db.prepare("SELECT name FROM skills WHERE workspace_id = ? AND mirrored = 1 AND archived_at IS NULL").bind(mirror.workspace_id).all<{ name: string }>();
    for (const { name } of following.results) {
      if (seen.has(name)) continue;
      await db.prepare("UPDATE skills SET mirrored = 0 WHERE workspace_id = ? AND name = ? AND archived_at IS NULL").bind(mirror.workspace_id, name).run();
      problems.push(`${name} is no longer in the repository. It stays in the library, and can be edited here.`);
    }
  } catch (error) {
    console.error("agents: a skills repository wasn't read", mirror.repo, String(error));
    problems.push("The repository couldn't be read just now.");
  }
  await db
    .prepare("UPDATE skill_mirrors SET commit_sha = COALESCE(?, commit_sha), synced_at = ?, error = ? WHERE workspace_id = ?")
    .bind(commit, now.toISOString(), problems.length ? problems.join("\n").slice(0, 4000) : null, mirror.workspace_id)
    .run();
  return { changed, problems, commit };
}

/** After a push to a repository's default branch: every library that follows it is read again. */
export async function onPush(db: D1Database, ports: Pick<LibraryPorts, "listFiles" | "blobs">, repoId: string, now = new Date()): Promise<number> {
  const mirrors = await db.prepare("SELECT * FROM skill_mirrors WHERE repo_id = ?").bind(repoId).all<MirrorRow>();
  for (const mirror of mirrors.results) await syncMirror(db, ports, mirror, now);
  return mirrors.results.length;
}

function mirrorOut(row: MirrorRow | null): SkillMirror | null {
  if (!row) return null;
  return { repo: row.repo, branch: row.branch, commit: row.commit_sha, synced_at: row.synced_at, error: row.error, linked_by: row.linked_by, linked_at: row.linked_at };
}

/** A library skill as its pages show it. */
function skillOut(row: SkillRow, attachments: AttachmentRow[], actor: Actor, labels: Labels): LibrarySkill {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    status: row.status,
    version: row.version,
    tools: json<string[]>(row.tools, []),
    requires_computer: !!row.requires_computer,
    files: row.files,
    bytes: row.bytes,
    origin: json<SkillOrigin>(row.origin, { kind: "written" }),
    mirrored: !!row.mirrored,
    attachments: attachments.map((a) => attachmentOut(a, actor, labels)),
    created_by: row.created_by,
    created_at: row.created_at,
    updated_by: row.updated_by,
    updated_at: row.updated_at,
    can_edit: mayEdit(actor, row),
    can_delete: mayDelete(actor, row, attachments),
  };
}

type Labels = { agents: Map<string, { handle: string; display_name: string }>; teams: Map<string, string> };

function attachmentOut(a: AttachmentRow, actor: Actor, labels: Labels): SkillAttachment {
  const agent = a.scope === "agent" ? labels.agents.get(a.target) : null;
  const target = a.scope === "agent" ? (agent?.handle ?? null) : a.scope === "team" ? a.target : null;
  const label = a.scope === "workspace" ? "Every agent" : a.scope === "agent" ? (agent ? `@${agent.handle}` : "An archived agent") : (labels.teams.get(a.target) ?? a.target);
  return { id: a.id, scope: a.scope, target, label, version: a.version, attached_by: a.attached_by, attached_at: a.attached_at, can_change: mayChange(actor, a.scope, a.target) };
}

/** One workspace's library, as one viewer may use it. */
export class Library {
  private readonly ctx: LibraryContext;
  private teamList: { slug: string; name: string; can_manage: boolean }[] | null = null;

  constructor(ctx: LibraryContext) {
    this.ctx = ctx;
  }

  private get db(): D1Database {
    return this.ctx.db;
  }

  private now(): Date {
    return this.ctx.now ?? new Date();
  }

  private async teams(): Promise<{ slug: string; name: string; can_manage: boolean }[]> {
    this.teamList ??= (await this.ctx.ports.teams().catch(() => null)) ?? [];
    return this.teamList;
  }

  async actor(): Promise<Actor> {
    const teams = this.ctx.viewer.kind === "agent" ? [] : await this.teams();
    return { username: this.ctx.viewer.username, owner: this.ctx.owner, maintains: new Set(teams.filter((t) => this.ctx.owner || t.can_manage).map((t) => t.slug)) };
  }

  private async labels(): Promise<Labels> {
    const [agents, teams] = await Promise.all([
      this.db.prepare("SELECT id, handle, display_name FROM agents WHERE workspace_id = ? AND archived_at IS NULL ORDER BY builtin DESC, handle").bind(this.ctx.workspaceId).all<{ id: string; handle: string; display_name: string }>(),
      this.teams(),
    ]);
    return { agents: new Map(agents.results.map((a) => [a.id, a])), teams: new Map(teams.map((t) => [t.slug, t.name])) };
  }

  private audit(action: string, name: string, message: string): void {
    try {
      this.ctx.ports.audit(action, name, message);
    } catch {
      // The log never fails the change.
    }
  }

  async library(): Promise<Result<SkillLibrary>> {
    const [rows, mirror, actor, labels] = await Promise.all([
      this.db.prepare("SELECT * FROM skills WHERE workspace_id = ? AND archived_at IS NULL ORDER BY status = 'draft' DESC, name LIMIT ?").bind(this.ctx.workspaceId, LIBRARY_MAX).all<SkillRow>(),
      this.db.prepare("SELECT * FROM skill_mirrors WHERE workspace_id = ?").bind(this.ctx.workspaceId).first<MirrorRow>(),
      this.actor(),
      this.labels(),
    ]);
    const attachments = await attachmentsOf(this.db, rows.results.map((r) => r.id));
    const teams = await this.teams();
    return ok({
      skills: rows.results.map((row) => skillOut(row, attachments.filter((a) => a.skill_id === row.id), actor, labels)),
      mirror: mirrorOut(mirror),
      can_write: mayWrite(actor),
      can_manage: actor.owner,
      teams: teams.filter((t) => actor.maintains.has(t.slug)).map((t) => ({ slug: t.slug, name: t.name })),
      agents: actor.owner ? [...labels.agents.values()].map((a) => ({ handle: a.handle, display_name: a.display_name })) : [],
    });
  }

  private async named(name: unknown): Promise<Result<SkillRow>> {
    const key = String(name ?? "").trim().toLowerCase();
    const row = key ? await skillByName(this.db, this.ctx.workspaceId, key) : null;
    if (row) return ok(row);
    if (FOUNDATIONAL_SKILLS.some((s) => s.id === key)) return fail("not_found", `${key} is one of g1t's foundational skills: see it on any agent's Skills tab.`);
    return fail("not_found", `The library has no skill called ${key || "that"}.`);
  }

  async detail(name: unknown, version?: unknown): Promise<Result<SkillDetail>> {
    const found = await this.named(name);
    if (!found.ok) return found;
    const row = found.value;
    const shown = version == null || version === "" ? row.version : Math.floor(Number(version));
    const [stored, versions, attachments, actor, labels] = await Promise.all([
      this.db.prepare("SELECT * FROM skill_versions WHERE skill_id = ? AND version = ?").bind(row.id, shown).first<VersionRow>(),
      this.db
        .prepare("SELECT version, description, note, origin, bytes, json_array_length(files) AS files, created_by, created_at FROM skill_versions WHERE skill_id = ? ORDER BY version DESC LIMIT 200")
        .bind(row.id)
        .all<{ version: number; description: string; note: string | null; origin: string; bytes: number; files: number; created_by: string; created_at: string }>(),
      attachmentsOf(this.db, [row.id]),
      this.actor(),
      this.labels(),
    ]);
    if (!stored) return fail("not_found", `${row.name} has no version ${shown}.`);
    const split = splitFrontMatter(stored.skill_md);
    let extra: Record<string, unknown> = {};
    if (split.ok) {
      try {
        const front = parseFrontMatter(split.yaml);
        for (const [key, value] of Object.entries(front)) if (!["name", "description", "tools", "requires_computer"].includes(key)) extra[key] = value;
      } catch {
        extra = {};
      }
    }
    const files: SkillFileEntry[] = json<SkillFile[]>(stored.files, []).map((f) => {
      const bytes = skillFileBytes(f);
      return { path: f.path, bytes, encoding: f.encoding === "base64" ? "base64" : "utf8", content: f.encoding !== "base64" && bytes <= SHOWN_FILE_BYTES ? f.content : null, script: f.path.startsWith("scripts/") };
    });
    const history: SkillVersionEntry[] = versions.results.map((v) => ({
      version: v.version,
      description: v.description,
      note: v.note,
      origin: json<SkillOrigin>(v.origin, { kind: "written" }),
      bytes: v.bytes,
      files: v.files ?? 0,
      created_by: v.created_by,
      created_at: v.created_at,
    }));
    return ok({
      skill: skillOut(row, attachments, actor, labels),
      shown,
      skill_md: stored.skill_md,
      instructions: split.ok ? split.body.trim() : stored.skill_md,
      tools: json<string[]>(stored.tools, []),
      requires_computer: !!stored.requires_computer,
      extra,
      files,
      versions: history,
    });
  }

  /** Writes a skill from the editor: a new one, a new version, or a draft published. */
  async save(name: unknown, input: SkillInput): Promise<Result<SkillDetail>> {
    const actor = await this.actor();
    if (!mayWrite(actor)) return fail("forbidden", "Only the workspace's owners and team maintainers write skills.");
    if (!input || typeof input !== "object") return fail("invalid", "Say what the skill is.");
    let existing: SkillRow | null = null;
    let prior: StoredVersion | null = null;
    if (name != null && name !== "") {
      const found = await this.named(name);
      if (!found.ok) return found;
      existing = found.value;
      if (existing.mirrored) return fail("invalid", `${existing.name} follows the repository: change it there, in ${SKILLS_REPO_DIR}/${existing.name}/.`);
      if (!mayEdit(actor, existing)) return fail("forbidden", "Owners edit any skill; team maintainers edit the skills they wrote.");
      prior = await readVersion(this.db, existing.id, existing.version);
    }
    const skillName = String(input.name ?? "").trim().toLowerCase();
    const problem = skillNameProblem(skillName);
    if (problem) return fail("invalid", problem);
    const description = String(input.description ?? "").trim();
    const instructions = String(input.instructions ?? "").trim();
    const tools = Array.isArray(input.tools) ? input.tools.filter((t): t is string => typeof t === "string") : [];
    let extra: Record<string, unknown> = {};
    if (prior) {
      const split = splitFrontMatter(prior.skill_md);
      try {
        if (split.ok) for (const [key, value] of Object.entries(parseFrontMatter(split.yaml))) if (!["name", "description", "tools", "requires_computer"].includes(key)) extra[key] = value;
      } catch {
        extra = {};
      }
    }
    // The current version's files, less those removed, with those added (by path).
    const removed = new Set(Array.isArray(input.remove_files) ? input.remove_files.filter((p): p is string => typeof p === "string") : []);
    const added = Array.isArray(input.add_files) ? input.add_files.filter((f): f is SkillFile => !!f && typeof f.path === "string" && typeof f.content === "string") : [];
    const addedPaths = new Set(added.map((f) => f.path.replace(/^\.\//, "")));
    const files = [...(prior?.files ?? []).filter((f) => !removed.has(f.path) && !addedPaths.has(f.path)), ...added];
    const skillMd = renderSkillMd({ name: skillName, description, tools, requires_computer: input.requires_computer === true, body: instructions, extra });
    const checked = checkSkillFolder([{ path: "SKILL.md", content: skillMd }, ...files.filter((f) => f?.path !== "SKILL.md")]);
    if (!checked.ok) return fail("invalid", checked.message);
    const publishing = existing?.status === "draft";
    const updateAll = input.update_attachments !== false;
    const written = await writeVersion(this.db, {
      workspaceId: this.ctx.workspaceId,
      existing,
      checked: checked.skill,
      origin: existing && publishing ? json<SkillOrigin>(existing.origin, { kind: "written" }) : { kind: "written" },
      note: cleanNote(input.note),
      by: actor.username,
      now: this.now(),
      status: "published",
      mirrored: false,
      move: (a) => updateAll && mayChange(actor, a.scope, a.target),
    });
    if (!written.ok) return written;
    const verb = !existing ? "Wrote" : publishing ? "Published" : written.value.changed ? "Changed" : "Saved";
    if (written.value.changed || !existing) this.audit(publishing ? "publish_skill" : existing ? "update_skill" : "create_skill", skillName, `${verb} the skill ${skillName} (version ${written.value.version})`);
    return this.detail(skillName);
  }

  /** Imports a skill from an upload or a repository folder. */
  async import(source: SkillImport, replace: boolean): Promise<Result<SkillDetail>> {
    const actor = await this.actor();
    if (!mayWrite(actor)) return fail("forbidden", "Only the workspace's owners and team maintainers import skills.");
    let files: SkillFile[];
    let origin: SkillOrigin;
    if (source?.kind === "upload") {
      const filename = String(source.filename ?? "").slice(0, 200);
      const read = await readUpload(filename, String(source.data_base64 ?? ""));
      if (!read.ok) return fail("invalid", read.message);
      files = read.files;
      origin = { kind: "upload", filename: filename || "SKILL.md" };
    } else if (source?.kind === "repository") {
      const full = String(source.repo ?? "").trim().replace(/^\/+|\/+$/g, "").replace(/\.git$/, "");
      if (!/^[^/\s]+\/[^/\s]+$/.test(full)) return fail("invalid", "Name the repository as workspace/name.");
      const repo = await this.ctx.ports.repo(full);
      if (!repo) return fail("not_found", `There is no repository ${full} you can read.`);
      let dir = String(source.path ?? "").trim().replace(/^\/+|\/+$/g, "");
      if (/(^|\/)SKILL\.md$/i.test(dir)) dir = dir.replace(/\/?SKILL\.md$/i, "");
      const ref = String(source.ref ?? "").trim() || repo.default_branch;
      const listing = await this.ctx.ports.listFiles(repo.id, ref).catch(() => null);
      if (!listing?.commit) return fail("not_found", `${full} has no branch, tag or commit called ${ref}.`);
      const read = await readRepoFolder(this.ctx.ports, repo.id, listing.files, dir);
      if (!read.ok) return read;
      files = read.value;
      origin = { kind: "repository", repo: repo.full, path: dir || ".", ref, commit: listing.commit };
    } else return fail("invalid", "Import from an upload or a repository folder.");
    const checked = checkSkillFolder(files);
    if (!checked.ok) return fail("invalid", checked.message);
    const existing = await skillByName(this.db, this.ctx.workspaceId, checked.skill.name);
    if (existing && !replace) {
      return fail("conflict", `The library already has a skill called ${checked.skill.name}. Import it as a new version of ${checked.skill.name}, or change the name in its SKILL.md.`);
    }
    if (existing?.mirrored) return fail("invalid", `${existing.name} follows the repository: change it there, in ${SKILLS_REPO_DIR}/${existing.name}/.`);
    if (existing && !mayEdit(actor, existing)) return fail("forbidden", "Owners edit any skill; team maintainers edit the skills they wrote.");
    const written = await writeVersion(this.db, {
      workspaceId: this.ctx.workspaceId,
      existing,
      checked: checked.skill,
      origin,
      note: origin.kind === "repository" ? `Imported from ${origin.repo} at ${origin.commit.slice(0, 8)}` : `Imported from ${origin.kind === "upload" ? origin.filename : "an upload"}`,
      by: actor.username,
      now: this.now(),
      status: "published",
      mirrored: false,
      move: (a) => mayChange(actor, a.scope, a.target),
    });
    if (!written.ok) return written;
    this.audit("import_skill", checked.skill.name, `Imported the skill ${checked.skill.name} (version ${written.value.version})`);
    return this.detail(checked.skill.name);
  }

  /** Saves a draft an agent wrote from a session; a person publishes it after reviewing it. */
  async saveDraft(checked: CheckedSkill, origin: Extract<SkillOrigin, { kind: "session" }>): Promise<Result<SkillDetail>> {
    let name = checked.name;
    for (let n = 2; await skillByName(this.db, this.ctx.workspaceId, name); n++) {
      name = `${checked.name.slice(0, 60)}-${n}`;
      if (n > 50) return fail("conflict", "Too many skills share that name.");
    }
    const renamed = name === checked.name ? checked : { ...checked, name, skill_md: checked.skill_md.replace(/^name:.*$/m, `name: ${name}`) };
    const written = await writeVersion(this.db, {
      workspaceId: this.ctx.workspaceId,
      existing: null,
      checked: renamed,
      origin,
      note: `Drafted by @${origin.agent} from the session "${origin.title}"`,
      by: this.ctx.viewer.username,
      now: this.now(),
      status: "draft",
      mirrored: false,
      move: () => false,
    });
    if (!written.ok) return written;
    this.audit("draft_skill", name, `Saved a draft skill ${name} from a session of @${origin.agent}`);
    return this.detail(name);
  }

  async attach(name: unknown, scope: unknown, target: unknown): Promise<Result<SkillDetail>> {
    const found = await this.named(name);
    if (!found.ok) return found;
    const row = found.value;
    if (row.status === "draft") return fail("invalid", "Publish the draft before attaching it.");
    if (scope !== "agent" && scope !== "team" && scope !== "workspace") return fail("invalid", "Attach a skill to an agent, a team or the whole workspace.");
    const actor = await this.actor();
    let key = "";
    let label = "every agent";
    if (scope === "agent") {
      const handle = String(target ?? "").trim().replace(/^@/, "").toLowerCase();
      const agent = await this.db.prepare("SELECT id, handle FROM agents WHERE workspace_id = ? AND handle = ? AND archived_at IS NULL").bind(this.ctx.workspaceId, handle).first<{ id: string; handle: string }>();
      if (!agent) return fail("not_found", `There is no agent called @${handle}.`);
      key = agent.id;
      label = `@${agent.handle}`;
    } else if (scope === "team") {
      const slug = String(target ?? "").trim().toLowerCase();
      const team = (await this.teams()).find((t) => t.slug === slug);
      if (!team) return fail("not_found", `${this.ctx.slug} has no team called ${slug}.`);
      key = team.slug;
      label = team.name;
    }
    if (!mayChange(actor, scope, key)) {
      return fail("forbidden", scope === "team" ? "Only owners and the team's maintainers attach skills to it." : "Only the workspace's owners attach skills to agents and to every agent.");
    }
    // At most SKILLS_PER_AGENT_MAX reach any one agent, through the teams it is on (team
    // memberships, from identity): counted for each agent this attachment reaches.
    const index = await this.ctx.ports.teamAgentIndex().catch(() => []);
    const memberships = JSON.stringify(index.flatMap((team) => team.agent_ids.map((id) => [id, team.slug])));
    const which = scope === "workspace" ? "?3 = ?3" : scope === "team" ? "EXISTS (SELECT 1 FROM m WHERE m.agent_id = ag.id AND m.slug = ?3)" : "ag.id = ?3";
    const most = await this.db
      .prepare(
        `WITH m(agent_id, slug) AS (SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]') FROM json_each(?4))
         SELECT COALESCE(MAX(n), 0) AS n FROM (
           SELECT ag.id, COUNT(DISTINCT a.skill_id) AS n
           FROM agents ag
           JOIN skill_attachments a ON a.workspace_id = ag.workspace_id
             AND (a.scope = 'workspace' OR (a.scope = 'agent' AND a.target = ag.id) OR (a.scope = 'team' AND EXISTS (SELECT 1 FROM m WHERE m.agent_id = ag.id AND m.slug = a.target)))
           JOIN skills s ON s.id = a.skill_id AND s.archived_at IS NULL
           WHERE ag.workspace_id = ?1 AND ag.archived_at IS NULL AND a.skill_id <> ?2 AND ${which}
           GROUP BY ag.id)`,
      )
      .bind(this.ctx.workspaceId, row.id, key, memberships)
      .first<{ n: number }>();
    // And what is attached where it lands already, for a team or workspace with no agents yet.
    const reach =
      scope === "workspace" ? "(a.scope = 'workspace' AND ?3 = ?3)" : scope === "team" ? "(a.scope = 'workspace' OR (a.scope = 'team' AND a.target = ?3))" : "(a.scope = 'workspace' OR (a.scope = 'agent' AND a.target = ?3))";
    const count = await this.db
      .prepare(`SELECT COUNT(DISTINCT a.skill_id) AS n FROM skill_attachments a JOIN skills s ON s.id = a.skill_id AND s.archived_at IS NULL WHERE a.workspace_id = ?1 AND a.skill_id <> ?2 AND ${reach}`)
      .bind(this.ctx.workspaceId, row.id, key)
      .first<{ n: number }>();
    if (Math.max(count?.n ?? 0, most?.n ?? 0) >= SKILLS_PER_AGENT_MAX) {
      return fail("invalid", `An agent has at most ${SKILLS_PER_AGENT_MAX} skills from the library, and ${scope === "workspace" ? "an agent" : label} would have more. Detach one first.`);
    }
    const inserted = await this.db
      .prepare(
        `INSERT INTO skill_attachments (id, workspace_id, skill_id, scope, target, version, attached_by, attached_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (skill_id, scope, target) DO NOTHING`,
      )
      .bind(newId("ska"), this.ctx.workspaceId, row.id, scope, key, row.version, actor.username, this.now().toISOString())
      .run();
    if (!inserted.meta?.changes) return fail("conflict", `${row.name} is already attached to ${label}.`);
    this.audit("attach_skill", row.name, `Attached the skill ${row.name} (version ${row.version}) to ${label}`);
    return this.detail(row.name);
  }

  private async attachment(name: unknown, id: unknown): Promise<Result<{ row: SkillRow; attachment: AttachmentRow; actor: Actor }>> {
    const found = await this.named(name);
    if (!found.ok) return found;
    const attachment = await this.db
      .prepare("SELECT id, skill_id, scope, target, version, attached_by, attached_at FROM skill_attachments WHERE id = ? AND skill_id = ?")
      .bind(String(id ?? ""), found.value.id)
      .first<AttachmentRow>();
    if (!attachment) return fail("not_found", `${found.value.name} isn't attached there.`);
    const actor = await this.actor();
    if (!mayChange(actor, attachment.scope, attachment.target)) {
      return fail("forbidden", attachment.scope === "team" ? "Only owners and the team's maintainers change what is attached to it." : "Only the workspace's owners change this attachment.");
    }
    return ok({ row: found.value, attachment, actor });
  }

  async detach(name: unknown, id: unknown): Promise<Result<SkillDetail>> {
    const found = await this.attachment(name, id);
    if (!found.ok) return found;
    await this.db.prepare("DELETE FROM skill_attachments WHERE id = ?").bind(found.value.attachment.id).run();
    this.audit("detach_skill", found.value.row.name, `Detached the skill ${found.value.row.name} (${found.value.attachment.scope})`);
    return this.detail(found.value.row.name);
  }

  async pin(name: unknown, id: unknown, version: unknown): Promise<Result<SkillDetail>> {
    const found = await this.attachment(name, id);
    if (!found.ok) return found;
    const { row, attachment } = found.value;
    const to = version == null ? row.version : Math.floor(Number(version));
    const exists = await this.db.prepare("SELECT 1 AS one FROM skill_versions WHERE skill_id = ? AND version = ?").bind(row.id, to).first();
    if (!exists) return fail("not_found", `${row.name} has no version ${to}.`);
    if (to !== attachment.version) {
      await this.db.prepare("UPDATE skill_attachments SET version = ? WHERE id = ?").bind(to, attachment.id).run();
      this.audit("pin_skill", row.name, `Moved the skill ${row.name} from version ${attachment.version} to ${to} (${attachment.scope})`);
    }
    return this.detail(row.name);
  }

  async remove(name: unknown): Promise<Result<null>> {
    const found = await this.named(name);
    if (!found.ok) return found;
    const row = found.value;
    const [actor, attachments] = await Promise.all([this.actor(), attachmentsOf(this.db, [row.id])]);
    if (!mayDelete(actor, row, attachments)) {
      return fail("forbidden", row.status === "draft" ? "Only whoever saved the draft, owners and team maintainers discard it." : "Owners delete any skill; team maintainers delete the skills they wrote that only their teams use.");
    }
    const at = this.now().toISOString();
    await this.db.batch([
      this.db.prepare("UPDATE skills SET archived_at = ?, mirrored = 0 WHERE id = ? AND archived_at IS NULL").bind(at, row.id),
      this.db.prepare("DELETE FROM skill_attachments WHERE skill_id = ?").bind(row.id),
    ]);
    this.audit(row.status === "draft" ? "discard_skill" : "delete_skill", row.name, `${row.status === "draft" ? "Discarded the draft" : "Deleted the skill"} ${row.name}`);
    return ok(null);
  }

  /** An agent's skills: g1t's foundational ones and the library's that reach it, each once, on or off. */
  async agentSkills(handle: unknown): Promise<Result<AgentSkills>> {
    const key = String(handle ?? "").trim().replace(/^@/, "").toLowerCase();
    const agent = await this.db
      .prepare("SELECT id, handle, skills_off FROM agents WHERE workspace_id = ? AND handle = ? AND archived_at IS NULL")
      .bind(this.ctx.workspaceId, key)
      .first<{ id: string; handle: string; skills_off: string | null }>();
    if (!agent) return fail("not_found", `There is no agent called @${key}.`);
    const off = new Set(json<string[]>(agent.skills_off, []));
    const [teams, actor] = await Promise.all([this.ctx.ports.agentTeams(agent.id).catch(() => []), this.actor()]);
    const teamNames = new Map(teams.map((t) => [t.slug, t.name]));
    const rows = await this.db
      .prepare(
        `SELECT s.id AS skill_id, s.name, s.version AS latest, v.description, a.id AS attachment_id, a.version, v.tools, v.requires_computer, a.scope, a.target, a.attached_at
         FROM skill_attachments a
         JOIN skills s ON s.id = a.skill_id AND s.archived_at IS NULL AND s.status = 'published'
         JOIN skill_versions v ON v.skill_id = a.skill_id AND v.version = a.version
         WHERE a.workspace_id = ?1
           AND (a.scope = 'workspace' OR (a.scope = 'agent' AND a.target = ?2) OR (a.scope = 'team' AND a.target IN (SELECT value FROM json_each(?3))))
         LIMIT 500`,
      )
      .bind(this.ctx.workspaceId, agent.id, JSON.stringify(teams.map((t) => t.slug)))
      .all<{ skill_id: string; name: string; latest: number; description: string; attachment_id: string; version: number; tools: string; requires_computer: number; scope: SkillScope; target: string; attached_at: string }>();
    const order: Record<SkillScope, number> = { agent: 0, team: 1, workspace: 2 };
    const seen = new Set<string>();
    const library: AgentSkillLine[] = [];
    for (const r of [...rows.results].sort((a, b) => order[a.scope] - order[b.scope] || a.attached_at.localeCompare(b.attached_at))) {
      if (seen.has(r.skill_id)) continue;
      seen.add(r.skill_id);
      library.push({
        id: r.skill_id,
        name: r.name,
        description: r.description,
        foundational: false,
        on: !off.has(r.skill_id),
        via: r.scope,
        via_label: r.scope === "workspace" ? "Every agent" : r.scope === "agent" ? "This agent" : (teamNames.get(r.target) ?? r.target),
        attachment_id: r.attachment_id,
        version: String(r.version),
        update: r.latest > r.version ? r.latest : null,
        requires_computer: !!r.requires_computer,
        tools: json<string[]>(r.tools, []),
        can_change: mayChange(actor, r.scope, r.target),
      });
    }
    const foundational: AgentSkillLine[] = FOUNDATIONAL_SKILLS.map((s) => ({
      id: s.id,
      name: s.name,
      description: s.description,
      foundational: true,
      on: !off.has(s.id),
      via: null,
      via_label: null,
      attachment_id: null,
      version: FOUNDATIONAL_SKILLS_VERSION,
      update: null,
      requires_computer: false,
      tools: [...new Set(s.abilities.filter((a) => a.status === "ready").flatMap((a) => a.tools))],
      can_change: false,
    }));
    const onLibrary = library.filter((l) => l.on);
    return ok({
      handle: agent.handle,
      skills: [...foundational, ...library.sort((a, b) => a.name.localeCompare(b.name))],
      over_limit: Math.max(0, onLibrary.length - SKILLS_PER_AGENT_MAX),
    });
  }

  /** Links the repository the library follows, or unlinks it; then reads it. Owners only. */
  async setMirror(repo: unknown): Promise<Result<{ mirror: SkillMirror | null; changed: string[]; problems: string[] }>> {
    if (!this.ctx.owner) return fail("forbidden", "Only the workspace's owners link a repository to the library.");
    if (repo == null || repo === "") {
      await this.db.batch([
        this.db.prepare("DELETE FROM skill_mirrors WHERE workspace_id = ?").bind(this.ctx.workspaceId),
        this.db.prepare("UPDATE skills SET mirrored = 0 WHERE workspace_id = ? AND mirrored = 1").bind(this.ctx.workspaceId),
      ]);
      this.audit("unlink_skills_repository", "repository", "Stopped following a repository for skills");
      return ok({ mirror: null, changed: [], problems: [] });
    }
    const full = String(repo).trim().replace(/^\/+|\/+$/g, "").replace(/\.git$/, "");
    if (!/^[^/\s]+\/[^/\s]+$/.test(full)) return fail("invalid", "Name the repository as workspace/name.");
    const found = await this.ctx.ports.repo(full);
    if (!found) return fail("not_found", `There is no repository ${full} you can read.`);
    const at = this.now().toISOString();
    await this.db
      .prepare(
        `INSERT INTO skill_mirrors (workspace_id, repo_id, repo, branch, linked_by, linked_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (workspace_id) DO UPDATE SET repo_id = excluded.repo_id, repo = excluded.repo, branch = excluded.branch, linked_by = excluded.linked_by, linked_at = excluded.linked_at, commit_sha = NULL, synced_at = NULL, error = NULL`,
      )
      .bind(this.ctx.workspaceId, found.id, found.full, found.default_branch, this.ctx.viewer.username, at)
      .run();
    this.audit("link_skills_repository", "repository", `Follows ${found.full} for skills`);
    return this.sync();
  }

  async sync(): Promise<Result<{ mirror: SkillMirror | null; changed: string[]; problems: string[] }>> {
    const actor = await this.actor();
    if (!mayWrite(actor)) return fail("forbidden", "Only the workspace's owners and team maintainers read the repository again.");
    const mirror = await this.db.prepare("SELECT * FROM skill_mirrors WHERE workspace_id = ?").bind(this.ctx.workspaceId).first<MirrorRow>();
    if (!mirror) return fail("not_found", "The library doesn't follow a repository.");
    const result = await syncMirror(this.db, this.ctx.ports, mirror, this.now());
    const after = await this.db.prepare("SELECT * FROM skill_mirrors WHERE workspace_id = ?").bind(this.ctx.workspaceId).first<MirrorRow>();
    return ok({ mirror: mirrorOut(after), changed: result.changed, problems: result.problems });
  }
}
