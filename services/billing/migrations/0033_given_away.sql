-- What g1t gave away on purpose: the part of each day's cost that went on
-- usage nobody paid for (g1t's own comped workspaces, a free period, the
-- trial and the open-source pool). Sudo measures margin on what was sold,
-- with this shown beside it, so comping does not read as lost money.
ALTER TABLE margin_days ADD COLUMN given_micros INTEGER NOT NULL DEFAULT 0;
ALTER TABLE workspace_costs ADD COLUMN given_micros INTEGER NOT NULL DEFAULT 0;
