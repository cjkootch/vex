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
export function renderProse(source: string): ReactNode {
  const blocks = splitBlocks(source.replace(/\r\n/g, "\n"));
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
// **bold**  →  <strong>
// *italic*  →  <em>
// `code`    →  <code>
const INLINE_PATTERN = /(\*\*[^*\n]+\*\*|\*[^*\n]+\*|`[^`\n]+`)/g;

function renderInline(line: string): ReactNode {
  if (!line) return null;
  const parts = line.split(INLINE_PATTERN).filter((part) => part !== "");
  return parts.map((part, idx) => {
    if (part.startsWith("**") && part.endsWith("**") && part.length >= 4) {
      return <strong key={idx}>{part.slice(2, -2)}</strong>;
    }
    if (part.startsWith("`") && part.endsWith("`") && part.length >= 2) {
      return (
        <code
          key={idx}
          className="rounded bg-muted/80 px-1 py-0.5 font-mono text-[0.85em]"
        >
          {part.slice(1, -1)}
        </code>
      );
    }
    if (part.startsWith("*") && part.endsWith("*") && part.length >= 2) {
      return <em key={idx}>{part.slice(1, -1)}</em>;
    }
    return <Fragment key={idx}>{part}</Fragment>;
  });
}
