-- @g1t in chat (docs.g1t.sh/guides/ask/): every member's direct message
-- with g1t, where g1t answers with the workspace's own AI provider.
-- `meta` is JSON (src/g1t.ts `MessageMeta`), NULL on every other message:
-- on g1t's answers how the answer went (`answer`: thinking, streaming,
-- done, stopped or error, who wrote it, its steps), on a question asked
-- from the top bar's Ask the page it was asked from (`page`), and on a
-- "New conversation" mark `reset`.
ALTER TABLE messages ADD COLUMN meta TEXT;
