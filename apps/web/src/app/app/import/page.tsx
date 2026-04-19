"use client";

import { useEffect, useMemo, useState } from "react";
import { parseCsv } from "@/lib/csv";

/**
 * /app/import — CSV bulk import for companies and contacts.
 *
 * Flow:
 *   1. Pick entity tab (companies | contacts)
 *   2. If contacts, pick a target org (from the org list)
 *   3. Upload a CSV file — parsed client-side
 *   4. Map each source column to a target field
 *   5. Preview the first 5 rows
 *   6. Import — POSTs to /api/.../bulk, displays per-row outcomes
 */

type Entity = "companies" | "contacts";

interface OrgOption {
  id: string;
  legalName: string;
}

const COMPANY_FIELDS = [
  { value: "", label: "(skip)" },
  { value: "legalName", label: "Legal name *" },
  { value: "domain", label: "Domain" },
  { value: "industry", label: "Industry" },
];

const CONTACT_FIELDS = [
  { value: "", label: "(skip)" },
  { value: "fullName", label: "Full name *" },
  { value: "title", label: "Title" },
  { value: "emails", label: "Email" },
  { value: "phones", label: "Phone" },
];

interface ImportResult {
  imported: number;
  duplicates: number;
  failed: number;
  rows: Array<{
    index: number;
    status: "created" | "duplicate" | "failed";
    id?: string;
    error?: string;
  }>;
}

