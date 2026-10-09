# Artifacts mode: plan

Status: plan, 2026-10-09. This replaces Docs mode (docs/WORKSPACE.md, "Docs") with **Artifacts**: one mode for four kinds of collaborative work: **Docs, Slides, Design and Dashboards**. Each has private, shared, space and workspace access, and each is edited live by people and agents together.

This document is about the product mode. `docs/ARTIFACTS.md` is something else: the research on the Cloudflare Artifacts git store. The two must not share code names (see section 0).

---

## 0. Naming: keep "Artifacts" the mode apart from Artifacts the git store

The word "artifact" already has three meanings in this repository:

| Meaning | Where |
|---|---|
| The Cloudflare Artifacts git store | `services/repos` binding `ARTIFACTS`, `ArtifactsStore`, `ARTIFACTS_NAMESPACES`, docs/ARTIFACTS.md |
| Workflow run artifacts | `apps/api/src/artifacts.rs` (`ArtifactsOp`), `crates/contracts` `actions::Artifact`, `apps/web/app/lib/artifacts.ts` (`formatBytes`, `expiresIn`), the `workflow` MCP tool's `*_artifact` actions, REST `/repos/:o/:n/actions/artifacts` |
| **The new mode** | this plan |

**Decision: user-facing words say "artifact", and code says "folio".**

- **Users see "artifact".** That covers UI text, `apps/docs`, URLs (`/<ws>/-/artifacts/...`), the MCP tool name (`artifact`), REST paths (`/workspaces/{ws}/artifacts`), scope names (`artifacts:read`, `artifacts:write`, `artifacts:admin`) and the agents' tool names (`search_artifacts`, ...).
- **Code identifiers say "folio".** A folio is one artifact of any kind:
- tables `folios`, `folio_grants`, ...
- types `Folio`, `FolioKind`, `FolioRole`
- the Durable Object `FolioRoom`
- events `folio.created`, ...
- files `packages/contracts/src/folios.ts`, `crates/contracts/src/folios.rs`, `apps/api/src/folios.rs` (`FoliosOp`, next to the untouched `artifacts.rs`), `apps/web/app/components/folios/*`, `apps/web/app/routes/workspace/folios/*`, `apps/web/app/lib/folios.ts`
- "folio" is not used anywhere in the repository today, so grep stays clean.
- **The service and its infrastructure keep their names:** `services/docs`, Worker `g1t-docs-service`, D1 `g1t-docs`, R2 `g1t-docs-files`, binding `DOCS`. Renaming them would force new resources for every installation, including self-hosters, and buys nothing. The service header comment and docs/SELF_HOSTING.md say "the docs service hosts folios (Artifacts mode)". The semantic index is new (`g1t-folios`, section 5) because its metadata changes.
- The kind of the old Docs pages is `doc` (`FolioKind = "doc" | "slides" | "design" | "dashboard"`). In UI text the tile is "Docs" and a single item is "a doc".
- **Rule for reviewers:** a new identifier containing `artifact` outside the git-store and workflow code is a bug.

---

## 1. What exists today (the base we build on)

- **`services/docs`** (TypeScript Worker):
- D1 tables: `spaces` (kind workspace/team/private, default_role, agent_mode), `space_members`, `pages` (tree in `parent_id` + `position`, `markdown` rendition), `page_versions` (Yjs state + Markdown), `suggestions`, `templates`, `files`, `pages_fts`, `citations`, `page_changes`, `repo_spaces`, `repo_files`, `doc_chunks(+_fts)`, `doc_embed_usage`, `doc_index_runs`. Migrations are 0001 to 0003.
- `src/room.ts`: `PageRoom` is a Durable Object that owns one Yjs document. It speaks y-protocols sync and awareness over hibernating WebSockets, enforces the socket's role, saves through `persist.ts` four seconds after edits and indexes through `indexer.ts` thirty seconds after.
- `src/access.ts`: pure role rules (`RANK`, `roleOf`, `readableByAll`, `readableByWorkspace`, `agentAbilities`).
- Recall: `recallForAgent` uses Vectorize `g1t-docs` with a `space_id` `$in` filter, then re-checks against D1. Hybrid search uses RRF.
- `src/index.ts`: about 2,750 lines with a `/rpc/<method>` switch.
- **Web:**
- Routes: `apps/web/app/routes/workspace/docs/*`, registered in `apps/web/app/routes.ts` under `-/docs`.
- Components: `apps/web/app/components/docs/*` (BlockNote `editor.tsx`, custom `blocks.tsx`, the generic Yjs socket client `provider.ts`, `sidebar.tsx` with a drag tree, `page-parts.tsx` with history and suggestions).
- The mode is wired through `ModeKey "docs"` in `apps/web/app/lib/workspace-nav.ts`, the rail in `components/rail.tsx`, `sidebarFor` and `MODE_MENU` in `components/shell.tsx`, and the phone tab bar in `components/mobile.tsx`.
- **Agents:**
- `services/agents/src/tools.ts` has `DOCS_TOOLS` and `DOCS_WRITE_TOOLS` (`search_docs`, `read_page`, `edit_page`, `create_page`, `stale_pages`, `list_doc_spaces`).
- `services/agents/src/ports.ts` holds `docsPorts`.
- "Write this up" is in `components/chat/write-up.tsx` and `lib/write-up.ts`.
- **External MCP:** `apps/api/src/tools.rs` defines a few resource tools with an `action` field, and the scopes are in `crates/contracts/src/scopes.rs`. There is **no docs tool and no docs scope today**, and apps/api has no `DOCS` binding.
- **Events:** `doc.page.*` (`packages/contracts/src/events.ts`, `crates/contracts/src/events.rs` `DOC_PAGE_EVENTS`, `subscribers.rs`).
- **Libraries already present:** BlockNote 0.55, yjs, y-protocols, y-prosemirror, lib0, mermaid, katex, shiki, radix-ui, cmdk, lucide.
- There is **no chart library**. Charts are hand-rolled SVG (`components/usage.tsx` `UsageChart`, `Sparkline`, `AllowanceRing`; `routes/repo/contributors.tsx`).
- Hover hints are `components/ui/hint.tsx`, on the shadcn Tooltip.
- Relative time is `TimeAgo` in `components/ui/index.tsx`, and the viewer's zone is `lib/time-zone.ts`.
- The people picker is `components/people-picker.tsx`. Tabs are `ui/tab-strip.tsx` and `ui/tabs.tsx`.

---

## 2. Data model

### 2.1 Concepts

- **Folio** (shown as an artifact): one item with a `kind`. Every folio has:
- one **owner**, always a person. When an agent makes one, the owner is the person it acts for.
- a **location**: a **space**, or none, which means it is in the owner's **Private** section.
- an optional **parent**. Only a `doc` can have children, so a doc is the page that holds sub-pages. Slides, Design and Dashboards are leaves. There is **no folder kind in v1**, because a doc with children is the folder.
- **Space** (a teamspace) keeps the existing `spaces` table and roles:
- `workspace`: shown as "Open". Every member gets `default_role`. Members **join** it to see it in their sidebar.
- `team`: the team's members get `default_role`.
- `private`: shown as "**Members only**", so it can't be confused with the Private section. Only listed members.
- **Roles** stay as they are: `view < comment < edit < manage` (`RANK` in access.ts). A folio's owner always has `manage`.
- **A person's effective role on a folio** is the highest of:
1. owner → `manage`;
2. explicit **grants** on the folio or on an ancestor it inherits from, given to a `user:`, `agent:` or `team:` key;
3. **space access**, when the folio inherits (`inherit = 1`) up to a folio in a space: the person's space role (`roleOf`);
4. **general access** of the folio's access root:
   - `workspace`: every member gets `general_role`;
   - `link`: a member who has opened the link gets `general_role`.

Workspace owners get `manage` on folios in open and team spaces, as today. They get nothing on someone's Private folio or on a Members-only space.
- **Restricting.** A doc's child, or a folio in a space, can set `inherit = 0` ("Only people invited"). It then becomes its own **access root**: space access and the parent's grants stop at it.
- **"Private" (the lock icon)** is computed, not stored. It means the effective readers are only the owner: no grants, `general_access = 'none'`, and either no space or `inherit = 0`.
- **Agents.** An agent's role on a folio is never higher than its asker's. Its grants (`agent:<id>`) make it a participant for notifications and @-mentions. They never widen what it can read for someone who can't read the folio (section 4.3).
- **Link access.** "Anyone in the workspace with the link" is not discoverable: it is not in lists or search, and not in recall for a workspace audience. It becomes readable for a person once they open the link, which records a row in `folio_visits`. A **public link** (people outside the workspace) is deferred to Phase 8 and off by default per workspace.
- **Favorites, recent, trash, versions and templates** are per folio and work for every kind.

### 2.2 D1 schema: `services/docs/migrations/0004_folios.sql`

This migration only adds tables. Old tables stay until Phase 7.

