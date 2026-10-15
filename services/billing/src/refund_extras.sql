INSERT INTO tax_and_fees (id, workspace, kind, amount_micros, reference, payment_intent, created_at)
SELECT ?1, ?2, ?3, -(?4 - already), ?5, ?6, ?7
FROM (SELECT -COALESCE(SUM(amount_micros), 0) AS already FROM tax_and_fees WHERE reference LIKE ?8 AND kind = ?3)
WHERE ?4 > already
