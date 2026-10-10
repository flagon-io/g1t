/**
 * A workspace's skill library (docs.g1t.sh/guides/agent-skills/): the
 * skills it wrote, imported, saved from a session or follows from a
 * repository, each a SKILL.md folder (skill-format.ts), every change a new
 * version. A skill does nothing until it is attached: to one agent, to a
 * team (every agent on it), or to the whole workspace. Each attachment
 * pins the version its agents use, so an edit never reaches an agent until
 * someone moves the pin ("update available").
 *
 * Who may do what:
 *
 * - **Everyone in the workspace** sees the library, and can save a draft
 *   from a session they can see.
 * - **Team maintainers** write and import skills, edit the ones they
 *   wrote, publish drafts, and attach skills to the teams they maintain.
 * - **Owners** do all of that for any skill, attach skills to agents and
 *   to the whole workspace, delete skills, and link the repository the
 *   library follows.
 *
 * Served by the agents service (`POST /rpc/<method>`); wire shapes are
 * snake_case.
 */
import type { ServiceBinding } from "./clients";
import type { User } from "./identity";
import type { Result } from "./result";
import type { SkillFile } from "./skill-format";

/** Where a skill is attached. */
export type SkillScope = "agent" | "team" | "workspace";

export type SkillAttachment = {
  id: string;
  scope: SkillScope;
  /** The agent's handle or the team's slug; null for the whole workspace. */
  target: string | null;
  /** How it reads: "@margo", "QA", "Every agent". */
  label: string;
  /** The version the agents it reaches use. */
  version: number;
  attached_by: string;
  attached_at: string;
  /** Whether the viewer may detach it or move its version. */
  can_change: boolean;
};

/** Where a version came from. */
export type SkillOrigin =
  | { kind: "written" }
  | { kind: "upload"; filename: string }
  /** Read from a folder of a repository at one commit. */
  | { kind: "repository"; repo: string; path: string; ref: string; commit: string }
  /** Drafted by an agent from a finished session. */
  | { kind: "session"; session_id: string; agent: string; title: string }
  /** From `.g1t/skills/<name>/` in the repository the library follows. */
  | { kind: "mirror"; repo: string; path: string; commit: string };

/** A draft is waiting for a person to review it; only published skills can be attached. */
export type SkillStatus = "published" | "draft";

export type LibrarySkill = {
  id: string;
  name: string;
  /** When to use it. */
  description: string;
  status: SkillStatus;
  /** The newest version. */
  version: number;
  tools: string[];
  /** Needs the agent's own computer: marked, and its scripts aren't run, until agents have one. */
  requires_computer: boolean;
  /** Files besides SKILL.md. */
  files: number;
  bytes: number;
  /** Where the newest version came from. */
  origin: SkillOrigin;
  /** Follows the repository the library is linked to: it is changed there, not here. */
  mirrored: boolean;
  attachments: SkillAttachment[];
  created_by: string;
  created_at: string;
  updated_by: string;
  updated_at: string;
  /** Whether the viewer may edit it (or publish it, for a draft). */
  can_edit: boolean;
  /** Whether the viewer may delete it (or discard it, for a draft). */
  can_delete: boolean;
};

/** One file of a version, as the skill's page shows it. */
export type SkillFileEntry = {
  path: string;
  bytes: number;
  encoding: "utf8" | "base64";
  /** Text files' content, up to 200 KB; null for others. */
  content: string | null;
  /** Under `scripts/`: run only on an agent's computer. */
  script: boolean;
};

export type SkillVersionEntry = {
  version: number;
  description: string;
  note: string | null;
  origin: SkillOrigin;
  bytes: number;
  files: number;
  created_by: string;
  created_at: string;
};

export type SkillDetail = {
  skill: LibrarySkill;
  /** The version shown: the newest unless another was asked for. */
  shown: number;
  skill_md: string;
  /** The instructions: SKILL.md after its front-matter. */
  instructions: string;
  tools: string[];
  requires_computer: boolean;
  /** Front-matter keys g1t doesn't read, kept as written. */
  extra: Record<string, unknown>;
  files: SkillFileEntry[];
  versions: SkillVersionEntry[];
};

/** The repository the library follows: `.g1t/skills/<name>/` on its default branch. */
export type SkillMirror = {
  /** `workspace/name`. */
  repo: string;
  branch: string;
  /** The commit last read. */
  commit: string | null;
  synced_at: string | null;
  /** What went wrong the last time it was read, if it did. */
  error: string | null;
  linked_by: string;
  linked_at: string;
};

export type SkillLibrary = {
  skills: LibrarySkill[];
  mirror: SkillMirror | null;
  /** May write and import skills: owners and team maintainers. */
  can_write: boolean;
  /** Owners: attach to agents and the whole workspace, delete any skill, link a repository. */
  can_manage: boolean;
  /** The teams the viewer may attach skills to. */
  teams: { slug: string; name: string }[];
  /** The agents an owner may attach skills to. */
  agents: { handle: string; display_name: string }[];
};

/** A skill written or changed in the editor. */
export type SkillInput = {
  name: string;
  /** When to use it. */
  description: string;
  /** The instructions, in Markdown. */
  instructions: string;
  tools?: string[];
  requires_computer?: boolean;
  /** Files to add, or to replace at the same path; the current version's others are kept. */
  add_files?: SkillFile[] | null;
  /** Paths of the current version's files to leave out. */
  remove_files?: string[] | null;
  /** What changed, shown in its history. */
  note?: string | null;
  /** Move every attachment the editor may change to the new version (the default). */
  update_attachments?: boolean;
};

