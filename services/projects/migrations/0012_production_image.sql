-- An uploaded image of a project's production (src/production-image.ts):
-- the SHA-256 of its bytes, kept in the avatars namespace under
-- `production/<sha256>` and served from the usercontent origin; the type
-- read from its bytes; and whether it is shown instead of a screenshot.
ALTER TABLE projects ADD COLUMN production_image TEXT;
ALTER TABLE projects ADD COLUMN production_image_type TEXT;
ALTER TABLE projects ADD COLUMN production_image_preferred INTEGER NOT NULL DEFAULT 0;
