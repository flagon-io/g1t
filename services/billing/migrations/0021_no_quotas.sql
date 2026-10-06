-- No per-feature quotas on the plan. A workspace on the plan pays for what
-- it uses, from the first unit, at cost plus the margin, drawn from its
-- included usage first; nothing but its spend limit stops it. The forge
-- is free for everyone up to the same amounts (1 GB of private storage,
-- 50,000 git operations a month); past them, the plan pays and a free
-- workspace is held to them. Projects, previews and the apps behind them
-- are not metered at all. See src/features.rs and src/storage.rs.

-- How much of a pending source there was, for the Billing page's
-- "This month's usage": `1.2 million requests and 3.4 million CPU ms`.
ALTER TABLE pending_usage ADD COLUMN detail TEXT;

-- Apps are not metered: Workers for Platforms includes far more scripts
-- than g1t runs, so an app costs g1t only its requests and CPU.
DELETE FROM prices WHERE meter = 'app_month';

-- Meters whose titles said "past the plan": every unit is metered now.
UPDATE prices SET title = 'Custom domains' WHERE meter = 'custom_domain_month';
UPDATE prices SET title = 'Private repository storage past the free 1 GB' WHERE meter = 'private_storage';
UPDATE prices SET title = 'Git operations past the free 50,000 a month' WHERE meter = 'git_operations';

-- allowance_use rows of kind build_seconds stay: they are now a plain
-- count of the month's build seconds, all of them charged.
