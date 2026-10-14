-- One frozen invoice operation per enterprise. Keep an ambiguous operation
-- until reconciled; Stripe's temporary idempotency cache is not the record.
CREATE TABLE enterprise_invoice_attempts (
  account_id TEXT PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  payload TEXT NOT NULL,
  created_ms INTEGER NOT NULL,
  invoice_id TEXT,
  completed INTEGER NOT NULL DEFAULT 0 CHECK (completed IN (0, 1))
);

-- Keep the owner/slug used in a frozen invoice stable until it is recorded.
-- This is transactional: a concurrent detach or rename cannot slip between
-- an application-level check and the invoice acquisition.
CREATE TRIGGER enterprise_attempt_member_update BEFORE UPDATE ON account_members
WHEN (NEW.workspace <> OLD.workspace OR NEW.account_id <> OLD.account_id)
 AND EXISTS (SELECT 1 FROM enterprise_invoice_attempts a, json_each(a.payload,'$.lines') l
             WHERE a.completed=0 AND json_extract(l.value,'$.workspace')=OLD.workspace)
BEGIN SELECT RAISE(ABORT,'Finish the pending enterprise invoice before moving this workspace'); END;
CREATE TRIGGER enterprise_attempt_member_delete BEFORE DELETE ON account_members
WHEN EXISTS (SELECT 1 FROM enterprise_invoice_attempts a, json_each(a.payload,'$.lines') l
             WHERE a.completed=0 AND json_extract(l.value,'$.workspace')=OLD.workspace)
BEGIN SELECT RAISE(ABORT,'Finish the pending enterprise invoice before moving this workspace'); END;
