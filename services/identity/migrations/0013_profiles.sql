-- What a person says about themselves on their profile at g1t.sh/u/<name>.
-- Every field is optional and public; null means not given. The website is
-- always an https:// address, checked by the service.
ALTER TABLE users ADD COLUMN display_name TEXT;
ALTER TABLE users ADD COLUMN bio TEXT;
ALTER TABLE users ADD COLUMN location TEXT;
ALTER TABLE users ADD COLUMN website TEXT;
ALTER TABLE users ADD COLUMN pronouns TEXT;
