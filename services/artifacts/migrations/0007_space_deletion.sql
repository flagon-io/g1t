-- A space can be deleted, the General space too (a workspace may have no
-- spaces). Its row stays, marked: the trash's rows that point at it keep
-- their space's name and rules, so whoever could edit them still restores
-- them for the usual 30 days; and General, once deleted, is never made
-- again (`ensureDefault` finds the row). Deleting frees the address for a
-- new space by renaming the row's slug to `<slug>~<id>`, which no address
-- can be. Listings leave deleted spaces out (src/who.ts, src/index.ts).
ALTER TABLE spaces ADD COLUMN deleted_at TEXT;
ALTER TABLE spaces ADD COLUMN deleted_by TEXT;
