INSERT INTO plan_payments (invoice_id, workspace, amount_micros, paid_at)
SELECT ?4, ?2, -(?3 - already), ?5
FROM (SELECT -(COALESCE((SELECT SUM(amount_micros) FROM plan_payments WHERE invoice_id LIKE ?6), 0)
             + COALESCE((SELECT SUM(amount_micros) FROM ledger WHERE reference LIKE ?6), 0)) AS already)
WHERE ?3 > already AND ?1 IS NOT NULL
