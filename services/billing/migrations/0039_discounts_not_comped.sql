-- "Comped" becomes what it always was: a 100% discount on custom terms,
-- with its note as the reason and its ceiling as the monthly budget at
-- cost. Code reads a leftover `comped` row as 100% too.
UPDATE billing_accounts SET terms_kind = 'custom', discount_percent = 100 WHERE terms_kind = 'comped';

-- What a 100%-discounted workspace's usage was worth, on the entries from
-- before discounts recorded it: charged nothing and paid by nothing, at
-- cost plus the margin (MARGIN_PERCENT, 20), rounded up as `margin_on`
-- does. So its statement shows every line at its price and the discount
-- beside it. The reconciliation counts these workspaces' usage as given
-- from their cost, not from this column, so margins do not move.
UPDATE ledger SET discount_micros = (cost_micros * 120 + 99) / 100
 WHERE kind = 'usage' AND COALESCE(billed_to, 'g1t') = 'g1t' AND amount_micros = 0 AND COALESCE(cost_micros, 0) > 0
   AND discount_micros = 0 AND credit_micros = 0 AND trial_micros = 0 AND oss_micros = 0 AND given_micros = 0
   AND workspace IN (
     SELECT substr(id, 4) FROM billing_accounts WHERE kind = 'workspace' AND terms_kind = 'custom' AND discount_percent >= 100
     UNION SELECT m.workspace FROM account_members m JOIN billing_accounts b ON b.id = m.account_id
       WHERE b.terms_kind = 'custom' AND b.discount_percent >= 100
   );
