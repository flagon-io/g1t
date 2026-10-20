-- Page speed is judged by the site's own time, not the time from the cron.
--
-- Since 17 Oct Cloudflare runs the status cron from a different data centre
-- through the day, and every check from it carries about 200 ms more on
-- the way: the API's refused token went from 12 ms to about 200 from the
-- same data centre. Page speed now judges the time the site says it took
-- (its Server-Timing total; probe.ts `serverOf`) and keeps both: `ms` is
-- still the time from where the check ran, `server_ms` the site's own.
-- Empty for every other part, and for checks kept before this.

ALTER TABLE check_history ADD COLUMN server_ms INTEGER;
