-- Flagon, Inc. builds and runs g1t; its workspace runs comped, as
-- g1t's own workspace does. The founder's personal workspace stays comped
-- too (see 0008); either can be changed in sudo.g1t.sh.
INSERT INTO billing_accounts (id, kind, name, terms_kind, note, terms_set_by, terms_set_at, created_by, created_at)
VALUES ('ws_flagon-io', 'workspace', 'flagon-io', 'comped', 'Flagon, Inc., which builds g1t', 'migration', '2026-10-05T00:00:00Z', 'migration', '2026-10-05T00:00:00Z')
ON CONFLICT (id) DO UPDATE SET terms_kind = 'comped', note = excluded.note, terms_set_by = 'migration', terms_set_at = excluded.terms_set_at;
INSERT INTO admin_actions (id, account, action, detail, by, created_at)
VALUES ('adm_migration_flagon_io', 'ws_flagon-io', 'terms', 'standard → comped: Flagon, Inc., which builds g1t', 'migration', '2026-10-05T00:00:00Z')
ON CONFLICT (id) DO NOTHING;
