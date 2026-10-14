-- How each merge queue entry lands (queue.rs): the method whoever queued
-- it asked for, else the merge queue rule's, and the commit message they
-- wrote for a merge or a squash. NULL method: queued before methods, when
-- every state was built with merge commits.
ALTER TABLE queue_entries ADD COLUMN merge_method TEXT;
ALTER TABLE queue_entries ADD COLUMN commit_title TEXT;
ALTER TABLE queue_entries ADD COLUMN commit_message TEXT;
