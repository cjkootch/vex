"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { formatDistanceToNow } from "date-fns";

export interface DocumentRow {
  id: string;
  title: string;
  filename: string;
  mimeType: string;
  documentType: string;
  sizeBytes: number;
  hasExtractedText: boolean;
  extractedPreview: string | null;
  uploadedBy: string | null;
  createdAt: string;
}

interface Props {
  subjectType: "organization" | "contact" | "fuel_deal";
  subjectId: string;
}

const DOCUMENT_TYPES: Array<{ value: string; label: string }> = [
  { value: "bl", label: "BL" },
  { value: "invoice", label: "Invoice" },
  { value: "contract", label: "Contract" },
  { value: "bis_license", label: "BIS licence" },
  { value: "ofac_screening", label: "OFAC screening" },
  { value: "financials", label: "Financials" },
  { value: "packing_list", label: "Packing list" },
  { value: "insurance_cert", label: "Insurance cert" },
  { value: "customs_entry", label: "Customs entry" },
  { value: "sddr", label: "SDDR" },
  { value: "other", label: "Other" },
];

export function DocumentsPanel({
  subjectType,
  subjectId,
}: Props): React.ReactElement {
  const [docs, setDocs] = useState<DocumentRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [documentType, setDocumentType] = useState<string>("other");
  const fileInput = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch(
        `/api/documents?subject_type=${encodeURIComponent(subjectType)}&subject_id=${encodeURIComponent(subjectId)}`,
      );
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      const body = (await res.json()) as { documents: DocumentRow[] };
      setDocs(body.documents);
    } catch (err) {
      setError((err as Error).message);
      setDocs([]);
    }
  }, [subjectType, subjectId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleUpload(file: File): Promise<void> {
    setUploading(true);
    setError(null);
    try {
      const form = new FormData();
      form.append("subject_type", subjectType);
      form.append("subject_id", subjectId);
      form.append("document_type", documentType);
      form.append("title", file.name);
      form.append("file", file);
      const res = await fetch("/api/documents", {
        method: "POST",
        body: form,
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          message?: string;
        };
        throw new Error(body.message ?? `${res.status} ${res.statusText}`);
      }
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  }

  async function handleDelete(id: string): Promise<void> {
    if (!window.confirm("Delete this document?")) return;
    try {
      const res = await fetch(`/api/documents/${id}`, { method: "DELETE" });
      if (!res.ok && res.status !== 204) {
        throw new Error(`${res.status} ${res.statusText}`);
      }
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-end gap-2 rounded-lg border border-line bg-muted/20 p-3">
        <label className="flex min-w-[140px] flex-col gap-1">
          <span className="text-[11px] uppercase tracking-wide text-white/50">
            Document type
          </span>
          <select
            value={documentType}
            onChange={(e) => setDocumentType(e.target.value)}
            className="rounded-md border border-line bg-canvas px-2 py-1.5 text-sm text-white focus:border-accent focus:outline-none"
          >
            {DOCUMENT_TYPES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-1 flex-col gap-1">
          <span className="text-[11px] uppercase tracking-wide text-white/50">
            File (PDF or text, ≤50MB)
          </span>
          <input
            ref={fileInput}
            type="file"
            disabled={uploading}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void handleUpload(file);
            }}
            className="rounded-md border border-line bg-canvas px-2 py-1.5 text-sm text-white file:mr-3 file:rounded file:border-0 file:bg-accent/20 file:px-2 file:py-1 file:text-xs file:text-accent"
          />
        </label>
        {uploading && <span className="pb-1 text-xs text-white/60">Uploading…</span>}
      </div>

      {error && (
        <div className="rounded-md border border-bad/40 bg-bad/10 px-3 py-2 text-xs text-bad">
          {error}
        </div>
      )}

      {docs === null ? (
        <div className="rounded-md border border-line bg-muted/20 px-3 py-3 text-sm text-white/50">
          Loading…
        </div>
      ) : docs.length === 0 ? (
        <div className="rounded-md border border-line bg-muted/20 px-3 py-4 text-sm text-white/50">
          No documents attached yet. Upload a PDF above — Vex can read its
          contents and reference it in chat and call prompts.
        </div>
      ) : (
        <ol className="flex flex-col gap-2">
          {docs.map((d) => (
            <li
              key={d.id}
              className="flex items-start justify-between gap-3 rounded-lg border border-line bg-muted/20 px-3 py-2.5"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="rounded bg-accent/20 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-accent">
                    {docTypeLabel(d.documentType)}
                  </span>
                  <a
                    href={`/api/documents/${d.id}/download`}
                    target="_blank"
                    rel="noreferrer"
                    className="truncate text-sm text-white hover:text-accent"
                  >
                    {d.title}
                  </a>
                </div>
                <div className="mt-0.5 text-[11px] text-white/40">
                  {d.filename} · {formatSize(d.sizeBytes)}
                  {d.hasExtractedText && (
                    <span className="ml-2 text-good">· text-extracted</span>
                  )}
                  <span className="ml-2">
                    {formatDistanceToNow(new Date(d.createdAt), {
                      addSuffix: true,
                    })}
                  </span>
                </div>
                {d.extractedPreview && (
                  <div className="mt-1 text-[11px] text-white/55 line-clamp-2">
                    {d.extractedPreview.slice(0, 200)}
                    {d.extractedPreview.length > 200 ? "…" : ""}
                  </div>
                )}
              </div>
              <button
                type="button"
                onClick={() => void handleDelete(d.id)}
                className="shrink-0 text-xs text-white/40 hover:text-bad"
                aria-label="Delete document"
              >
                Delete
              </button>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function docTypeLabel(raw: string): string {
  return (
    DOCUMENT_TYPES.find((t) => t.value === raw)?.label ?? raw.replace(/_/g, " ")
  );
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
