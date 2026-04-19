-- 0009_documents_polymorphic.sql
--
-- Extends `documents` from an org-only attachment table into a
-- polymorphic document store. A document now references exactly one
-- subject (organization / contact / fuel_deal) via (subject_type,
-- subject_id) plus carries enough metadata for the UI to render a
-- list view and enough content for retrieval to surface it to Vex.
--
-- RLS stays enabled; the tenant_id column already gates reads.

ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS subject_type text,
  ADD COLUMN IF NOT EXISTS subject_id   text,
  ADD COLUMN IF NOT EXISTS document_type text NOT NULL DEFAULT 'other',
  ADD COLUMN IF NOT EXISTS filename      text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS size_bytes    integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS uploaded_by   text,
  -- PDFs + text docs get parsed at upload time. Trimmed to the first
  -- ~50KB so the column doesn't blow the row size limit; full bytes
  -- stay in S3 via storage_key.
  ADD COLUMN IF NOT EXISTS extracted_text text;

-- document_type is free-form but the API validates against a fixed
-- set: bl, invoice, contract, bis_license, ofac_screening,
-- financials, packing_list, insurance_cert, customs_entry, sddr,
-- other. Kept as text rather than enum so additions don't need a
-- migration.

CREATE INDEX IF NOT EXISTS documents_subject_idx
  ON documents (tenant_id, subject_type, subject_id);

CREATE INDEX IF NOT EXISTS documents_type_idx
  ON documents (tenant_id, document_type);
