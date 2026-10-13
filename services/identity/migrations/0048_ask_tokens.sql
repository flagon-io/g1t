-- What a token g1t makes for itself is for. 'ask': the short-lived, read-only
-- credential Ask g1t reads g1t with while it answers one person's question
-- (src/ask_tokens.rs). Null for every token a person, workspace, job or run
-- holds. A workspace's rules for personal access tokens skip Ask's: nobody
-- ever holds one, and it ends with the answer.
ALTER TABLE access_tokens ADD COLUMN purpose TEXT;