export default function ImportPage(): React.ReactElement {
  const [entity, setEntity] = useState<Entity>("companies");
  const [targetOrgId, setTargetOrgId] = useState<string>("");
  const [orgOptions, setOrgOptions] = useState<OrgOption[]>([]);
  const [headers, setHeaders] = useState<string[]>([]);
  const [rows, setRows] = useState<string[][]>([]);
  const [mapping, setMapping] = useState<Record<number, string>>({});
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (entity !== "contacts") return;
    void fetch("/api/organizations")
      .then((r) => r.json())
      .then((body: { organizations: OrgOption[] }) => {
        setOrgOptions(body.organizations ?? []);
      })
      .catch(() => setOrgOptions([]));
  }, [entity]);

  const targetFields = entity === "companies" ? COMPANY_FIELDS : CONTACT_FIELDS;

  const handleFile = (file: File): void => {
    setError(null);
    setResult(null);
    const reader = new FileReader();
    reader.onload = () => {
      const text = String(reader.result ?? "");
      const { headers: hs, rows: rs } = parseCsv(text);
      setHeaders(hs);
      setRows(rs);
      // Auto-map columns whose header names match a target field.
      const next: Record<number, string> = {};
      hs.forEach((h, i) => {
        const normal = h.toLowerCase().replace(/[^a-z0-9]/g, "");
        const hit = targetFields.find((f) => {
          const t = f.value.toLowerCase().replace(/[^a-z0-9]/g, "");
          return t.length > 0 && (t === normal || t.startsWith(normal));
        });
        if (hit) next[i] = hit.value;
      });
      setMapping(next);
    };
    reader.readAsText(file);
  };

  const mappedRows = useMemo(() => {
    return rows.map((row) => {
      const obj: Record<string, string> = {};
      for (let i = 0; i < row.length; i += 1) {
        const field = mapping[i];
        if (field) obj[field] = row[i] ?? "";
      }
      return obj;
    });
  }, [rows, mapping]);

  const readyToImport =
    mappedRows.length > 0 &&
    (entity === "companies"
      ? mappedRows.every((r) => (r["legalName"] ?? "").length > 0)
      : Boolean(targetOrgId) &&
        mappedRows.every((r) => (r["fullName"] ?? "").length > 0));

  async function runImport(): Promise<void> {
    setImporting(true);
    setError(null);
    setResult(null);
    try {
      const endpoint =
        entity === "companies"
          ? "/api/organizations/bulk"
          : "/api/contacts/bulk";
      const body =
        entity === "companies"
          ? { rows: mappedRows.map((r) => cleanCompanyRow(r)) }
          : {
              orgId: targetOrgId,
              rows: mappedRows.map((r) => cleanContactRow(r)),
            };
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const msg = (await res.json().catch(() => ({}))) as { message?: string };
        throw new Error(msg.message ?? `${res.status} ${res.statusText}`);
      }
      const data = (await res.json()) as ImportResult;
      setResult(data);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setImporting(false);
    }
  }

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-4 px-6 py-6">
      <header>
        <h1 className="text-xl font-semibold text-white">Import CSV</h1>
        <p className="mt-1 text-xs text-white/50">
          Bulk-import companies or contacts from a CSV file. Rows matching
          existing records collapse onto them instead of creating duplicates.
        </p>
      </header>

      <div className="flex gap-2 rounded-lg border border-line bg-muted/20 p-2">
        <button
          type="button"
          onClick={() => {
            setEntity("companies");
            setHeaders([]);
            setRows([]);
            setResult(null);
          }}
          className={`flex-1 rounded-md px-3 py-2 text-sm font-medium ${
            entity === "companies"
              ? "bg-accent text-canvas"
              : "bg-muted/60 text-white/70 hover:bg-muted/80"
          }`}
        >
          Companies
        </button>
        <button
          type="button"
          onClick={() => {
            setEntity("contacts");
            setHeaders([]);
            setRows([]);
            setResult(null);
          }}
          className={`flex-1 rounded-md px-3 py-2 text-sm font-medium ${
            entity === "contacts"
              ? "bg-accent text-canvas"
              : "bg-muted/60 text-white/70 hover:bg-muted/80"
          }`}
        >
          Contacts
        </button>
      </div>

      {entity === "contacts" && (
        <label className="flex flex-col gap-1">
          <span className="text-[11px] uppercase tracking-wide text-white/50">
            Attach contacts to company
          </span>
          <select
            value={targetOrgId}
            onChange={(e) => setTargetOrgId(e.target.value)}
            className="rounded-md border border-line bg-canvas px-3 py-2 text-sm text-white focus:border-accent focus:outline-none"
          >
            <option value="">— pick an org —</option>
            {orgOptions.map((o) => (
              <option key={o.id} value={o.id}>
                {o.legalName}
              </option>
            ))}
          </select>
        </label>
      )}

      <label className="flex flex-col gap-1">
        <span className="text-[11px] uppercase tracking-wide text-white/50">
          CSV file
        </span>
        <input
          type="file"
          accept=".csv,text/csv"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) handleFile(file);
          }}
          className="rounded-md border border-line bg-canvas px-2 py-1.5 text-sm text-white file:mr-3 file:rounded file:border-0 file:bg-accent/20 file:px-2 file:py-1 file:text-xs file:text-accent"
        />
      </label>

      {headers.length > 0 && (
        <div className="flex flex-col gap-3">
          <div className="rounded-lg border border-line bg-muted/20 p-4">
            <div className="mb-2 text-[11px] uppercase tracking-wide text-white/50">
              Column mapping
            </div>
            <div className="grid gap-2 md:grid-cols-2">
              {headers.map((h, idx) => (
                <div
                  key={idx}
                  className="flex items-center gap-2 rounded-md border border-line/60 bg-canvas/40 px-2 py-1.5"
                >
                  <span className="flex-1 truncate font-mono text-xs text-white/70">
                    {h}
                  </span>
                  <span className="text-white/30">→</span>
                  <select
                    value={mapping[idx] ?? ""}
                    onChange={(e) =>
                      setMapping((prev) => ({ ...prev, [idx]: e.target.value }))
                    }
                    className="rounded-md border border-line bg-canvas px-2 py-1 text-xs text-white focus:border-accent focus:outline-none"
                  >
                    {targetFields.map((f) => (
                      <option key={f.value} value={f.value}>
                        {f.label}
                      </option>
                    ))}
                  </select>
                </div>
              ))}
            </div>
          </div>

          <div className="rounded-lg border border-line bg-muted/20 p-4">
            <div className="mb-2 text-[11px] uppercase tracking-wide text-white/50">
              Preview (first 5 of {rows.length})
            </div>
            <div className="overflow-x-auto">
              <table className="min-w-full text-xs">
                <thead>
                  <tr className="text-white/50">
                    {targetFields
                      .filter((f) => f.value !== "")
                      .map((f) => (
                        <th
                          key={f.value}
                          className="px-2 py-1 text-left font-medium"
                        >
                          {f.label.replace(" *", "")}
                        </th>
                      ))}
                  </tr>
                </thead>
                <tbody>
                  {mappedRows.slice(0, 5).map((r, i) => (
                    <tr key={i} className="border-t border-line/40">
                      {targetFields
                        .filter((f) => f.value !== "")
                        .map((f) => (
                          <td key={f.value} className="px-2 py-1 text-white/80">
                            {r[f.value] ?? ""}
                          </td>
                        ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="flex items-center justify-end gap-3">
            <span className="text-xs text-white/40">
              {rows.length} row(s) ready
            </span>
            <button
              type="button"
              onClick={() => void runImport()}
              disabled={!readyToImport || importing}
              className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-canvas disabled:cursor-not-allowed disabled:opacity-50"
            >
              {importing ? "Importing…" : `Import ${rows.length} row(s)`}
            </button>
          </div>
        </div>
      )}

      {error && (
        <div className="rounded-md border border-bad/40 bg-bad/10 px-3 py-2 text-sm text-bad">
          {error}
        </div>
      )}

      {result && (
        <div className="rounded-lg border border-line bg-muted/20 p-4">
          <div className="flex items-center gap-3">
            <span className="text-sm font-medium text-good">
              Imported {result.imported}
            </span>
            <span className="text-sm text-white/60">
              Duplicates {result.duplicates}
            </span>
            <span className={`text-sm ${result.failed > 0 ? "text-bad" : "text-white/40"}`}>
              Failed {result.failed}
            </span>
          </div>
          {result.failed > 0 && (
            <details className="mt-3">
              <summary className="cursor-pointer text-xs text-white/60">
                Show failed row(s)
              </summary>
              <ul className="mt-2 flex flex-col gap-1 text-xs">
                {result.rows
                  .filter((r) => r.status === "failed")
                  .map((r) => (
                    <li key={r.index} className="font-mono text-bad">
                      row {r.index + 2}: {r.error}
                    </li>
                  ))}
              </ul>
            </details>
          )}
        </div>
      )}
    </div>
  );
}

function cleanCompanyRow(r: Record<string, string>): {
  legalName: string;
  domain?: string;
  industry?: string;
} {
  const out: { legalName: string; domain?: string; industry?: string } = {
    legalName: r["legalName"] ?? "",
  };
  if (r["domain"]) out.domain = r["domain"];
  if (r["industry"]) out.industry = r["industry"];
  return out;
}

function cleanContactRow(r: Record<string, string>): {
  fullName: string;
  title?: string;
  emails?: string[];
  phones?: string[];
} {
  const out: {
    fullName: string;
    title?: string;
    emails?: string[];
    phones?: string[];
  } = { fullName: r["fullName"] ?? "" };
  if (r["title"]) out.title = r["title"];
  if (r["emails"]) out.emails = [r["emails"]];
  if (r["phones"]) out.phones = [r["phones"]];
  return out;
}
