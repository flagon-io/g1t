-- The time zone a person is in, as an IANA name such as America/Denver,
-- so the card over their name can show their local time. Optional and
-- public like the rest of a profile; null means not given.
ALTER TABLE users ADD COLUMN timezone TEXT;