```sql
CREATE TABLE folios (
id TEXT PRIMARY KEY,                -- fol_…
workspace_id TEXT NOT NULL,
kind TEXT NOT NULL CHECK (kind IN ('doc','slides','design','dashboard')),
title TEXT NOT NULL DEFAULT '',
icon TEXT, cover TEXT,
owner TEXT NOT NULL,                -- user:<id>
space_id TEXT REFERENCES spaces (id),          -- NULL: owner's Private
parent_id TEXT REFERENCES folios (id),         -- only a doc may be a parent
position REAL NOT NULL,
inherit INTEGER NOT NULL DEFAULT 1, -- from parent, or from the space at the top
acl_root TEXT NOT NULL,             -- nearest self-or-ancestor with inherit=0 or no parent (denormalized)
path TEXT NOT NULL,                 -- '/<root id>/…/<id>/' for subtree updates
general_access TEXT NOT NULL DEFAULT 'none' CHECK (general_access IN ('none','workspace','link')),
general_role TEXT CHECK (general_role IN ('view','comment','edit')),
agent_mode TEXT CHECK (agent_mode IN ('suggest','edit')), -- NULL: the space's, or 'suggest' in Private
text TEXT NOT NULL DEFAULT '',      -- derived rendition (§3): search, recall, read view, export
excerpt TEXT NOT NULL DEFAULT '',
preview TEXT,                       -- small JSON for cards (§6.2), never data values
source TEXT,                        -- e.g. the chat thread link it was written up from
mentioned TEXT NOT NULL DEFAULT '[]',
created_by TEXT NOT NULL,           -- user:/agent:
created_at TEXT NOT NULL,
updated_by TEXT, updated_at TEXT NOT NULL,   -- any change (rename, move, share)
edited_by TEXT, edited_at TEXT NOT NULL,     -- content changes: "Edited 45m ago"
trashed_at TEXT, trashed_by TEXT
);
CREATE INDEX folios_tree   ON folios (workspace_id, space_id, parent_id, position);
CREATE INDEX folios_owner  ON folios (owner, edited_at) WHERE trashed_at IS NULL;
CREATE INDEX folios_recent ON folios (workspace_id, edited_at) WHERE trashed_at IS NULL;
CREATE INDEX folios_root   ON folios (acl_root);
CREATE INDEX folios_path   ON folios (path);

CREATE TABLE folio_grants (           -- explicit shares, as set
folio_id TEXT NOT NULL REFERENCES folios (id) ON DELETE CASCADE,
principal TEXT NOT NULL,            -- user:/agent:/team:
role TEXT NOT NULL CHECK (role IN ('view','comment','edit','manage')),
granted_by TEXT NOT NULL, granted_at TEXT NOT NULL,
PRIMARY KEY (folio_id, principal)
);
-- Effective explicit access, materialized per folio for list/search SQL:
-- the owner and every grant from the folio up to its acl_root, highest role.
-- Rebuilt for a subtree (by `path`) on grant, move, restrict, ownership change.
CREATE TABLE folio_access (
folio_id TEXT NOT NULL REFERENCES folios (id) ON DELETE CASCADE,
principal TEXT NOT NULL,
role TEXT NOT NULL,
via TEXT NOT NULL,                  -- the folio whose grant this is (self or ancestor), or 'owner'
since TEXT NOT NULL,                -- for "Shared with you" ordering
PRIMARY KEY (folio_id, principal)
);
CREATE INDEX folio_access_principal ON folio_access (principal, since);

CREATE TABLE folio_visits (           -- recent, and link access once opened
folio_id TEXT NOT NULL REFERENCES folios (id) ON DELETE CASCADE,
user_id TEXT NOT NULL,
first_at TEXT NOT NULL, last_at TEXT NOT NULL,
PRIMARY KEY (folio_id, user_id)
);
CREATE INDEX folio_visits_user ON folio_visits (user_id, last_at);

CREATE TABLE folio_favorites (user_id TEXT NOT NULL, folio_id TEXT NOT NULL REFERENCES folios (id) ON DELETE CASCADE,
position REAL NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (user_id, folio_id));

CREATE TABLE space_joins (            -- open spaces a member shows in their sidebar
space_id TEXT NOT NULL REFERENCES spaces (id) ON DELETE CASCADE, user_id TEXT NOT NULL,
position REAL NOT NULL, joined_at TEXT NOT NULL, PRIMARY KEY (space_id, user_id));

CREATE TABLE folio_versions (
id TEXT PRIMARY KEY, folio_id TEXT NOT NULL REFERENCES folios (id) ON DELETE CASCADE,
created_at TEXT NOT NULL,
kind TEXT NOT NULL CHECK (kind IN ('created','edit','agent','suggestion','proposal','restore')),
authors TEXT NOT NULL DEFAULT '[]', note TEXT,
text TEXT NOT NULL,
state BLOB,                         -- Yjs state when ≤ 1.5 MB
state_key TEXT                      -- else in the file store (design decks with many nodes)
);
CREATE INDEX folio_versions_folio ON folio_versions (folio_id, created_at);

-- Doc kind: inline tracked changes, as `suggestions` today.
CREATE TABLE folio_suggestions ( …same columns as suggestions, page_id → folio_id, marks_current… );
-- Other kinds: an agent's whole change as a Yjs update a person previews and applies.
CREATE TABLE folio_proposals (
id TEXT PRIMARY KEY, folio_id TEXT NOT NULL REFERENCES folios (id) ON DELETE CASCADE,
author TEXT NOT NULL, asked_by TEXT, note TEXT,
base_vector BLOB NOT NULL, update_blob BLOB, update_key TEXT,
summary TEXT NOT NULL,              -- "Adds slides 4–6; rewrites the title slide"
status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','accepted','rejected','stale')),
created_at TEXT NOT NULL, decided_by TEXT, decided_at TEXT);

CREATE TABLE folio_templates (
id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL,
kind TEXT NOT NULL CHECK (kind IN ('doc','slides','design','dashboard')),
name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', icon TEXT,
body TEXT NOT NULL,                 -- Markdown (doc, slides) or JSON spec (design, dashboard)
created_by TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE INDEX folio_templates_ws ON folio_templates (workspace_id, kind);

CREATE TABLE folio_files ( …as files, page_id → folio_id… );
CREATE TABLE folio_links (from_folio TEXT NOT NULL REFERENCES folios (id) ON DELETE CASCADE, to_folio TEXT NOT NULL, PRIMARY KEY (from_folio, to_folio));
CREATE INDEX folio_links_to ON folio_links (to_folio);
CREATE TABLE folio_projects (folio_id …, repo TEXT, PRIMARY KEY (folio_id, repo));
CREATE TABLE folio_citations ( …as citations, page_id → folio_id… );
CREATE TABLE folio_changes   ( …as page_changes, page_id → folio_id… );

CREATE VIRTUAL TABLE folios_fts USING fts5 (folio_id UNINDEXED, kind UNINDEXED, title, body, tokenize = 'unicode61 remove_diacritics 2');

-- The index generalizes: doc_chunks keeps its shape for repo files; folio passages get their own table.
CREATE TABLE folio_chunks (
id TEXT PRIMARY KEY,                -- <folio id>:<seq>
workspace_id TEXT NOT NULL, folio_id TEXT NOT NULL, kind TEXT NOT NULL,
scope TEXT NOT NULL,                -- 'space:<id>' when the folio's access is its space's; else 'folio:<acl_root>'
seq INTEGER NOT NULL, heading TEXT, text TEXT NOT NULL, hash TEXT NOT NULL, vector_hash TEXT, updated_at TEXT NOT NULL);
CREATE VIRTUAL TABLE folio_chunks_fts USING fts5 (chunk_id UNINDEXED, scope UNINDEXED, folio_id UNINDEXED, heading, text, tokenize = 'unicode61 remove_diacritics 2');
```

`repo_spaces`, `repo_files`, `repo_files_fts`, the `doc_chunks` rows for repository files, `doc_embed_usage` and `doc_index_runs` are kept: projects' docs stay a read-only source in Artifacts. In Phase 7, migration `0006_drop_pages.sql` drops `pages`, `page_*`, `favorites`, `suggestions`, `templates`, `files`, `pages_fts`, `citations`, `page_changes` and the page rows of `doc_chunks`. It runs only after no deployed code reads them.

### 2.3 Access code

- **`services/docs/src/access.ts` (pure, tested)** gains:
- `effectiveRole(folio, chain, grantsByFolio, spaceRole, person)`
- `isPrivate(...)`
- `aclRootOf(...)`
- `materialize(subtree) → folio_access rows`
- `readableByAllFolio(...)` for agent audiences
- `generalRoleCap` (general access never gives `manage`)
- `canShare(role)`: `manage`, or `edit` when the space allows editors to share. The default is `manage` only.
- **Listing SQL ("All").** A folio is listed when any of these holds:
1. a `folio_access` row matches one of the viewer's keys (`user:<id>` and `team:<slug>…`);
2. its `space_id` is one of the viewer's readable spaces, `inherit = 1` and `acl_root` is the top of the space;
3. its access root has `general_access = 'workspace'`;
4. its root has `general_access = 'link'` and the viewer has a visit row.

Results are paged by `(edited_at, id)`. Each page of rows is re-checked with `effectiveRole` before it is returned (defence in depth).
- **Re-materializing.** Subtree changes are bounded at 2,000 folios inline; bigger ones go to a `folios.reacl` queue job on `JOBS`. Open rooms in the subtree get `setRole` so their sockets follow the change (as today).

### 2.4 Contracts

**`packages/contracts/src/folios.ts`** (new). Wire shapes are snake_case:

- `FolioKind`, `FOLIO_KINDS`, `FOLIO_KIND_LABELS` (`Docs`, `Slides`, `Design`, `Dashboard`), `FolioRole` (an alias of `DocRole`, kept so access code is shared), `FolioGeneralAccess`.
- `FolioRef { id, kind, title, icon, slug, path }`, where `path` is `/<ws>/-/artifacts/<title-slug>-<id>`.
- `Folio`: `FolioRef` plus `space`, `parent_id`, `owner: MemberProfile`, `created_by`, `edited_by`, `edited_at`, `trashed_at`, `viewer_role`, `favorite`, `private`, `shared_count`, `general_access`, `general_role`, `inherited_from: { kind: "space" | "folio"; id; name } | null`, `excerpt`, `preview`, `stale`, `has_children`.
- `FolioListQuery { tab: "all" | "yours" | "shared"; kinds?; space_id?; owner?; project?; q?; cursor?; limit? }` and `FolioList { items; next_cursor }`.
- `FoliosSidebar { favorites; spaces: (DocSpace & { tree })[]; private_tree; shared; repos }`.
- `NewFolio { kind; title?; space_id?; parent_id?; template_id?; content?: FolioContentInput; share_with?: { principal; role }[] }`.
- `FolioAccessList` (for the share dialog: rows with their source), `FolioAccessChange`.
- `FolioVersion`, `FolioProposal`, `FolioTemplate`.
- `FoliosLiveEvent`, generalizing `DocsLiveEvent`.
- `FolioPassage { folio: FolioRef | null; repo_file; space_name; heading; text; score; updated_at; stale }`.
- `FolioAgentEdit`, discriminated by kind:
- `doc`: `{ target: DocEditTarget; markdown }`
- `slides`: `{ ops: SlidesOp[] }`
- `design`: `{ ops: DesignOp[] }`
- `dashboard`: `{ ops: DashboardOp[] }`
- `foliosClient(binding)` with the RPC names in section 7.

Each kind's own types live in its own file so parallel work doesn't collide: `folios-slides.ts`, `folios-design.ts`, `folios-dashboard.ts`.

**`packages/contracts/src/datasets.ts`** (new, mirrored in **`crates/contracts/src/datasets.rs`**) holds the dashboard query layer (section 3.4).

**`crates/contracts/src/folios.rs`** holds the subset the Rust API needs (`Folio`, `NewFolio`, `FolioAgentEdit` as `serde_json::Value`, the args structs) and `FOLIO_EVENTS`.

