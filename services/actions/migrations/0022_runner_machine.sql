-- Which computer a self-hosted runner registered from, as a hash of the
-- fingerprint it sent: a runner of the same name registered again from the
-- same computer takes the old one's place without --replace. Null for
-- runners that registered before runners said so.
ALTER TABLE runners ADD COLUMN machine_hash TEXT;