/** Where an imported skill comes from. */
export type SkillImport =
  /** A SKILL.md, or a zip of a skill's folder, as standard base64. */
  | { kind: "upload"; filename: string; data_base64: string }
  /** A folder in a repository the viewer can read, at a branch, tag or commit (the default branch when absent). */
  | { kind: "repository"; repo: string; path: string; ref?: string | null };

/** One skill an agent has, as its Skills tab lists it. */
export type AgentSkillLine = {
  /** A foundational skill's id, or a library skill's. */
  id: string;
  name: string;
  description: string;
  foundational: boolean;
  /** Whether it is on for this agent (owners turn skills off per agent). */
  on: boolean;
  /** How the agent has it; null for a foundational skill. */
  via: SkillScope | null;
  via_label: string | null;
  attachment_id: string | null;
  /** The version it uses: a release like "2026.10" for foundational skills. */
  version: string;
  /** A newer published version, if there is one. */
  update: number | null;
  requires_computer: boolean;
  tools: string[];
  /** Whether the viewer may move this attachment's version or detach it. */
  can_change: boolean;
};

export type AgentSkills = {
  handle: string;
  skills: AgentSkillLine[];
  /** Library skills past the limit of 100, which the agent doesn't get. */
  over_limit: number;
};

export interface SkillLibraryApi {
  library(workspace: string, viewer: User): Promise<Result<SkillLibrary>>;
  skill(workspace: string, viewer: User, name: string, version?: number | null): Promise<Result<SkillDetail>>;
  /** A new skill (`name` null) or a new version of one; a draft is published by saving it. */
  saveSkill(workspace: string, viewer: User, name: string | null, input: SkillInput): Promise<Result<SkillDetail>>;
  /** A new skill, or with `replace` a new version of the one with its name. */
  importSkill(workspace: string, viewer: User, source: SkillImport, replace?: boolean): Promise<Result<SkillDetail>>;
  /** `target` is an agent's handle or a team's slug; null for the whole workspace. Pins the newest version. */
  attachSkill(workspace: string, viewer: User, name: string, scope: SkillScope, target: string | null): Promise<Result<SkillDetail>>;
  detachSkill(workspace: string, viewer: User, name: string, attachment: string): Promise<Result<SkillDetail>>;
  /** Moves an attachment to another version: the newest when `version` is null. */
  pinSkill(workspace: string, viewer: User, name: string, attachment: string, version: number | null): Promise<Result<SkillDetail>>;
  /** Removes a skill and its attachments; for a draft, discards it. */
  deleteSkill(workspace: string, viewer: User, name: string): Promise<Result<null>>;
  /** An agent's skills: g1t's foundational ones and the library's that reach it. */
  agentSkills(workspace: string, viewer: User, handle: string): Promise<Result<AgentSkills>>;
  /** The session's agent drafts a skill from its transcript, billed as its work; a person reviews it before it is published. */
  draftFromSession(workspace: string, viewer: User, session: string): Promise<Result<SkillDetail>>;
  /** Links the repository the library follows (`workspace/name`), or unlinks it (null), and reads it. Owners. */
  setMirror(workspace: string, viewer: User, repo: string | null): Promise<Result<{ mirror: SkillMirror | null; changed: string[]; problems: string[] }>>;
  /** Reads the linked repository again. */
  syncMirror(workspace: string, viewer: User): Promise<Result<{ mirror: SkillMirror | null; changed: string[]; problems: string[] }>>;
}

async function rpc<T>(service: ServiceBinding, method: string, args: object): Promise<T> {
  const response = await service.fetch(`https://service/rpc/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(args),
  });
  if (!response.ok) throw new Error(`${method} failed with status ${response.status}`);
  return (await response.json()) as T;
}

export function skillLibraryClient(service: ServiceBinding): SkillLibraryApi {
  const call = <T>(method: string, args: object) => rpc<T>(service, method, args);
  return {
    library: (workspace, viewer) => call("skill_library", { workspace, viewer }),
    skill: (workspace, viewer, name, version) => call("skill", { workspace, viewer, name, version: version ?? null }),
    saveSkill: (workspace, viewer, name, input) => call("save_skill", { workspace, viewer, name, input }),
    importSkill: (workspace, viewer, source, replace) => call("import_skill", { workspace, viewer, source, replace: replace === true }),
    attachSkill: (workspace, viewer, name, scope, target) => call("attach_skill", { workspace, viewer, name, scope, target }),
    detachSkill: (workspace, viewer, name, attachment) => call("detach_skill", { workspace, viewer, name, attachment }),
    pinSkill: (workspace, viewer, name, attachment, version) => call("pin_skill", { workspace, viewer, name, attachment, version }),
    deleteSkill: (workspace, viewer, name) => call("delete_skill", { workspace, viewer, name }),
    agentSkills: (workspace, viewer, handle) => call("agent_skills", { workspace, viewer, handle }),
    draftFromSession: (workspace, viewer, session) => call("draft_skill", { workspace, viewer, session }),
    setMirror: (workspace, viewer, repo) => call("set_skill_mirror", { workspace, viewer, repo }),
    syncMirror: (workspace, viewer) => call("sync_skill_mirror", { workspace, viewer }),
  };
}
