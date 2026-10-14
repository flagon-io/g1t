-- Splits a usage entry just inserted (?1) between what pays for it, in one
-- statement of the batch that inserted it, so allowances and the entry
-- commit together. ?2 workspace, ?3 month (YYYY-MM) of the usage, ?4 the
-- plan's included usage, ?5 trial eligible, ?6 public repository, ?7 the
-- open-source pool, ?8 the repository's share of it, ?9 g1t covers the rest.
--
-- A complimentary period covering the entry's own time (not the time it is
-- posted) pays first and alone: late usage lands in the period it happened
-- in. Past the allowance, a `stop` period's overrun is g1t's (`given`) and
-- never charged; a `charge` period's is charged like any usage, but only
-- with a card on file to charge: without one it is g1t's too, so work that
-- was running, or a month-end meter, never leaves a debt nothing can pay.
WITH entry AS (
  SELECT MAX(0, -amount_micros) AS gross, created_at FROM ledger WHERE id=?1
), period AS (
  SELECT p.allowance_micros, p.unlimited, p.overage FROM complimentary_periods p, entry
   WHERE p.workspace=?2 AND p.starts_at <= entry.created_at AND (p.ends_at IS NULL OR p.ends_at > entry.created_at)
   ORDER BY p.starts_at DESC LIMIT 1
), room AS (
  SELECT gross,
    EXISTS (SELECT 1 FROM period) AS comp,
    EXISTS (SELECT 1 FROM period WHERE overage = 'stop' OR NOT (
      EXISTS (SELECT 1 FROM card_checks WHERE workspace = ?2)
      OR EXISTS (SELECT 1 FROM accounts WHERE workspace = ?2 AND customer_id IS NOT NULL AND card_last4 IS NOT NULL))) AS comp_stops,
    CASE WHEN EXISTS (SELECT 1 FROM period) THEN 0
         ELSE MAX(0, ?4 - COALESCE((SELECT used FROM allowance_use WHERE kind='plan_credit' AND scope=?2 AND month=?3), 0)) END AS plan_left,
    CASE WHEN NOT EXISTS (SELECT 1 FROM period) THEN 0
         WHEN (SELECT unlimited FROM period) THEN gross
         ELSE MAX(0, (SELECT allowance_micros FROM period)
                     - COALESCE((SELECT used FROM allowance_use WHERE kind='complimentary' AND scope=?2 AND month=?3), 0)) END AS gift_left,
    CASE WHEN ?5 AND NOT EXISTS (SELECT 1 FROM period)
         THEN COALESCE((SELECT MAX(0, granted_micros-used_micros) FROM trial_grants WHERE workspace=?2), 0) ELSE 0 END AS trial_left,
    CASE WHEN EXISTS (SELECT 1 FROM period) THEN 0 ELSE
    MIN(MAX(0, ?7 - COALESCE((SELECT used FROM allowance_use WHERE kind='oss_pool' AND scope='' AND month=?3), 0)),
        MAX(0, ?8 - COALESCE((SELECT used FROM allowance_use WHERE kind='oss_repo' AND scope=?6 AND month=?3), 0))) END AS oss_left
  FROM entry
), plan AS (
  SELECT *, MIN(gross, plan_left) AS credit FROM room
), gift AS (
  SELECT *, MIN(gross-credit, gift_left) AS gift FROM plan
), trial AS (
  SELECT *, MIN(gross-credit-gift, trial_left) AS trial FROM gift
), oss AS (
  SELECT *, MIN(gross-credit-gift-trial, oss_left) AS oss FROM trial
), allocated AS (
  SELECT *, CASE WHEN comp_stops OR (?9 AND NOT comp) THEN gross-credit-gift-trial-oss ELSE 0 END AS given FROM oss
)
UPDATE ledger SET (amount_micros, credit_micros, gift_micros, trial_micros, oss_micros, given_micros) =
  (SELECT -(gross-credit-gift-trial-oss-given), credit, gift, trial, oss, given FROM allocated)
WHERE id=?1
