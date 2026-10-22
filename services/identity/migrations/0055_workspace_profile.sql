-- What a workspace says about itself on its profile, besides its name,
-- description and avatar. The website and each social account are https://
-- addresses, and the emails look like addresses, checked by the service.
-- Null means not given.
--
-- `email` is public: where to reach the workspace. `social_accounts` is a
-- JSON array of at most four addresses. `billing_email` is private: where
-- billing sends receipts and invoices, read only by owners and billing
-- managers; with none, billing uses an owner's address.
ALTER TABLE workspaces ADD COLUMN website TEXT;
ALTER TABLE workspaces ADD COLUMN email TEXT;
ALTER TABLE workspaces ADD COLUMN location TEXT;
ALTER TABLE workspaces ADD COLUMN social_accounts TEXT;
ALTER TABLE workspaces ADD COLUMN billing_email TEXT;
