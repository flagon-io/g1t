-- Before complimentary enrollment opens in sudo, every workspace except
-- flagon-io is Free: staff then enroll each one deliberately
-- (`admin_set_complimentary`). Read-only inventory on 2026-10-14 found only
-- flagon-io off Free, so on production this changes nothing; it makes the
-- deploy say so rather than trust that nothing changed since.
--
-- What makes a workspace not Free here (`plan_kind_for`): comped or custom
-- terms, the plan given without its price (`team_granted`), membership of
-- an enterprise. Each reset is written to the staff audit log first. A plan
-- paid for at Stripe is not touched: a migration cannot cancel it, and a
-- paying customer is not demoted by a deploy.
INSERT INTO admin_actions (id, account, action, detail, by, created_at)
SELECT 'adm_free_' || id, id, 'terms',
       'Reset to standard terms before complimentary enrollment (migration 0065): was ' || terms_kind ||
       CASE WHEN discount_percent <> 0 THEN ', ' || discount_percent || '% off' ELSE '' END ||
       CASE WHEN team_granted <> 0 THEN ', plan given without its price' ELSE '' END,
       'billing', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM billing_accounts
 WHERE kind = 'workspace' AND id <> 'ws_flagon-io'
   AND (terms_kind <> 'standard' OR discount_percent <> 0 OR team_granted <> 0);

UPDATE billing_accounts
   SET terms_kind = 'standard', discount_percent = 0, terms_until = NULL, team_granted = 0,
       terms_set_by = 'billing', terms_set_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
 WHERE kind = 'workspace' AND id <> 'ws_flagon-io'
   AND (terms_kind <> 'standard' OR discount_percent <> 0 OR team_granted <> 0);

-- A workspace on an enterprise invoice still being made (migration 0063
-- guards it) stays until that invoice is finished; staff detach it then.
-- None existed on 2026-10-14.
INSERT INTO admin_actions (id, account, action, detail, by, created_at)
SELECT 'adm_free_member_' || workspace, account_id, 'detach',
       workspace || ' no longer paid for by ' || account_id || ' (migration 0065)',
       'billing', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM account_members m WHERE workspace <> 'flagon-io'
   AND NOT EXISTS (SELECT 1 FROM enterprise_invoice_attempts a, json_each(a.payload, '$.lines') l
                   WHERE a.completed = 0 AND json_extract(l.value, '$.workspace') = m.workspace);

DELETE FROM account_members WHERE workspace <> 'flagon-io'
   AND NOT EXISTS (SELECT 1 FROM enterprise_invoice_attempts a, json_each(a.payload, '$.lines') l
                   WHERE a.completed = 0 AND json_extract(l.value, '$.workspace') = account_members.workspace);
