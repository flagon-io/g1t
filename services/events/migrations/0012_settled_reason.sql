-- Why an item settled by itself (src/inbox.rs, "Settling"), for the Done
-- view and Home's "While you were away": a few words on what ended it,
-- such as "CI passed in run 330" or "Merged", and who did, when a person
-- or g1t did (a username, or g1t). Both are cleared when new activity
-- brings the thread back, and stay empty for an item marked done by hand.
ALTER TABLE inbox_items ADD COLUMN settled_reason TEXT;
ALTER TABLE inbox_items ADD COLUMN settled_by TEXT;
