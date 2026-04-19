/**
 * Tiny CSV helper. Quotes any cell that contains comma, quote, or
 * newline; doubles embedded quotes per RFC 4180. No dependency on a
 * CSV library — the output is simple enough to hand-roll correctly
 * and we avoid a 100KB client-side addition for a button.
 */
export function toCsv(
  headers: string[],
  rows: Array<Array<string | number | boolean | null | undefined>>,
): string {
  const lines = [headers.map(csvEscape).join(",")];
  for (const row of rows) {
    lines.push(row.map(cellToCsv).join(","));
  }
  return lines.join("\r\n");
}

function cellToCsv(
  cell: string | number | boolean | null | undefined,
): string {
  if (cell === null || cell === undefined) return "";
  if (typeof cell === "number" || typeof cell === "boolean") {
    return String(cell);
  }
  return csvEscape(cell);
}

function csvEscape(raw: string): string {
  if (/[",\r\n]/.test(raw)) {
    return `"${raw.replace(/"/g, '""')}"`;
  }
  return raw;
}

/**
 * Parse an RFC-4180 CSV string into `{ headers, rows }` where rows
 * is a matrix of strings. Handles quoted cells, embedded commas,
 * escaped double quotes (""), and CRLF vs LF line endings.
 * Deliberately minimal — no type coercion, no callback API, no
 * streaming; the caller runs interpretation.
 */
export function parseCsv(input: string): {
  headers: string[];
  rows: string[][];
} {
  const cells: string[][] = [[]];
  let cur = "";
  let inQuotes = false;
  let i = 0;
  const text = input.replace(/\r\n/g, "\n");
  while (i < text.length) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cur += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      cur += ch;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (ch === ",") {
      cells[cells.length - 1]!.push(cur);
      cur = "";
      i += 1;
      continue;
    }
    if (ch === "\n") {
      cells[cells.length - 1]!.push(cur);
      cur = "";
      cells.push([]);
      i += 1;
      continue;
    }
    cur += ch;
    i += 1;
  }
  cells[cells.length - 1]!.push(cur);
  // Drop trailing empty line if the file ended with \n.
  while (
    cells.length > 0 &&
    cells[cells.length - 1]!.length === 1 &&
    cells[cells.length - 1]![0] === ""
  ) {
    cells.pop();
  }
  const headers = cells[0] ?? [];
  const rows = cells.slice(1);
  return { headers, rows };
}

/**
 * Trigger a browser download for a CSV string. Safe to call from any
 * client component — opens a temporary blob URL, clicks a hidden
 * anchor, and revokes the URL on the next tick.
 */
export function downloadCsv(filename: string, csv: string): void {
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename.endsWith(".csv") ? filename : `${filename}.csv`;
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
