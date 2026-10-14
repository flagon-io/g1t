-- The most branches and tags one push may change (lib.rs `update`,
-- git_http.rs `ref_update_refusal`): a push that would change more is
-- refused whole. Null, the default, for no limit.
ALTER TABLE repos ADD COLUMN max_ref_updates INTEGER;
