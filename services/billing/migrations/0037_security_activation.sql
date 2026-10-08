-- The Security and quality activation: $10 a month per workspace turns on
-- the security suite's paid features for its private repositories (custom
-- patterns, validity checks, delegated bypass, code scanning, dependency
-- review and the security overview). Public repositories have them free,
-- and secret scanning, push protection, vulnerability alerts and security
-- updates are free everywhere. Agent fixes are charged as agent usage.
--
-- Its monthly price lives in the price book like every other price, so the
-- pricing page, the Billing page and the subscription all read it from
-- here, and a change to it is versioned and published like any other. It is
-- a flat price, not a cost passed through, so it carries no markup.
INSERT OR IGNORE INTO prices (meter, title, unit, cost_micros, markup_percent, source, updated_at)
VALUES ('security_activation', 'Security and quality activation', 'workspace-month', 10000000, 0, 'list', '2026-10-07T00:00:00Z');

INSERT OR IGNORE INTO price_changes (id, meter, old_cost_micros, new_cost_micros, markup_percent, reason, created_at)
VALUES ('prc_security_activation', 'security_activation', 10000000, 10000000, 0,
        'New: the Security and quality activation, $10 a month per workspace', '2026-10-07T00:00:00Z');

INSERT OR IGNORE INTO price_versions (id, meter, version, cost_micros, markup_percent, effective_at, reason, created_by, created_at, applied_at)
VALUES ('pv_security_activation_1', 'security_activation', 1, 10000000, 0, '2026-10-07T00:00:00Z',
        'The Security and quality activation', 'migration', '2026-10-07T00:00:00Z', '2026-10-07T00:00:00Z');