**Events** (`events.ts`, `events.rs`, `subscribers.rs`): `folio.created`, `folio.updated` (a version: kind and authors), `folio.trashed`, `folio.restored`, `folio.shared` (who was granted, never content), `folio.stale`. They carry `{ workspaceId, folioId, kind, spaceId | null }` and no title for private folios. They never carry a `repoId`. `doc.page.*` keeps being published by the old code paths until Phase 7.

---

## 3. Each kind: content model and editor

**One room for every kind.** `src/room.ts` becomes `FolioRoom`, which keeps the same socket protocol, hibernation, roles, save alarm and index alarm, with a **kind adapter**:

```ts
// services/docs/src/kinds/types.ts
export interface KindModel {
kind: FolioKind;
seed(doc: Y.Doc, init: { text?: string; spec?: unknown }): void;     // template / agent / blank
render(doc: Y.Doc): { text: string; outline: unknown; mentions: string[]; links: string[]; citations: DocCitation[]; preview: unknown };
chunks(text: string, title: string): Passage[];                      // §5
applyAgentEdit(doc: Y.Doc, edit: unknown, origin: Origin): { applied: boolean; summary: string };
restore(doc: Y.Doc, old: Y.Doc, origin: Origin): void;
validate(update: Y.Doc): string | null;                              // caps: node counts, sizes
}
// services/docs/src/kinds/index.ts: { doc, slides, design, dashboard } registry (one line per kind)
```

`FolioRoom` stores `kind` in `meta` and dispatches to the adapter. `persist.ts` becomes `saveFolio(env, { folio_id, text, preview, ... })`. Wrangler gets a DO migration `{ "tag": "v2", "new_sqlite_classes": ["FolioRoom"] }`. `PageRoom` stays exported until Phase 7 (`deleted_classes`).

The web uses one socket client, `components/docs/provider.ts` moved to `components/folios/provider.ts` (`FolioProvider`), at `/<ws>/-/artifacts/live?folio=<id>`. Each kind's editor is registered in `components/folios/kinds.tsx` with `{ icon, label, Editor, Viewer, Thumbnail, mobileEditable }`.

### 3.1 Docs (`kind: "doc"`)

- **Content:** unchanged. BlockNote on `XmlFragment("document-store")`, comments in the `threads` map. `blocks.ts`, `markdown.ts`, `edits.ts`, `threads.ts` and `citations.ts` move under `src/kinds/doc/` without behaviour changes.
- **Editor:** `components/docs/editor.tsx`, `blocks.tsx` and `page-parts.tsx` move to `components/folios/doc/`. Children, backlinks, citations, staleness, suggestions and history all stay.
- **New:** sub-page blocks can be any kind (an embedded card linking to a child slides deck or dashboard). This adds a `folio` embed block, generalizing the page card.

### 3.2 Slides (`kind: "slides"`)

**Yjs model.**
- `Y.Map("deck")`: `{ theme, aspect: "16:9" | "4:3", accent }`.
- `Y.Array("slides")` of `Y.Map`: `{ id, layout, background, hidden, transition: "none" }`.
- Layouts: `title`, `title-body`, `two-column`, `section`, `image`, `quote`, `big-number`, `blank`.
- Each slide's regions are root `XmlFragment`s named `slide:<id>:<region>` (`title`, `body`, `left`, `right`, `notes`).
- So every region is a **BlockNote editor bound to its own fragment**: BlockNote's collaboration option takes a `fragment`. Mentions, code, math and mermaid come for free.
- Each region gets a narrower schema. For example, a title region allows a single heading and inline content only.

**Markdown form,** used by agents, templates, export and the rendition:

```markdown
<!-- slide: title -->
# Q4 roadmap
Subtitle

---
<!-- slide: two-column -->
## Pricing
::: left
- …
::: right
- …
Note: speaker notes here
```

**`src/kinds/slides.ts`** parses and serializes this form, reusing `blocks.ts` `seed` per region. The text rendition is the deck in this form.

**Editor:** `components/folios/slides/`.
- A filmstrip of thumbnails on the left, drag to reorder. Thumbnails are a read-only render of each slide's regions. Only the current slide mounts live editors, which keeps BlockNote instances to 1–5.
- A stage at 16:9 that scales to fit, a layout picker, a notes pane and a theme menu.

**Present mode.**
- Fullscreen API on the stage, inside the same route (`?present=1`). Arrow keys, space, Esc, `B` for black.
- A presenter window (`?present=presenter`) shows notes, the next slide and a timer, kept in sync over `BroadcastChannel`.
- "Follow the presenter": the presenter's current slide goes out in **awareness**, and viewers who opt in follow it. No new infrastructure.

**Export.** Markdown now. "Print / Save as PDF" through a print stylesheet (`@page` landscape, one slide per page), which works self-hosted with no service. A server-rendered PDF through the og service's `Screenshots` entrypoint (Browser Rendering), behind a `Renderer` adapter, comes in Phase 8.

**Agent ops (`SlidesOp`):**
- `replace_deck { markdown }`
- `insert_slides { after_slide_id | null, markdown }`
- `replace_slide { slide_id, markdown }`
- `delete_slides { slide_ids }`
- `move_slide { slide_id, after_slide_id }`
- `set_notes { slide_id, markdown }`
- `set_theme { theme, accent }`

### 3.3 Design (`kind: "design"`): what is realistic

**Scope.** A frame-based layout canvas for mockups, screens, diagrams and one-pagers, which agents can produce structurally. It is not a full vector tool.

**Yjs model.**
- `Y.Map("canvas")`: `{ background, grid }`.
- `Y.Map("nodes")`: `id → Y.Map`.
- Node types: `frame`, `rect`, `ellipse`, `line`, `arrow` (with node-bound endpoints), `text` (with `Y.Text` content), `image` (a file key, never inline bytes), `html`, `component` (a definition frame) and `instance` (a `component_id` plus `overrides`).
- Common fields: `parent`, `index` (a fractional-index string), `x`, `y`, `w`, `h`, `rotation`, `fill`, `stroke`, `stroke_width`, `radius`, `opacity`, `name`, `locked`, `hidden`.
- Frames have `layout: "free" | "row" | "column"` with `gap`, `padding`, `align`. This is simple stack layout computed at render, so **agents don't compute coordinates**.
- `html` nodes hold `Y.Text` with agent- or person-authored HTML and CSS. They render in a sandboxed iframe (`sandbox=""`, no scripts) served from the **usercontent origin**, sanitized server-side on save. This is the most agent-friendly way to get rich, realistic designs.
- Comments pin to `{ node_id, x, y }` in the `threads` map.

**Renderer and editor:** `components/folios/design/`.
- React with SVG for shapes and positioned HTML for text.
- Pointer tools: select, frame, rect, ellipse, line, arrow, text, image (upload through `folio_files`) and hand.
- Pan and zoom, marquee and multi-select, snapping to frame edges and centres, keyboard nudge, and a layers panel with a properties panel.
- Make component, and instances with overrides.
- Other people's cursors and selections through awareness.
- **Export:** a frame as SVG by serializing the DOM, and as PNG through a client canvas.

**Library decision: build it on SVG; add no canvas dependency.**
- Mature whiteboard libraries either carry licence terms unsuitable for a self-hostable MIT product (a production key or a watermark), or impose a hand-drawn whiteboard look and their own scene model that fights Yjs.
- Canvas-2D libraries make text editing and accessibility harder.
- An SVG scene graph on Yjs maps fits the stack: `yjs` is already in, and a small `fractional-indexing` helper is about 40 lines.
- An MIT whiteboard library could later back a separate "Whiteboard" kind if one is wanted.

**Caps** (enforced in `validate`): 5,000 nodes, 200 KB per `html` node, 25 MB total files per folio.

**Agent ops (`DesignOp`):**
- `upsert_nodes { nodes: NodeSpec[] }`: a nested spec, where children imply `parent` and `index`
- `delete_nodes { ids }`
- `replace_frame { frame_id, spec }`
- `set_html { node_id, html }`
- `move { ids, dx, dy }`

**Text rendition:** frame names, then text layers in reading order, then the text content of `html` nodes, as headings per frame.

### 3.4 Dashboards (`kind: "dashboard"`, beta)

**Yjs model.**
- `Y.Map("dashboard")`: `{ filters: { range: "7d" | "30d" | "90d" | { from, to }, project?, repos?, team? }, refresh: "manual" | "5m" | "1h" }`.
- `Y.Array("tiles")` of `Y.Map`: `{ id, type, title, description, query: DatasetQuery | null, viz: {...}, grid: { x, y, w, h } }`.
- Tile types: `stat`, `line`, `area`, `bar`, `stacked_bar`, `table`, `list`, `markdown`.
- The grid is 12 columns.
- **Only the definition is in Yjs. Data values never are**, nor in versions, `text`, `preview`, the index or templates.

**The safe query layer** (`packages/contracts/src/datasets.ts`):

```ts
export type DatasetId = "issues" | "pull_requests" | "workflow_runs" | "deployments" | "spend" | "agent_sessions";
export type DatasetQuery = {
dataset: DatasetId;
measure: { op: "count" | "sum" | "avg" | "p50" | "p95" | "rate"; field?: string };
group_by?: string;                       // a declared dimension only
interval?: "day" | "week" | "month";     // time series
filters?: { field: string; op: "eq" | "neq" | "in" | "gte" | "lte"; value: string | number | string[] }[];
range?: "7d" | "30d" | "90d" | { from: string; to: string };   // tile's, else the dashboard's
limit?: number;                           // ≤ 100 rows
};
export type DatasetResult = { columns: { name: string; type: "string" | "number" | "time" | "money" }[]; rows: (string | number | null)[][]; truncated: boolean; as_of: string };
export const DATASETS: Record<DatasetId, { service: "work" | "actions" | "deployments" | "billing" | "agents"; dimensions: string[]; measures: string[]; needs: "member" | "billing" }>;
```

