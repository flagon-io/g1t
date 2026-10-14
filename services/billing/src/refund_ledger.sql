INSERT INTO ledger (id, workspace, kind, amount_micros, description, reference, created_at, billed_to)
SELECT ?1, ?2, 'top_up', -(?3 - already), 'Refunded to the card', ?4, ?5, 'g1t'
FROM (SELECT -(COALESCE((SELECT SUM(amount_micros) FROM plan_payments WHERE invoice_id LIKE ?6), 0)
             + COALESCE((SELECT SUM(amount_micros) FROM ledger WHERE reference LIKE ?6), 0)) AS already)
WHERE ?3 > already
