-- Issues became work items (g1t #57): the `issues` resource is now `work`,
-- so `issues:read` and `issues:write` are `work:read` and `work:write`.
-- Every stored scope list is rewritten, so tokens, OAuth grants and codes
-- not yet exchanged keep exactly the access they had. A fine-grained
-- token's old named permissions (retired in 0041, read by nothing) follow
-- for tidiness.
UPDATE access_tokens SET scopes = REPLACE(scopes, 'issues:', 'work:') WHERE scopes LIKE '%issues:%';
UPDATE oauth_grants SET scopes = REPLACE(scopes, 'issues:', 'work:') WHERE scopes LIKE '%issues:%';
UPDATE oauth_codes SET scopes = REPLACE(scopes, 'issues:', 'work:') WHERE scopes LIKE '%issues:%';
UPDATE access_tokens SET permissions = REPLACE(permissions, '"issues":', '"work":') WHERE permissions LIKE '%"issues":%';
-- A run's token lists the operations it may use by name: the work item
-- operations took the issue ones' places, and commenting on a work item
-- is its own operation beside commenting on a pull request.
UPDATE access_tokens SET agent_scope =
  REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(agent_scope,
    '"get_issue"', '"get_work_item"'),
    '"list_issues"', '"list_work_items"'),
    '"create_issue"', '"open_work_item"'),
    '"update_issue"', '"update_work_item"'),
    '"close_issue"', '"close_work_item"'),
    '"reopen_issue"', '"reopen_work_item"'),
    '"claim_issue"', '"claim_work_item"'),
    '"hand_off_issue"', '"hand_off_work_item"'),
    '"import_issue"', '"import_work_items"'),
    '"list_issue_labels"', '"list_work_item_labels"'),
    '"add_issue_labels"', '"add_work_item_labels"'),
    '"set_issue_labels"', '"set_work_item_labels"'),
    '"remove_issue_labels"', '"remove_work_item_labels"'),
    '"add_comment"', '"add_comment","add_work_item_comment"')
WHERE agent_scope IS NOT NULL;
