-- The document itself, saved beside its text rendition each time a folio's
-- room saves (src/persist.ts `saveFolio`): the Yjs state the page hands the
-- browser, so a doc opens from it before its room answers, and what an
-- emptied room is refilled with. NULL until the first save after this
-- migration, and for a document too large for a row; either way the page
-- waits for the room, as every page did before.
ALTER TABLE folios ADD COLUMN state BLOB;
