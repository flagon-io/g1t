-- Memory that fills itself: what agents report learning at the end of a
-- run, corrections people make in review, decisions summed up on merge and
-- what a project's own docs say arrive as candidates. A candidate is given
-- to no agent until it is kept: by a person in the Review queue, or by g1t
-- when two independent sources say the same thing, or a doc says it with
-- high confidence. Everything kept before this change stays kept.

-- candidate, kept or dismissed.
ALTER TABLE memories ADD COLUMN status TEXT NOT NULL DEFAULT 'kept';
-- 0 to 1: how sure the source was. Null for what people wrote.
ALTER TABLE memories ADD COLUMN confidence REAL;
-- What it came from, beside source_kind (person, agent, run, review, pr,
-- doc): "run:<id>", "comment:<id>", "pull:<repo id>#<n>", "doc:<path>".
ALTER TABLE memories ADD COLUMN source_ref TEXT;
-- What it was learned from, quoted: a line of a doc, a review comment.
ALTER TABLE memories ADD COLUMN evidence TEXT;
-- The text folded to compare candidates: lowercase words only.
ALTER TABLE memories ADD COLUMN fingerprint TEXT;
-- JSON array of the distinct source_refs that said it.
ALTER TABLE memories ADD COLUMN sources TEXT NOT NULL DEFAULT '[]';
-- Who kept or dismissed it, and when.
ALTER TABLE memories ADD COLUMN reviewed_by TEXT;
ALTER TABLE memories ADD COLUMN reviewed_at TEXT;

CREATE INDEX memories_by_status ON memories (workspace, status, updated_at);
CREATE INDEX memories_by_fingerprint ON memories (scope, scope_key, fingerprint);
