-- Whether a repository's workflows run at all (Settings, Actions): 1 on,
-- 0 off, null not chosen. Unchosen, a repository's Actions are on, and a
-- fork's (a repository with a parent) are off until someone with the
-- right to change its settings turns them on, so forking never starts the
-- parent's workflows in the fork. While off, no run starts from any
-- event, schedule or dispatch. See src/protection.rs.
ALTER TABLE repo_settings ADD COLUMN enabled INTEGER;
