-- A work item's parent: the work item of the same workspace it is a
-- sub-item of, by id; NULL for none. One parent, any number of sub-items,
-- never a cycle (items/sub_items.rs). Separate from blocked_by: a parent
-- is not blocked by its sub-items.
ALTER TABLE work_items ADD COLUMN parent_id TEXT;
CREATE INDEX work_items_by_parent ON work_items (parent_id) WHERE parent_id IS NOT NULL;