- **Not SQL.** It is a declared catalog of fields, ops and dimensions per dataset. Each **owning service** implements one RPC, `query_dataset(viewer, workspace, query, audience?)`:
- `services/work` (Rust): issues and pull requests (opened, closed, merged, cycle time, review time, by repo, label, author kind person or agent).
- `services/actions` (Rust): runs (pass rate, duration, by workflow and repo).
- `services/deployments` (TS): deployments (frequency, failure rate, time to restore).
- `services/billing` (Rust): spend by product, project or person. Needs the billing role.
- `services/agents` (TS): sessions, tasks and spend per agent.
- Each service **applies its own read rules for the viewer**, using only repositories they can read. It aggregates in its own D1 with a fixed query per measure and dimension, and caps the rows. Validation of `DatasetQuery` against the catalog is shared code in contracts, run in both TS and Rust.
- **Execution path:** browser → `/-/artifacts/query?folio=&tile=` → docs service `query_tile`. That checks the viewer can read the folio, reads the tile's query from the room, validates it, fans out to the owning service as the viewer, and caches per `(viewer, query hash)` for the refresh interval behind a `QueryCache` adapter (Cache API on Cloudflare, in-memory or Redis self-hosted).
- **Two viewers of the same dashboard can see different numbers.** The tile footer says "Based on what you can see" when the viewer's access is partial: the service returns `partial: true` when the viewer cannot read some repositories.

**Charts:** an own SVG chart kit, `components/charts/`, with `LineChart`, `AreaChart`, `BarChart` (stacked and grouped), `StatTile` (with `Sparkline`), `DataTable` and `Legend`.
- Extract and generalize `UsageChart`, `Sparkline` and `AllowanceRing` from `components/usage.tsx` so usage pages and dashboards share it.
- No new dependency. It is themed with `@g1t/theme` tokens, follows light and dark, and has accessible tables behind every chart ("View as table").
- Lazy-loaded with the dashboard editor.

**Editor:** `components/folios/dashboard/`.
- A grid with pointer drag and resize (no grid library) and a tile inspector.
- Query builder: dataset, then measure, group, interval and filters, with live preview.
- A dashboard filter bar, a refresh button showing as-of time, and an auto-refresh interval.

**Phone:** a single column ordered by `(y, x)`, read-only; editing a tile opens a sheet.

**Agent ops (`DashboardOp`):**
- `upsert_tile { tile }`
- `delete_tiles { ids }`
- `set_filters { filters }`
- `set_layout { tiles: { id, grid }[] }`

Agents read results through the agent tool `query_data` (section 4), never from the folio.

**Text rendition:** the title, then each tile's title, description and query described in words ("Pull requests merged per week, by repository, last 90 days"). It never contains values.

**Templates:**
- "Engineering health": PR cycle time, merged per week, run pass rate, deploy frequency, open issues by label.
- "Agent spend and output"
- "Workspace spend" (billing role)
- "Delivery" (DORA-style)

`-/insights`, which is "soon" today, can later open the workspace's pinned dashboard.

---

## 4. Agents

### 4.1 Workspace agents (`services/agents/src/tools.ts`, `ports.ts`)

`DOCS_TOOLS` and `DOCS_WRITE_TOOLS` are replaced:

| Tool | What |
|---|---|
| `search_artifacts` | `query`, optional `kind`, `space`, `project`. Hybrid search, audience-narrowed. |
| `read_artifact` | id or link. Returns the kind's agent form: doc → Markdown and block ids (as now); slides → deck Markdown with slide ids; design → node spec JSON (frames, then children); dashboard → spec JSON (tiles and queries). Plus `can: { read, suggest, edit }` and `audience_can_read`. |
| `create_artifact` | `kind`, `title`, `content` in the kind's agent form or `template`, `where: { space } \| "private" \| "conversation"`, optional `parent`. |
| `edit_artifact` | `FolioAgentEdit`, plus `note`, `suggest_only`, `marks_current`. Doc → inline suggestion or edit (as now). Other kinds → a direct edit where allowed, else a **proposal** (`folio_proposals`) a person previews and applies. |
| `list_spaces` | Spaces the asker and audience can all read, with abilities. |
| `stale_artifacts` | As `stale_pages`. |
| `query_data` | Runs a `DatasetQuery`, or a dashboard tile by id, **as the asker narrowed to the audience** (section 4.3). |
| `share_artifact` | Grants `view` or `comment` to people **already in the conversation**, only when the asker has `manage`. It can never set general access or grant `edit` or `manage`. For those, the agent posts a card with a "Share" button the person presses. |

**Where an agent's new artifact lands:**
- **Owner** is the asker. `created_by` is `agent:<id>`, and the agent gets an `edit` grant so it can keep working.
- **Location:**
- the named space, if the asker can edit there;
- "conversation": Private, plus `view` grants to the DM's or private channel's people;
- otherwise Private to the asker.

In a public channel the default is the workspace's General space if the asker can edit it, else Private, with the reply handled as in section 4.3.

### 4.2 External MCP and REST (`apps/api`, Rust)

- **Scopes** (`crates/contracts/src/scopes.rs` and the TS mirror `packages/contracts/src/scopes.ts`):
- `Resource::Artifacts` with `artifacts:read` (list, get, search, versions, query data), `artifacts:write` (create, update, edit, trash, restore, propose) and `artifacts:admin` (share, change general access, delete forever).
- Descriptions go into the scope table.
- **Tool:** one MCP tool `artifact` in `apps/api/src/tools.rs`, implemented in `apps/api/src/folios.rs` (`FoliosOp`). Actions:
- `list` (tab, kind, space)
- `search`
- `get` (metadata and the agent form)
- `create`
- `update` (title, icon, move)
- `edit` (`FolioAgentEdit`)
- `trash`
- `restore`
- `versions`
- `restore_version`
- `access`
- `share`
- `templates`
- `query_data`
- `spaces`

Its description must say it is not the `workflow` tool's run artifacts.
- **REST:**
- `GET/POST /workspaces/{ws}/artifacts`
- `GET/PATCH/DELETE /workspaces/{ws}/artifacts/{id}`
- `GET/PUT /workspaces/{ws}/artifacts/{id}/content`
- `GET/PUT /workspaces/{ws}/artifacts/{id}/access`
- `GET /workspaces/{ws}/artifacts/{id}/versions`
- `POST /workspaces/{ws}/datasets/query`
- **apps/api** gets a `DOCS` service binding and a small Rust client for the docs service RPC.
- **OpenAPI** (`apps/api/src/openapi.rs`) and `apps/docs/src/data/openapi.json` are regenerated (the test enforces it). Agent tokens (`AgentScope.operations`) can name the new operations.

### 4.3 Permissions and leak rules (must have tests)

1. **Agent reads.** These use `agentFolios(viewer, audience)`, generalizing `agentSpaces`: **folio-level** effective access for the viewer, intersected with every audience member's.
 - `audience: workspace` (a public channel) gives only folios readable through an open space or `general_access = 'workspace'`.
 - Link-only and Private folios never qualify for that audience.
 - More than 20 people is treated like the workspace audience.
2. **Agent replies about a folio the audience can't all read.** The tool result carries `audience_can_read: false`. The prompt rule is: "don't quote it here; say you made or found something and that you've sent the link to <asker> directly". The agents service sends the link to the asker as a DM or ephemeral notice.
3. **Chat link unfurls and cards** resolve per viewer. Someone who can't read the folio sees "An artifact you don't have access to" with no title.
4. **Mentions inside a folio.** Mentioning someone who can't read it asks the editor "Share with @x?". A notification is sent only to people who can read it. Mentioned agents are notified only through their asker.
5. **Backlinks, search and FTS** show only folios the reader can read now.
6. **Dashboard values** are computed per viewer. In an agent turn they run as the asker restricted to repositories every audience member can read (the `repoSpacesForAudience` pattern). `spend` and billing datasets are refused unless the audience is just the asker.
7. **Workspace memory.** A turn that read a non-workspace-readable folio writes `remember` facts at `person` scope by default (`services/agents/src/memory.ts`).
8. **Templates.** "Save as template" from a Private or shared folio confirms "Everyone in the workspace will be able to use this template".
9. **Events and the inbox** carry no title or content for folios that aren't workspace-readable.
10. **Rooms.** Access changes call `setRole` on every open room in the affected subtree (a queue job for large subtrees). Revoked sockets close with 4403.
11. **The vector index** is filtered by `scope` and always re-checked against D1 (section 5).

### 4.4 "Write this up" from Chat

`components/chat/write-up.tsx` and `lib/write-up.ts` become "Write this up as an artifact". The dialog has:

- **Kind:** Auto (default), Doc, Slides, Design or Dashboard.
- **Where:** a space the person can edit, **Private (just me)**, or **Shared with this conversation**. The default is "Shared with this conversation" in DMs and private channels, and the General space in public channels.
- **Title**, and **Writer** (as now).

The posted ask becomes:

`@g1t write this thread up as an artifact (<kind or "whichever kind fits best: a doc for decisions and notes, slides to present, a design for screens or layouts, a dashboard to track numbers">) <where> titled "<title>". Link this thread as the source: <link>`

The agent calls `create_artifact` with `source` set. `folios.source` shows "From a conversation" on the artifact, linking back for readers of the thread.

---

## 5. Search and the hybrid index

- **Indexer.** `src/indexer.ts` `indexPage` becomes `indexFolio(env, id)`. It reads `folios.text` and `kind` and chunks through `kinds[kind].chunks`:
- doc: by heading, as now (`chunks.ts`);
- slides: one passage per slide, with heading "Slide 4 · Pricing"; tiny slides join the next;
- design: one passage per top-level frame, with heading the frame name;
- dashboard: one passage (definition only).

The embed cap, the catch-up run and the backfill (`doc_index_runs`, which also covers folios) all stay.
- **Vectorize.**
- A new index `g1t-folios` (768 dimensions, cosine, binding `FOLIO_VECTORS`) with metadata indexes on `workspace_id`, `scope` and `kind`. Repository files move into it with `scope = repo:<repo space id>`.
- Ids are `<folio id>:<seq>` or `rf_…:<seq>`.
- **`scope`** is `space:<id>` when the folio's access is exactly its space's (inherit chain to the top, no restriction, no grants). Otherwise it is `folio:<acl_root>`.
- Recall builds `allowed` from readable spaces, readable access roots (from `folio_access`, the general access rows and visits) and readable repo spaces. It uses `$in` when there are 40 or fewer keys, else a workspace filter and a post-filter (`vectorQueryPlan` as today).
- **Every hit is re-checked** against D1 with `effectiveRole` and the audience before it is returned.
- When access changes, a `folios.rescope` job rewrites metadata for the subtree's vectors: `getByIds`, then `upsert` with the same values. No re-embedding.
- `g1t-docs` is deleted in Phase 7.
- **Adapters.** `Embedder` and `VectorStore` (`src/vectors.ts`) are unchanged; self-hosters swap them. Without them, word recall over `folio_chunks_fts` still works.
- **People's search.**
- Artifacts home `?q=` is hybrid (RRF, as now), with kind, space, owner and project filters, and shows the matched passage. The separate `/search` page goes away.
- Typing in link pickers stays words-only (`folios_fts`).
- The command palette (`routes/search-json.ts`) adds an "Artifacts" group from `search_folios` with a limit of 5.
- **Recall for agents.** `recall_folios_for_agent` returns `FolioPassage[]`. The agents service (`services/agents/src/recall.ts`) switches to it. The old `recall_for_agent` stays until Phase 7.

