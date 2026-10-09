-- A person's access token may be let use the website (g1t.sh) as them,
-- sent as `Authorization: Bearer`, so automation driving a browser can
-- work there without signing in. Off unless its owner turns it on when
-- making or changing the token. It is not a scope: full access and every
-- existing token stay off. See src/tokens.rs and apps/web's
-- app/lib/website-token.ts.
ALTER TABLE access_tokens ADD COLUMN website INTEGER NOT NULL DEFAULT 0;
