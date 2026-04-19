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