---

## 6. UI

### 6.1 Mode wiring

- **`lib/workspace-nav.ts`:** `ModeKey "docs"` becomes `"artifacts"`, `PAGE_MODES` maps `artifacts`, and `modeHome` gives `/${slug}/-/artifacts`. Update `workspace-nav.test.ts`.
- **`components/rail.tsx`:** `{ key: "artifacts", label: "Artifacts", icon: <Shapes size={19}/> }` in the same slot as Docs.
- **`components/shell.tsx`:** `Panel "artifacts"`, `MODE_MENU`, and `sidebarFor` renders `<FoliosSidebar>`.
- **`components/mobile.tsx`:** the tab bar and the sheet row.
- **`routes.ts`:**
- Remove every `-/docs` route. Per the decision, there is no redirect; old links 404 with the normal not-found page.
- Add, under `:owner`:

```
-/artifacts/live            routes/workspace/folios/live.ts
-/artifacts/api             routes/workspace/folios/api.ts         (JSON: list, sidebar, access, versions, templates, search, mutations)
-/artifacts/query           routes/workspace/folios/query.ts       (dashboard tile data)
-/artifacts/threads/:folio/* routes/workspace/folios/threads.ts
-/artifacts/upload          routes/workspace/folios/upload.ts
-/artifacts/export          routes/workspace/folios/export.ts
-/artifacts (layout)        routes/workspace/folios/layout.tsx
index                     home.tsx          ?tab=all|yours|shared &view=list|grid &kind= &space= &owner= &project= &q=
new/:kind                 new.tsx           ?space= &parent= &template=  (creates, then redirects)
templates                 templates.tsx     ?kind=
trash                     trash.tsx
stale                     stale.tsx
spaces                    spaces.tsx        (browse and join open spaces)
spaces/new                space-new.tsx
spaces/:space             space.tsx
spaces/:space/settings    space-settings.tsx
repo/:repoOwner/:repoName/* repo-file.tsx   (projects' docs, read-only, unchanged)
:folio                    folio.tsx         (<title-slug>-<id>; dispatches to the kind's editor; ?present=1 for slides)
:folio/history            history.tsx
```

Addresses are flat and end in the id, so moving between spaces and Private never breaks a link.

### 6.2 Home (`routes/workspace/folios/home.tsx`)

- **Header:** "Artifacts", with a search box (`/` focuses it), filters (Kind, Space, Owner, Project) and a **grid/list toggle**. Icon buttons have a `Hint`.
- **Tabs:** **All / Yours / Shared with you** (`ui/tab-strip.tsx`), kept in the URL.
- **"Make something new" tiles:** Docs, Slides, Design, and Dashboard with a "Beta" badge.
- Each tile goes to `new/:kind`, with a "Starting…" busy state and no double submit (as in the latest Docs fix).
- A split chevron on each tile opens "From a template…" and "In a space…".
- **List view, grouped by day** in the viewer's time zone (`lib/time-zone.ts`): **Today, Yesterday**, then `Oct 7`, with the year when it isn't this year. Each row shows:
- the **kind icon**, in the kind's colour on a soft square: Docs `FileText`, Slides `Presentation`, Design `PenTool`, Dashboard `LayoutDashboard`;
- the title (or "Untitled");
- a **lock icon** with the Hint "Only you can see this" when private, or else up to 3 avatars of who it's shared with;
- the space name (muted);
- "Edited 45m ago" (`TimeAgo` on `edited_at`), with "by @x" in the Hint;
- a **⋯ menu**: Open in new tab, Add to Favorites, Share…, Rename, Duplicate, Move to…, Copy link, Export, Save as template, Move to trash.
- **Ordering by tab:**
- **Yours:** `owner = me`, by `edited_at`.
- **Shared with you:** `folio_access` rows for my keys that aren't mine, by `since` or `edited_at`, whichever is newer. Link-visited folios are included.
- **All:** everything readable, by `edited_at`.
- **Paging:** cursor paging with "Show more".
- **Grid view:** cards with a **client-rendered preview** from `folios.preview` (JSON written at save time):
- doc: the first lines;
- slides: the first slide's layout and title;
- design: the first frame's top 50 simplified nodes;
- dashboard: tile boxes with titles and no numbers.

No server thumbnails until Phase 8.
- **Empty states per tab:** "Nothing shared with you yet. When someone shares an artifact with you, it shows up here."

### 6.3 Sidebar (`components/folios/sidebar.tsx`, from `components/docs/sidebar.tsx`)

- Search, then **Home**, **New ▾** (the four kinds) and **Templates**.
- **Favorites**: draggable.
- **Spaces**: joined open spaces, my team spaces and my Members-only spaces, each with its tree. "Browse spaces" and "New space" are in the section's `+`.
- **Private**: my tree, with nothing in a space.
- **Shared**: the tops of what's shared with me, meaning the highest readable ancestor.
- **Possibly out of date** (when there is anything), **Projects' docs** (repo spaces) and **Trash**.
- **Tree rows** show the kind icon or emoji, drag to reorder or nest (docs accept children), and have a ⋯ menu. A lock shows on restricted subtrees.
- `lib/docs.ts` `buildTree` becomes `lib/folios.ts`.

### 6.4 Share dialog (`components/folios/share-dialog.tsx`)

Opened from the editor header's **Share** button and from ⋯ → Share….

- **Title:** "Share '<title>'".
- **Invite row:** a people picker for people, agents and teams (`components/people-picker.tsx`, extended with agents and teams), a role select (Can view / Can comment / Can edit / Full access, from `DOC_ROLE_LABELS`), an optional "Notify" message, and **Invite**.
- **"Who has access":**
- the owner;
- explicit grants, editable;
- inherited rows, read-only with "From <space>" or "From <parent>" and a link to manage them there.
- **General access:**
- in a space: **Everyone in <space>** (inherits) or **Only people invited** (restricts);
- then: **Restricted** / **Everyone in <workspace>** (with a role) / **Anyone in the workspace with the link** (with a role);
- "Public link: off for this workspace" is shown disabled until Phase 8.
- **Agents:** "Agents may: suggest changes / edit directly" (`agent_mode`), defaulting to the space's.
- **Footer:** **Copy link**, and Done.
- Changing access shows "Updated" inline and the room's live notice refreshes other people's badges.
- People without `manage` see the dialog read-only with "Ask <owner> for access", which sends a request notification.

**Request access:** a 403 on a folio shows "You need access" with a button that notifies the owner and managers. The owner gets an inbox item with Approve (view / comment / edit) / Deny.

### 6.5 Editor shells (`components/folios/shell.tsx` + per kind)

**A shared header:**
- breadcrumb: space or Private › parent;
- icon and title (inline rename);
- presence avatars;
- the "Offline, changes will sync" status (from the provider);
- **Share**, a comments toggle, a history toggle, ⋯ (Favorite, Duplicate, Move, Export, Save as template, Trash);
- the kind's own actions: Slides **Present**; Design zoom and Export frame; Dashboard **Refresh**, as-of time and filters.

**Shared side panels:** comments, history (versions list, preview, restore) and proposals (preview with accept/reject, for non-doc kinds).

**Per kind:** `components/folios/doc/`, `slides/`, `design/`, `dashboard/`. Each is lazy-loaded through `React.lazy` so the home page carries no editor code.

### 6.6 Phone

- **Home:** list view only, tiles as a horizontal scroller, filters in a sheet, and the sidebar in the mode sheet.
- **Docs:** full editing (as today).
- **Slides:** view, present (swipe) and edit text on the current slide. No reordering or layout changes beyond a sheet.
- **Design:** view, pan, zoom and comment. Editing says "Open on a larger screen to edit the canvas".
- **Dashboards:** a single-column read view, refresh, and the filters sheet.

---

## 7. Docs service RPC (`services/docs`, `foliosClient`)

**New file layout**, so `index.ts` stops growing:
- `src/folios/service.ts`: the class `Folios`, sharing workspace, people and teams helpers moved from `index.ts` into `src/who.ts`.
- `src/folios/rpc.ts`: a method table.
- `src/folios/list.ts`, `access-store.ts`, `agents.ts`, `recall.ts`.
- `src/datasets/run.ts`: `query_tile`, validation and cache.
- `src/kinds/*`.
- `index.ts` keeps routing: `/rpc/<method>` checks the folio table first, then the legacy switch.

**Methods:**
- Lists and navigation: `folio_list`, `folio_sidebar`, `folio`.
- Changing folios: `create_folio`, `update_folio`, `move_folio`, `duplicate_folio`, `trash_folio`, `restore_folio`, `delete_folio`, `folio_trash`, `favorite_folio`.
- Sharing and spaces: `folio_access`, `set_folio_grant`, `set_folio_general_access`, `request_folio_access`, `join_space`, `leave_space` (plus the existing space methods).
- Search, history, templates and export: `search_folios`, `folio_versions`, `folio_version`, `restore_folio_version`, `folio_templates`, `save_folio_template`, `delete_folio_template`, `export_folio`.
- Suggestions and proposals: `folio_suggestions`, `decide_folio_suggestion`, `folio_proposals`, `decide_folio_proposal`, `folio_thread`, `folio_threads`.
- Dashboards: `query_tile`, `query_dataset_for_agent`.
- Agent calls: `folios_for_agent`, `read_folio_for_agent`, `create_folio_as_agent`, `edit_folio_as_agent`, `share_folio_as_agent`, `recall_folios_for_agent`, `stale_folios_for_agent`, `mark_folio_current`, `reindex_folios`.

**Other entry points:** `GET /live?folio=` and `PUT /files?folio=`.

**Wrangler** (`services/docs/wrangler.jsonc`):
- `FolioRoom` (DO migration v2);
- `FOLIO_VECTORS` (`g1t-folios`);
- service bindings `ACTIONS`, `DEPLOYMENTS`, `BILLING` for dataset fan-out (`WORK` and `AGENTS` already exist);
- a cron (`"triggers": { "crons": ["17 3 * * *"] }`) to purge trash older than 30 days.

