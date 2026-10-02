-- What the branch pointed to before a shipped attempt landed.
ALTER TABLE attempts ADD COLUMN landed_base TEXT;
