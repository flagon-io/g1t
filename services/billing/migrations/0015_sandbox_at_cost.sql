-- Sandbox time is charged at cost plus 20% from the first second, like
-- everything else in the price book. There are no free minutes, so the
-- monthly count that measured them goes.

-- A change can be to the markup rather than to the cost: what it was.
ALTER TABLE price_changes ADD COLUMN old_markup_percent INTEGER;

INSERT INTO price_changes (id, meter, old_cost_micros, new_cost_micros, markup_percent, old_markup_percent, reason, created_at)
SELECT 'prc_sandbox_at_cost', meter, cost_micros, cost_micros, 20, markup_percent,
       'Sandbox time is now charged at cost plus 20% from the first second',
       strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
FROM prices WHERE meter = 'sandbox_second' AND markup_percent <> 20;

UPDATE prices SET markup_percent = 20, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
WHERE meter = 'sandbox_second';

DROP TABLE IF EXISTS sandbox_months;