**Datasets fan-out** goes through a `DatasetSource` port per service, so self-hosting needs nothing special.

---

## 8. Phases

Each phase deploys on its own:
- Migrations ship in or before the phase that reads them.
- Nothing deployed still reads what a phase drops.
- Deploy order inside a phase is the docs service, then agents and api, then web.

Sizes:
- **S** ≈ ≤1 day of one agent
- **M** ≈ 2–4 days
- **L** ≈ 1–2 weeks
- **XL** ≈ 2–4 weeks

| # | Phase | Size | Ships | Depends on |
|---|---|---|---|---|
| 0 | **Contracts and plan** | S | `folios.ts`, `folios-*.ts`, `datasets.ts` (types and validators, with tests); `crates/contracts` `folios.rs`, `datasets.rs`, `FOLIO_EVENTS` (not yet subscribed); `Resource::Artifacts` scopes (not yet used by any op); this doc. No runtime change. | none |
| 1 | **Service core + doc kind** | L | Migration `0004_folios.sql`; `FolioRoom` with the kind adapter and `kinds/doc`; access (`effectiveRole`, materialize, with tests); list, sidebar, CRUD, share, trash, versions, templates (doc builtins ported), search, `folio.*` events; indexer to `g1t-folios`; agent RPCs (`*_for_agent`, `recall_folios_for_agent`). Old Docs keeps running on old tables. | 0 |
| 2 | **Artifacts mode (web) + agents switch** | L | Rail, mode, shell and mobile wiring; `-/docs` routes deleted; home (tabs, tiles, day-grouped list, grid), sidebar, share dialog, editor shell, doc editor moved, history, trash, templates, spaces pages. **Same release:** `services/agents` tools and recall switched to the folio RPCs (`search_artifacts`, `read_artifact`, `create_artifact` (doc only for now), `edit_artifact`, ...); the write-up dialog with Where (kind fixed to Doc until slides ship); per-viewer chat unfurls for artifact links. Old pages are dropped (see D2). apps/docs: `guides/artifacts.mdx` (overview, spaces, sharing, private), `guides/docs.mdx` removed. Slides, Design and Dashboard tiles show "Coming soon" (disabled with a Hint), not hidden, until their phase. | 1 |
| 3 | **External MCP/REST** | M | `artifact` MCP tool, REST routes, `artifacts:*` scopes on ops, OpenAPI and `apps/docs/src/data/openapi.json`, `DOCS` binding in apps/api, guide `guides/bring-your-own-agent.mdx` section, scope table in `guides/authentication.md`. | 1 (parallel with 2) |
| 4 | **Slides** | L | `kinds/slides.ts` (Markdown deck parse/serialize, ops, chunks, preview), slides editor, filmstrip, layouts, themes, present and presenter mode, print to PDF, slides templates (5), agent ops, write-up kind, apps/docs `guides/artifacts-slides.md`. | 2 (editor shell registry) |
| 5a | **Datasets in owning services** | M each, parallel | `query_dataset` in `services/work` (issues, PRs), `services/actions` (runs), `services/deployments`, `services/billing` (spend), `services/agents` (sessions, spend), each with access tests and a D1 index migration where needed. | 0 |
| 5b | **Dashboards** | L | `components/charts/` (extracted from usage.tsx; usage pages switched to it), `kinds/dashboard.ts`, grid editor, query builder, `query_tile` with cache, the `query_data` agent tool, 4 templates, "Beta" badge, apps/docs `guides/artifacts-dashboards.md`. | 2, 5a (each dataset lights up as its service ships) |
| 6a | **Design: canvas core** | L | `kinds/design.ts`, SVG renderer, tools, select, snap, layers and properties, frames with stack layout, images, awareness cursors, comments pinned, export SVG/PNG, agent `upsert_nodes`. | 2 |
| 6b | **Design: components and HTML frames** | M | Components and instances, `html` nodes in the usercontent sandbox (with server sanitizer), design templates (4), apps/docs `guides/artifacts-design.md`. | 6a |
| 7 | **Cleanup** | S | Migration `0006_drop_pages.sql`; DO migration v3 `deleted_classes: ["PageRoom"]`; remove the legacy RPC methods, `DocPage*` contracts, `doc.page.*` from `events.ts`, `events.rs` and `subscribers.rs`, `components/docs/*` and `routes/workspace/docs/*` leftovers; delete Vectorize `g1t-docs`; rewrite docs/WORKSPACE.md "Docs" to point here. Ships only after 2, 3 and the agents switch have been deployed everywhere. | 2, 3 |
| 8 | **Later** | — | Public links (usercontent origin, workspace setting, `view` only); server PDF and thumbnails through the `Renderer` adapter (og `Screenshots`); imports (Markdown folders, a deck file); `folio.*` events offered to webhooks; a documenter agent routine on `folio.stale`; dashboard alerts. | — |

### Parallel worktrees and file ownership

**One worktree each, in parallel:**
- **After 0:** `1`, `5a-work`, `5a-actions`, `5a-deployments`, `5a-billing`, `5a-agents`. Each 5a branch owns only its service directory and `crates/contracts/src/datasets.rs` additions. The contracts are settled in 0, so these are read-only for 5a.
- **After 1:** `2` and `3`.
- **After 2:** `4`, `5b` and `6a`.

| Phase | Owns (exclusive) | Touches (append-only, merged by the integrator) |
|---|---|---|
| 1 | `services/docs/src/folios/**`, `src/kinds/doc/**`, `src/kinds/types.ts`, `src/access.ts`, `src/indexer.ts`, `src/persist.ts`, `src/room.ts`, `migrations/0004_*`, `wrangler.jsonc` | `src/index.ts` (route to the folio table) |
| 2 | `apps/web/app/routes/workspace/folios/**`, `components/folios/{shell,sidebar,share-dialog,provider,kinds,doc/**}`, `lib/folios.ts`, `lib/workspace-nav.ts`, `rail.tsx`, `mobile.tsx`, `routes.ts`; `services/agents/src/{tools,ports,recall}.ts`; `components/chat/write-up.tsx`, `lib/write-up.ts`; `apps/docs/.../guides/artifacts.mdx` | `components/shell.tsx` (panel switch) |
| 3 | `apps/api/src/folios.rs`, `apps/api/wrangler.jsonc`, `crates/contracts/src/scopes.rs` (Artifacts ops) | `apps/api/src/{tools,rest,openapi,operations}.rs`, `apps/docs/src/data/openapi.json` |
| 4 | `services/docs/src/kinds/slides/**`, `src/templates/slides.ts`, `components/folios/slides/**`, `packages/contracts/src/folios-slides.ts`, `guides/artifacts-slides.md` | `kinds/index.ts`, `components/folios/kinds.tsx` (one line each) |
| 5b | `components/charts/**`, `components/usage.tsx`, `services/docs/src/kinds/dashboard/**`, `src/datasets/**`, `components/folios/dashboard/**`, `routes/workspace/folios/query.ts`, `folios-dashboard.ts` | the same registries; `services/agents/src/tools.ts` (`query_data`, a small hunk) |
| 6a/6b | `services/docs/src/kinds/design/**`, `components/folios/design/**`, `folios-design.ts`, `apps/web/workers/usercontent.ts` (html frames, 6b only) | the same registries |

Conflict hotspots are kept to one-line registry appends: `kinds/index.ts`, `components/folios/kinds.tsx`, `packages/contracts/src/index.ts` exports and the apps/docs sidebar config. Never reformat these files in a feature branch.

---

## 9. Risks and open decisions, each with a recommendation

