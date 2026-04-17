import { Fragment, type ReactNode } from "react";

/**
 * Lightweight prose renderer for assistant chat turns.
 *
 * Claude occasionally emits markdown-ish formatting even when told not to
 * (bold asterisks around labels in capability lists, dash bullets for
 * steps). Rather than fight the model on every turn, parse the small
 * subset we actually see — bold, inline code, single-em, paragraph
 * breaks, dash/asterisk bullet lists — and render it as JSX.
 *
 * Not a full markdown parser: no tables, no links, no headings, no
 * nested lists. Anything we don't recognise is rendered as plain text.
 */
/**
 * Pull the bracketed `[chunk 01H…]` citation literals out of the
 * prose. Claude inserts them inline because the system prompt asks
 * for chunk_id-grounded answers, but they read as noise — the
 * EvidencePanel already lists every cited chunk. We strip them from
 * the prose and let the panel be the source of truth.
 *
 * Pattern matches single (`[chunk 01H…]`) and comma-separated
 * (`[chunk 01H…, 01H…, 01H…]`) forms. We tolerate any whitespace
 * between commas and accept ULID-shape ids (Crockford base32, 26
 * chars).
 */
const CHUNK_CITATION_RE =
  /\s*\[\s*chunk\s+(?:01[A-Z0-9]{24})(?:\s*,\s*(?:01[A-Z0-9]{24}))*\s*\]/g;

function stripChunkCitations(source: string): string {
  return source
    .replace(CHUNK_CITATION_RE, "")
    // Tidy double-spaces and orphaned spaces before punctuation.
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+([.,;:!?])/g, "$1");
}

export function renderProse(source: string): ReactNode {
  const cleaned = stripChunkCitations(source.replace(/\r\n/g, "\n"));
  const blocks = splitBlocks(cleaned);
  return (
    <>
      {blocks.map((block, idx) => (
        <Fragment key={idx}>{renderBlock(block)}</Fragment>
      ))}
    </>
  );
}

interface ParagraphBlock {
  kind: "paragraph";
  lines: string[];
}
interface ListBlock {
  kind: "list";
  items: string[];
}
type Block = ParagraphBlock | ListBlock;

function splitBlocks(source: string): Block[] {
  const blocks: Block[] = [];
  const raw = source.split(/\n{2,}/);
  for (const chunk of raw) {
    const lines = chunk.split("\n").map((line) => line.trimEnd());
    if (lines.length === 0) continue;
    const isBullet = (line: string): boolean => /^[-*]\s+/.test(line.trimStart());
    if (lines.every((line) => line.length === 0 || isBullet(line))) {
      const items = lines
        .filter((line) => line.length > 0)
        .map((line) => line.trimStart().replace(/^[-*]\s+/, ""));
      if (items.length > 0) {
        blocks.push({ kind: "list", items });
        continue;
      }
    }
    blocks.push({ kind: "paragraph", lines });
  }
  return blocks;
}

function renderBlock(block: Block): ReactNode {
  if (block.kind === "list") {
    return (
      <ul className="my-2 list-disc space-y-1 pl-5">
        {block.items.map((item, idx) => (
          <li key={idx}>{renderInline(item)}</li>
        ))}
      </ul>
    );
  }
  return (
    <p className="my-2 whitespace-pre-line first:mt-0 last:mb-0">
      {block.lines.map((line, idx) => (
        <Fragment key={idx}>
          {idx > 0 && <br />}
          {renderInline(line)}
        </Fragment>
      ))}
    </p>
  );
}

// Inline token types in the order we consume them.
// **bold**       →  <strong>
// *italic*       →  <em>
// `code`         →  <code>
// NUMBER literal →  <Num> (drill number chip — Meridian pattern)
const INLINE_PATTERN = /(\*\*[^*\n]+\*\*|\*[^*\n]+\*|`[^`\n]+`)/g;

/**
 * Numbers and percentages embedded in prose are the Meridian
 * "drill number" pattern — every quantity is a chip you can click.
 * Matches:
 *   $1.2M, $450K, $12,300, $0.14
 *   87%, 12.5%, -3.4%
 *   1,234,567 (4+ grouped digits)
 *   4.8M USG, 12k contacts
 * Single-digit / small integers are deliberately skipped so we
 * don't turn every "3 deals" into a chip.
 */
const DRILL_NUMBER_RE =
  /(?<![\w.])(-?\$?\d[\d,]*\.?\d*[KMB]?(?:\s*(?:%|USG|USD|EUR))?)/g;

function renderInline(line: string): ReactNode {
  if (!line) return null;
  const parts = line.split(INLINE_PATTERN).filter((part) => part !== "");
  const nodes: ReactNode[] = [];
  let keyIdx = 0;
  for (const part of parts) {
    if (part.startsWith("**") && part.endsWith("**") && part.length >= 4) {
      nodes.push(<strong key={keyIdx++}>{part.slice(2, -2)}</strong>);
      continue;
    }
    if (part.startsWith("`") && part.endsWith("`") && part.length >= 2) {
      nodes.push(
        <code
          key={keyIdx++}
          className="rounded bg-muted/80 px-1 py-0.5 font-mono text-[0.85em]"
        >
          {part.slice(1, -1)}
        </code>,
      );
      continue;
    }
    if (part.startsWith("*") && part.endsWith("*") && part.length >= 2) {
      nodes.push(<em key={keyIdx++}>{part.slice(1, -1)}</em>);
      continue;
    }
    // Plain text segment — split on drill-number matches.
    const segments = part.split(DRILL_NUMBER_RE);
    for (const seg of segments) {
      if (!seg) continue;
      if (isDrillable(seg)) {
        nodes.push(<Num key={keyIdx++} value={seg} />);
      } else {
        nodes.push(<Fragment key={keyIdx++}>{seg}</Fragment>);
      }
    }
  }
  return nodes;
}

/**
 * Returns true iff the captured token is worth chip-rendering.
 * Filters out tiny integers ("3", "12") to reduce noise; anything
 * with a decimal point, thousands separator, currency mark, unit,
 * percentage, or K/M/B suffix qualifies.
 */
function isDrillable(raw: string): boolean {
  if (!/^\s*-?\$?\d/.test(raw)) return false;
  const t = raw.trim();
  if (/^-?\d{1,3}$/.test(t)) return false; // small bare integers
  return (
    /[.,KMB%]/i.test(t) ||
    /\s(?:USG|USD|EUR)$/i.test(t) ||
    t.startsWith("$")
  );
}

function Num({ value }: { value: string }) {
  return (
    <span
      className="inline-block cursor-pointer rounded border border-line bg-muted/60 px-1 font-mono text-[0.92em] font-medium text-white transition-colors hover:border-accent hover:text-accent"
      role="button"
      tabIndex={0}
      title="Drill down (coming soon)"
      onClick={(e) => {
        e.stopPropagation();
        // Placeholder hook — Meridian wires drill-downs to evidence.
        // For now the chip is discoverable and accessible; a future
        // sprint can dispatch an event to refine the query.
      }}
    >
      {value.trim()}
    </span>
  );
}
