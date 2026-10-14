CREATE TABLE erased_subjects (id TEXT PRIMARY KEY, kind TEXT NOT NULL);
CREATE TABLE purge_documents (subject_id TEXT NOT NULL, kind TEXT NOT NULL, document_id TEXT NOT NULL, PRIMARY KEY(subject_id, kind, document_id));

CREATE TABLE erased_documents (id TEXT PRIMARY KEY, kind TEXT NOT NULL);
CREATE TRIGGER erased_spaces BEFORE INSERT ON spaces WHEN EXISTS (
  SELECT 1 FROM erased_subjects WHERE kind = 'workspace' AND id = NEW.workspace_id
) BEGIN SELECT RAISE(IGNORE); END;
CREATE TRIGGER erased_pages BEFORE INSERT ON pages WHEN EXISTS (
  SELECT 1 FROM erased_subjects WHERE kind = 'workspace' AND id = NEW.workspace_id
) BEGIN SELECT RAISE(IGNORE); END;
CREATE TRIGGER erased_folios BEFORE INSERT ON folios WHEN EXISTS (
  SELECT 1 FROM erased_subjects WHERE kind = 'workspace' AND id = NEW.workspace_id
) BEGIN SELECT RAISE(IGNORE); END;
CREATE TRIGGER erased_files BEFORE INSERT ON files WHEN EXISTS (
  SELECT 1 FROM erased_subjects WHERE kind = 'workspace' AND id = NEW.workspace_id
) BEGIN SELECT RAISE(IGNORE); END;
CREATE TRIGGER erased_folio_files BEFORE INSERT ON folio_files WHEN EXISTS (
  SELECT 1 FROM erased_subjects WHERE kind = 'workspace' AND id = NEW.workspace_id
) BEGIN SELECT RAISE(IGNORE); END;
CREATE TRIGGER erased_templates BEFORE INSERT ON templates WHEN EXISTS (
  SELECT 1 FROM erased_subjects WHERE kind = 'workspace' AND id = NEW.workspace_id
) BEGIN SELECT RAISE(IGNORE); END;
CREATE TRIGGER erased_folio_templates BEFORE INSERT ON folio_templates WHEN EXISTS (
  SELECT 1 FROM erased_subjects WHERE kind = 'workspace' AND id = NEW.workspace_id
) BEGIN SELECT RAISE(IGNORE); END;
CREATE TRIGGER erased_doc_chunks BEFORE INSERT ON doc_chunks WHEN EXISTS (
  SELECT 1 FROM erased_subjects WHERE kind = 'workspace' AND id = NEW.workspace_id
) BEGIN SELECT RAISE(IGNORE); END;
CREATE TRIGGER erased_folio_chunks BEFORE INSERT ON folio_chunks WHEN EXISTS (
  SELECT 1 FROM erased_subjects WHERE kind = 'workspace' AND id = NEW.workspace_id
) BEGIN SELECT RAISE(IGNORE); END;
CREATE TRIGGER erased_repo_spaces BEFORE INSERT ON repo_spaces WHEN EXISTS (
  SELECT 1 FROM erased_subjects WHERE kind = 'workspace' AND id = NEW.workspace_id
) BEGIN SELECT RAISE(IGNORE); END;
CREATE TRIGGER erased_doc_embed_usage BEFORE INSERT ON doc_embed_usage WHEN EXISTS (
  SELECT 1 FROM erased_subjects WHERE kind = 'workspace' AND id = NEW.workspace_id
) BEGIN SELECT RAISE(IGNORE); END;
CREATE TRIGGER erased_doc_index_runs BEFORE INSERT ON doc_index_runs WHEN EXISTS (
  SELECT 1 FROM erased_subjects WHERE kind = 'workspace' AND id = NEW.workspace_id
) BEGIN SELECT RAISE(IGNORE); END;
CREATE TRIGGER erased_workspace_billing BEFORE INSERT ON workspace_billing WHEN EXISTS (
  SELECT 1 FROM erased_subjects WHERE kind = 'workspace' AND id = NEW.workspace_id
) BEGIN SELECT RAISE(IGNORE); END;
CREATE TRIGGER erased_document_files BEFORE INSERT ON files WHEN EXISTS (
  SELECT 1 FROM erased_documents WHERE id = NEW.page_id AND kind = 'page'
) BEGIN SELECT RAISE(IGNORE); END;
CREATE TRIGGER erased_document_folio_files BEFORE INSERT ON folio_files WHEN EXISTS (
  SELECT 1 FROM erased_documents WHERE id = NEW.folio_id AND kind = 'folio'
) BEGIN SELECT RAISE(IGNORE); END;
CREATE TRIGGER erased_document_doc_chunks BEFORE INSERT ON doc_chunks WHEN EXISTS (
  SELECT 1 FROM erased_documents WHERE id = NEW.page_id AND kind = 'page'
) BEGIN SELECT RAISE(IGNORE); END;
CREATE TRIGGER erased_document_folio_chunks BEFORE INSERT ON folio_chunks WHEN EXISTS (
  SELECT 1 FROM erased_documents WHERE id = NEW.folio_id AND kind = 'folio'
) BEGIN SELECT RAISE(IGNORE); END;

CREATE TABLE purge_access (subject_id TEXT NOT NULL, kind TEXT NOT NULL, document_id TEXT NOT NULL, done INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(subject_id, kind, document_id));
CREATE TRIGGER erased_author_spaces BEFORE INSERT ON spaces WHEN EXISTS (
  SELECT 1 FROM erased_subjects WHERE kind = 'user' AND 'user:' || id = NEW.created_by
) BEGIN SELECT RAISE(IGNORE); END;
CREATE TRIGGER erased_author_pages BEFORE INSERT ON pages WHEN EXISTS (
  SELECT 1 FROM erased_subjects WHERE kind = 'user' AND 'user:' || id = NEW.created_by
) BEGIN SELECT RAISE(IGNORE); END;
CREATE TRIGGER erased_author_folios BEFORE INSERT ON folios WHEN EXISTS (
  SELECT 1 FROM erased_subjects WHERE kind = 'user' AND 'user:' || id = NEW.created_by
) BEGIN SELECT RAISE(IGNORE); END;
CREATE TRIGGER erased_author_files BEFORE INSERT ON files WHEN EXISTS (
  SELECT 1 FROM erased_subjects WHERE kind = 'user' AND 'user:' || id = NEW.created_by
) BEGIN SELECT RAISE(IGNORE); END;
CREATE TRIGGER erased_author_folio_files BEFORE INSERT ON folio_files WHEN EXISTS (
  SELECT 1 FROM erased_subjects WHERE kind = 'user' AND 'user:' || id = NEW.created_by
) BEGIN SELECT RAISE(IGNORE); END;
CREATE TRIGGER erased_author_templates BEFORE INSERT ON templates WHEN EXISTS (
  SELECT 1 FROM erased_subjects WHERE kind = 'user' AND 'user:' || id = NEW.created_by
) BEGIN SELECT RAISE(IGNORE); END;
CREATE TRIGGER erased_author_folio_templates BEFORE INSERT ON folio_templates WHEN EXISTS (
  SELECT 1 FROM erased_subjects WHERE kind = 'user' AND 'user:' || id = NEW.created_by
) BEGIN SELECT RAISE(IGNORE); END;