| # | Decision or risk | Recommendation |
|---|---|---|
| D1 | Code name for the mode | **`folio`** in code; "artifact" only in UI, URLs, MCP, REST and scopes (section 0). Keep `services/docs` and the `g1t-docs*` resources. |
| D2 | Carry existing Docs pages over, or drop them? | **Drop** (pre-launch; the user allows a reset). A copy needs every old room's Yjs state read through `PageRoom.state()` for little value. Re-seed demo workspaces from the new templates. If a copy is wanted after all, a one-off owner-run `copy_pages_to_folios` job (pages become `doc` folios in the same spaces, state copied) is an M-sized add-on to Phase 2. |
| D3 | `-/docs` URLs | **Removed, no redirect** (the user's instruction). They 404 with the normal page. |
| D4 | Addresses | **Flat** `/-/artifacts/<title-slug>-<id>`, so moves never break links. Spaces at `/-/artifacts/spaces/<slug>`. |
| D5 | Folders | **No folder kind in v1.** Docs hold children, and only docs. Revisit only if people ask to group decks without a page. |
| D6 | Space kinds | Keep `workspace` / `team` / `private` in the database. In the UI: **Open**, **Team**, **Members only**. Open spaces need a **join** (`space_joins`) to show in the sidebar, so it doesn't fill up. |
| D7 | Who can share | **`manage` only by default.** A space setting "Editors can share" is offered. Agents can only grant view or comment to people already in the conversation, never general access. |
| D8 | Agent changes to non-doc kinds where they can't edit | **Proposals**: a Yjs update against a state vector, previewed in a forked document, applied or rejected as a whole. Doc keeps inline suggestions. |
| D9 | Design canvas library | **Build on SVG with Yjs maps**, with `html` frames in the usercontent sandbox for rich agent output. Don't adopt a whiteboard library (licence and fit, section 3.3). Scope it as a layout tool, not a vector editor. |
| D10 | Charts | **Own SVG chart kit** extracted from `components/usage.tsx`. No dependency, and the usage pages share it. Revisit only if we need more than about 8 chart types. |
| D11 | Dashboard query safety | **A declared dataset catalog, not SQL.** Executed by owning services as the viewer. Values never persisted in the folio, versions, index or previews. Agents are audience-narrowed, and spend is refused in shared audiences. |
| D12 | Dashboard numbers differ by viewer | Accepted and labelled: "Based on what you can see" when `partial`. Don't add "run as owner" in v1 (it would leak). |
| R1 | Access complexity and performance | Materialized `folio_access` and a denormalized `acl_root`/`path`, with pure `effectiveRole` tests over a matrix of private / space / team / general / link / restrict / nested / owner-workspace-owner. Tree depth capped at 10. Big subtree changes go through the queue. |
| R2 | Stale vector metadata after access changes | A `scope` key plus a mandatory D1 re-check of every hit. Rescope jobs only improve recall quality; correctness never depends on them. |
| R3 | Yjs document size (design) | Images are files, never inline. Node, html and file caps are enforced in `validate`. Version state over 1.5 MB goes to the file store (`state_key`). Compaction as today. |
| R4 | BlockNote instances per deck | Mount live editors only for the current slide; thumbnails are static renders. Fallback: one editor per slide body with regions as blocks. |
| R5 | Bundle size | Each kind's editor is lazy-loaded. Home ships no editor code. The chart kit loads only with dashboards. |
| R6 | HTML in design frames (XSS) | Server-side sanitizer, served only from the usercontent origin in `sandbox=""` iframes with a strict CSP (no scripts, no forms, images only from the files origin). |
| R7 | Self-hosting | DO, R2, D1, Vectorize, Workers AI, the Cache API and Browser Rendering each sit behind an existing or new adapter (`room`, `FileStore`, SQL, `Embedder`, `VectorStore`, `QueryCache`, `Renderer`, `DatasetSource`). docs/SELF_HOSTING.md is updated in Phases 1, 5b and 8. |
| R8 | Window where agents and UI disagree during Phase 2 | Ship the docs service first, then agents and web in the same release. Until then the old Docs UI and old tools keep working on the old tables. |
| R9 | Rail label length | "Artifacts" is 9 characters, the same as "Workspace", which already fits the 5rem rail. |
| R10 | Insights placeholder | Later, point `-/insights` at a workspace-pinned dashboard ("Engineering health" template). Not in scope now. |
| R11 | Public links | Phase 8, off by default per workspace, view only, never indexed or recalled, and revocable by rotating the token. |
| R12 | Copy rules | No product comparisons in UI or apps/docs. The tile labels are "Docs, Slides, Design, Dashboard". |

---

### Critical Files for Implementation

- `services/docs/src/room.ts`: becomes `FolioRoom` with kind adapters.
- `services/docs/src/index.ts` and `src/access.ts`: RPC routing, access rules, agent reads and recall (`agentSpaces`, `recallForAgent`).
- `packages/contracts/src/docs.ts`: the source for the new `folios.ts` and `datasets.ts`.
- `apps/web/app/routes.ts`, plus `apps/web/app/lib/workspace-nav.ts`, `apps/web/app/components/rail.tsx` and `apps/web/app/components/shell.tsx`: mode wiring.
- `services/agents/src/tools.ts` and `apps/api/src/tools.rs`: agent and MCP tools.

---

## 10. Decided in Phase 0

Phase 0 shipped the contracts with no runtime change. Where this plan was open, it settled these:

- **Scopes not offered yet.** `artifacts:read|write|admin` are in `Scope::ALL` (at the end) behind `Resource::offered()`, which is false for Artifacts. Presets, full access as a list (`everything()`), OAuth's `scopes_supported`, `parse_scopes` and `resolve_permissions` leave them out, and no operation needs them. The TypeScript mirror keeps them in `UPCOMING_SCOPES` and `UPCOMING_RESOURCES`, so the token form, the OAuth checklist and apps/docs never show them. Phase 3 makes `offered()` true, moves the rows to the end of `SCOPES` and `SCOPE_RESOURCES`, adds `artifacts:read` to the presets and adds the docs scope table.
- **Dataset catalog.** Section 3.4 named the datasets. Phase 0 fixed their fields (`DATASETS` in `datasets.ts` and `datasets.rs`):
  - per dataset: `times` (the default first), `dimensions` (text), `measures` (numbers) and `rates` (yes-or-no, for `rate`);
  - `DatasetQuery.time` picks the time field;
  - `DatasetResult.partial` drives "Based on what you can see";
  - limits: 10 filters, 50 values per `in`, 100 rows, and a `{ from, to }` range of at most 366 days, given as dates or RFC 3339 UTC times.
  The 5a services implement exactly these fields.
- **Three more RPC methods.** `folio_content` and `edit_folio` are a person's (or their token's) read and edit in the agent form, for REST `/content` and the MCP `get`/`edit` actions. `query_dataset` is a person's query, for `POST /datasets/query` and MCP `query_data`. `FolioAccessChange` also carries `inherit` and `agent_mode` changes. The client sends grants and revokes to `set_folio_grant` and the rest to `set_folio_general_access`.
- **Events.** Payloads are camelCase, like every event on the bus. `title` is null unless the whole workspace can read the folio. `folio.updated` uses `versionKind`, because `kind` is the folio's kind. `folio.stale` names the repository as `owner/name` only. `FOLIO_EVENTS` and the payload structs are in `folios.rs` (re-exported from `events.rs`). `subscribers.rs` is untouched until Phase 1 publishes them.
- **Validators.**
  - They are pure and return an error sentence or null (`Result` in Rust), and the words are the same in both languages.
  - Shared cases in `datasets.fixtures.json` and `folios.fixtures.json` are run by both test suites.
  - Contracts files import only types from each other, because Node runs the tests on the files as they are. So `dashboardOpError` takes the query validator (`datasetQueryError`) as an argument.
- **Ids.** `fol_` for folios and `prp_` for proposals. Versions, templates and files keep `ver_`, `tpl_` and `fil_`.
- **Slides themes** are a slug plus an optional `#rrggbb` accent. Phase 4 names the themes.

---

## 11. Decided in Phase 1

Phase 1 shipped the service core and the doc kind in `services/docs` (migration `0004_folios.sql`, `src/folios/**`, `src/kinds/**`, `src/who.ts`). Old Docs keeps running on its own tables. Where the plan was open, the build settled these:

- **Where the code lives.**
  - `FolioRoom` is a new file, `src/folios/room.ts`, beside an untouched `src/room.ts` (`PageRoom`). Both share `ROOM_MEMBER_HEADER` and `awarenessEntries`.
  - The doc kind (`src/kinds/doc/`) uses `blocks.ts`, `markdown.ts`, `edits.ts`, `citations.ts` and `threads.ts` where they are, because `PageRoom` still needs them. They move under `src/kinds/doc/` in Phase 7.
  - `src/who.ts` is a copy of the legacy `Docs` class's workspace, people, teams and space helpers, since `index.ts` only gets appended to in this phase. The legacy copy goes in Phase 7.
  - `index.ts` sends `/rpc/<method>` to `src/folios/rpc.ts` first. A test checks that table against `FOLIO_RPC_METHODS`. `/live?folio=` and `PUT /files?folio=` are folios'. `GET /files/<key>` looks in `folio_files` first, then `files`.
- **Access.**
  - The owner of an ancestor that a folio inherits from counts as a `manage` grant there (`folio_access.via` is that ancestor). So whoever owns a doc keeps full access to what others add under it, unless a restriction cuts it off.
  - Workspace owners get `manage` only through a space the folio inherits: open and team spaces, as for pages. A restricted folio inside an open space is "Only people invited", for owners too.
  - General access is set only on an access root: a top-level folio, or a restricted one. On a folio that inherits, the call is refused and says where to change it. Following the parent again (`inherit` back to true) clears the child's own general access.
  - Link access counts a visit to the folio itself or to its access root. Opening it is the `folio` read or the live socket; only the `folio` read records the visit.
  - "Private" (the lock) is computed by `isPrivateFolio`: no other owner along the chain, no grant, no general access, no inherited space.
- **Moving and copying.**
  - A child always shares its parent's space. Only the owner can move a folio to the top of their Private.
  - A move is refused when it would put a folio inside itself, under something that isn't a doc, or deeper than 10.
  - **Duplicate** needs only `view`. The copy lands beside the original when the person can add there, otherwise in their Private. It is theirs, with no grants and no general access, so a copy is never shared more widely than the original.
- **Subtree work** goes through `rebuildSubtree`, which recomputes `space_id`, `acl_root` and `path` from the top down and then rewrites `folio_access`.
  - Above `FOLIO_INLINE_REACL` (2,000), a `folios.reacl` job on `JOBS` does the work.
  - Then open rooms get `setRole` for each connected person. The local smoke test showed the `{ type: "access", role: null }` notice arriving, but `wrangler dev`'s proxy never passed the 4403 close frame to the client. Check that in production.
  - Passages are re-filed under their new scope, which only rewrites vector metadata.
- **D1 limits met while building.** D1 refuses LIKE patterns over 50 bytes, so subtrees are found with a `substr(path, 1, n) = path` prefix compare. Lists of ids and keys go in as a single JSON parameter (`json_each`), which stays inside the 100-parameter limit.
- **Agents** (`src/folios/agents.ts`, tested against the rules in section 4.3):
  - Finding things (`folios_for_agent`, search, `recall_folios_for_agent`, `stale_folios_for_agent`) is narrowed to folios that the asker and everyone in the audience can read.
  - `read_folio_for_agent` by id works whenever the asker can read the folio, and returns `audience_can_read: false` when someone in the conversation can't (rule 2).
  - Create and edit calls take no audience.
  - `share_folio_as_agent` works only in a people audience (a DM or a private channel), only for people already in it, only `view` or `comment`, and it never lowers an existing grant.
  - A folio an agent creates belongs to its asker, has `created_by` set to the agent, and gives the agent an `edit` grant. `where: { conversation }` adds `view` grants for the conversation's members. `source` is stored in `folios.source` and is not added to the text (Docs' agents used to prepend a note).
- **Index.**
  - Folios go to `g1t-folios` (`FOLIO_VECTORS`). When the binding or `AI` is missing, the service logs it once per isolate and matches words over `folio_chunks_fts`.
  - Projects' docs stay in `g1t-docs` and `doc_chunks` for now. `recall_folios_for_agent` merges them in, as `FolioPassage.repo_file`. Moving them into `g1t-folios` is left for Phase 7.
  - The backfill gained a folio stage, with cursors `p:`, then `o:`, then `f:`.
- **Kinds not built yet.**
  - Making, reading or exporting slides, designs or dashboards answers `invalid`, saying they "aren't here yet".
  - `folio_proposals` lists whatever is in the table, which is empty until later phases. `decide_folio_proposal` answers `invalid`.
  - `query_tile`, `query_dataset` and `query_dataset_for_agent` answer `invalid` until Phase 5b.
- **Templates.** Built-in ids are now `builtin:doc:<slug>`; the old `builtin:<slug>` still resolves.
- **History.** A version's Yjs state over 1.5 MB goes to the file store at `docs/versions/<folio>/<version>` (`state_key`). A new room's first content is seeded with no origin, so creating a folio records only its `created` version and is nobody's edit.
- **Events.**
  - `folio.created` goes out once per new folio. Grants given at creation don't send `folio.shared`.
  - `folio.shared` goes out once per grant change. Revokes send nothing.
  - `folio.updated` goes out once per version, except the `created` one.
  - Titles are included only when the whole workspace can read the folio.
  - `subscribers.rs` lists `folio.*` among the types that are published but not offered to webhooks.
