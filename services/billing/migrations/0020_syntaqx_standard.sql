-- The founder's personal workspace becomes an ordinary customer workspace:
-- standard terms, the same limits and card check as anyone, so g1t can be
-- tried as a real customer from it. flagon-io stays comped (0017). Terms
-- can still be changed in sudo.g1t.sh.
UPDATE billing_accounts
SET terms_kind = 'standard', ceiling_micros = NULL, note = 'An ordinary workspace', terms_set_by = 'migration', terms_set_at = '2026-10-06T00:00:00Z'
WHERE id = 'ws_syntaqx' AND terms_kind <> 'standard';
INSERT INTO admin_actions (id, account, action, detail, by, created_at)
VALUES ('adm_migration_syntaqx_standard', 'ws_syntaqx', 'terms', 'comped → standard: an ordinary workspace', 'migration', '2026-10-06T00:00:00Z')
ON CONFLICT (id) DO NOTHING;
