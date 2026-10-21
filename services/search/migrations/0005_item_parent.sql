-- Work items can be sub-items of another work item of their workspace
-- (the work service's sub-items). A work item keeps its parent's number
-- there, so `parent:212` finds #212's sub-items. Rows indexed before this
-- have none until their work item is indexed again.
ALTER TABLE items ADD COLUMN parent INTEGER;

CREATE INDEX items_by_parent ON items (parent);