- **Staleness.** `src/staleness.ts` also records folios whose citations a change touched, in `folio_changes`. It tells the owner, notifies open rooms and publishes `folio.stale`.
- **Trash.** A daily cron (`17 3 * * *`) deletes folios that have been in the trash for over 30 days, 500 per run. A self-hosted install runs it too, via `scheduler.mjs`.
- **Sidebar.** The General space always shows. Other open spaces show once joined (`space_joins`), and `join_space` takes open spaces only.

Open for Phase 2:
- **Old pages (D2).** The plan drops them, so check that before the web switches over.
- **"Editors can share."** `canShare` supports this per-space setting, but nothing sets it yet.
- **Access requests.** `request_folio_access` sends to the owner and the people with full access, at most 20, with no limit on how often. Decide whether it needs one.
- **Self-hosted rooms.** `deploy/self-host/configs.mjs` doesn't copy `durable_objects` into the self-hosted configs. That gap predates this phase and affects `PageRoom` too. Check it before relying on rooms self-hosted.

---

## 12. Decided in Phase 2

Phase 2 shipped the Artifacts mode in `apps/web`, switched `services/agents` to the folio RPCs, and replaced apps/docs `guides/docs.mdx` with `guides/artifacts.mdx`. Where the plan was open, the build settled these:

- **Old pages (D2): dropped.** Nothing copies them. The web no longer reads pages, and agents no longer call the page RPCs; the tables, `PageRoom` and the legacy methods stay until Phase 7. `-/docs` routes are gone with no redirect and answer the normal not-found page. Spaces are shared, so the web still uses the legacy space methods (`space`, `create_space`, `update_space`, `set_space_member`) and projects' docs (`add_repo_space`, `repo_page`), whose file links now point at `-/artifacts/repo/...`.
- **Migration `0005_space_sharing_and_access_requests.sql`.** It adds `spaces.editors_can_share` (default 0) and `folio_access_requests`. Phase 7's drop migration becomes `0006_drop_pages.sql`.
- **"Editors can share" (D7).** A switch in a space's settings, off by default. When on, an editor of something in the space can grant and change grants up to `edit`. Granting `manage`, changing a grant that is `manage`, general access, `inherit` and `agent_mode` stay with full access. `DocSpace` and `NewDocSpace` gained `editors_can_share`.
- **Access requests.** At most one per person per folio per 24 hours (`claimAccessRequest`, one upsert, tested over the migrations); a second ask answers `conflict` with "You already asked for access to this in the last day…". It still goes to at most 20 people.
- **Two contract additions.**
  - `folio_page` (`FolioPage`): the folio, its saved text for the read view, the readable docs above it, what's inside and what links to it, and open suggestions, in one call. It records the visit, like `folio`. Added to `FOLIO_RPC_METHODS` in TS and Rust.
  - `folio(..., { peek: true })`: a read that records no visit and doesn't find trashed folios, for chat's link cards. A card never makes a link folio readable.
- **Addresses (D4).** `/-/artifacts/<title-slug>-<id>`, renamed slugs redirect to the current one; spaces at `/-/artifacts/spaces/<slug>`, history at `<folio>/history`. A folio someone can't read, or that doesn't exist, shows "You need access" (status 403) with **Ask for access**.
- **Making one.** `new/:kind` makes a folio only on a POST (forms on the tiles, templates and space pages), so a prefetched or repeated link never does. Kinds not ready answer 404 there. Tiles for Slides, Design and Dashboard are disabled with a `Hint` ("… are coming soon").
- **Home.** Days are the viewer's: the browser's zone, remembered in the `g1t_tz` cookie so the server renders the same days. Instead of up to three avatars, a row shows a lock (only you), a globe (workspace), a link (link access) or a people count, because `Folio` carries `shared_count`, not who. Someone else's folio in no space shows its owner's name, not "Private". The owner filter takes a username. "Possibly out of date" filters the 100 most recently edited by `stale`; a person-level stale list RPC would be exact.
- **Editor shell.** `components/folios/kinds.tsx` registers each kind on one line, with a lazy `Body`; only the doc's is set. The BlockNote editor stays browser-only inside the doc body, and Home's chunks carry no editor code. Covers aren't offered, because `Folio` has no `cover`; "Describes" and the staleness detail of Docs' pages aren't either (a doc shows "Possibly out of date" with **It's current**).
- **Write-up (4.4).** Kind fixed to a doc. Where is "Shared with this conversation" (DMs and private channels, chosen first), "Private (just me)", or a space in the sidebar the person can add to; a public channel starts on General when they can add to it. The ask reads `@g1t write this thread up as an artifact (a doc) <where> titled "<title>". Link this thread as the source: <link>`, where `<where>` is `in the <name> space`, `privately (just for me)` or `shared with this conversation`.
- **Agents.**
  - `list_spaces` uses the legacy `spaces_for_agent`.
  - `read_artifact` holds back content and title when `audience_can_read` is false, and DMs the asker the link.
  - After such a read, `remember` stores at the asker's `person` scope (4.3 rule 7).
  - `query_data` is left to Phase 5b.
- **Command palette.** No "Artifacts" group yet (plan section 5); Home's search covers it.

Open for later phases:
- **A spaces-for-person RPC.** Browse spaces reads the legacy `sidebar`, and the write-up offers only sidebar spaces. A folio-side `spaces` method that returns every readable space would serve both, and Phase 3's slug lookup.
- **Who it's shared with.** Avatars on rows need the grants' principals on `Folio` (a few, capped), or a batch access call.
- **Phone tab.** As with Docs, Artifacts is a tab only for members without Code; others reach it from the workspace sheet.

---

## 13. Decided in Phase 3

Phase 3 shipped the external API in `apps/api` (`src/folios.rs`, the `artifact` tool, 17 routes) over a `DOCS` binding to `g1t-docs-service`, and made the `artifacts:*` scopes real. Where the plan was open, the build settled these:

- **Operation names.** GitHub's names for workflow runs' artifacts (`list_artifacts`, `get_artifact`, `delete_artifact`) are taken, so every artifact operation says `workspace_artifact`: `list_workspace_artifacts`, `get_workspace_artifact_content`, `set_workspace_artifact_access`, and so on. Dataset queries are `query_workspace_dataset`. The OpenAPI section is "Artifacts"; workflow runs' artifacts stay under "Actions".
- **Scopes.**
  - Every resource is offered now, so `Resource::offered()` is true for all; the mechanism stays for the next resource built ahead of its API. `UPCOMING_SCOPES` and `UPCOMING_RESOURCES` are empty, and the Artifacts rows are at the end of `SCOPES`, `SCOPE_RESOURCES` and `OPERATION_SCOPES`. `SCOPE_GROUPS` has an Artifacts group.
  - Read only and Agent get `artifacts:read` (Rust adds it because both take every offered read). No preset writes or shares artifacts.
  - Read: list, search, get, content, versions, access, templates, spaces, dataset query. Write: create, update (rename and move), edit (applied or suggested), trash, restore, restore a version. Admin: share (grants, general access, inherit, agent mode) and purge.
  - `set_workspace_artifact_access` and `purge_workspace_artifact` are in `NEVER`: g1t's own agents share only through the agents service, with people already in the conversation.
- **The tool's actions** are `list`, `search`, `get`, `read`, `versions`, `access`, `templates`, `spaces`, `query_data`, `create`, `update`, `edit`, `trash`, `restore`, `restore_version`, `share` and `purge`. The plan's `get` (metadata and the agent form) is split into `get` (metadata, `GET …/artifacts/{id}`) and `read` (content, `GET …/content`), because each action is one operation and one route. `share` and `purge` make the tool's `destructiveHint` true.
- **REST.** `DELETE /workspaces/{ws}/artifacts/{id}` moves an artifact to the trash, as `DELETE` of a package does, and `POST …/restore` and `POST …/purge` follow the repository routes. `GET …/artifacts/search` comes before `…/artifacts/{id}` in the table. Templates and spaces are at `/workspaces/{ws}/artifact-templates` and `/workspaces/{ws}/artifact-spaces`. `?state=trashed` on the list is the trash.
- **Input.**
  - `artifact_id` is an id, an address segment (`q4-roadmap-fol_…`) or a whole link.
  - `space` is a slug or an id; a slug is looked up among the spaces in the person's sidebar (`folio_sidebar`), so an open space not yet joined needs its id.
  - An edit is a doc edit unless `kind` says otherwise. `target` may be a string (`append`, `document`) or the object, and defaults to `append`.
  - A share names `username` (looked up in identity and sent as `user:<id>`), `team`, `agent` or a raw `principal`. `role: none` revokes. One call can also change general access, `inherit` and `agent_mode`, sent to the service in that order.
  - Create takes no `share_with`: sharing is the admin scope's, so it is its own call.
- **Output.** The API shapes every answer itself, in snake_case: people are `{ type, id, username | handle | slug, display_name }`; artifacts drop `workspace_id`, `position` and `preview`, and gain `html_url`; content drops `audience_can_read` (always true for a person); the access list's `rows` are `shared_with`, and `public_link` is left out until public links exist.
- **Who.** A workspace's own token is refused (`403`): an artifact always has a person as its owner, and the docs service has no person for a workspace. A g1t agent's run token can call only what its run's scope lists, which names no artifact operation today.
- **Trashed artifacts.** `get` of a trashed artifact answers with `trashed_at` set, to anyone who could open it, as the `folio` read does for the UI's restore banner; its content is refused. That is the service's rule, unchanged here.
- **Checked** under `wrangler dev` with the API, the docs service and stand-in services: 55 checks over REST and MCP with scoped tokens, including that a Private artifact is not found, listed or searched for another member's admin token, that a revoked share closes it again, that a non-member and a workspace token are refused, and that `tools/list` hides write and admin actions from tokens without those scopes.

Deploy order: the docs service is already deployed (Phase 1); the API's `DOCS` binding needs `g1t-docs-service` to exist before `g1t-api` deploys, which `stage: core` before `edge` already gives.

Open:
- **llms.txt.** `apps/web/public/llms.txt` should name the `artifact` tool; it is in `apps/web`, which Phase 2 owns, so it is left for that merge.
- **Unjoined open spaces by slug.** Only sidebar spaces resolve by slug. A `list_spaces`-style RPC that returns every space the person can read would fix it, and the agents service's `list_spaces` tool (Phase 2) needs the same.
