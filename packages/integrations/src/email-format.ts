/**
 * Outbound email formatter: takes the AI-drafted body (always plain text
 * today) plus an optional per-workspace signature and returns the
 * {text, html} pair Resend expects. Gmail / Outlook render the HTML
 * version; plain-text clients + gateways still see a readable fallback.
 *
 * Design:
 *   - Body is treated as plain text. Paragraphs split on one-or-more
 *     blank lines; single newlines become `<br/>` in the HTML version.
 *   - Signature is split into a `text` part (appended with a "-- "
 *     RFC-standard delimiter) and an `html` part (rendered inside a
 *     card-styled block with a hairline divider). Either or both
 *     may be omitted — defaults synthesised from workspace + owner.
 *   - No external HTML sanitiser — operators author their own
 *     signature and we escape body content by default. Signature HTML
 *     is passed through as-is; operators who paste raw HTML there own
 *     the safety of what they wrote.
 *
 * The function is pure: no I/O, no workspace lookups. Callers resolve
 * the settings + defaults then hand a fully-prepared RenderInput in.
 */

export interface EmailSignature {
  /** Plain-text signature (appended after "\n\n-- \n"). */
  text?: string | undefined;
  /** HTML signature block (appended inside the email body card). */
  html?: string | undefined;
}

export interface EmailRenderInput {
  /** AI- or user-drafted plain-text email body. Required. */
  body: string;
  /** Optional signature overrides. When absent, defaults fill in. */
  signature?: EmailSignature | undefined;
  /**
   * Fallback signature used when `signature.html` / `signature.text`
   * are empty. Generated from workspace + owner context at the call
   * site — kept out of this helper so it stays pure.
   */
  defaults?: EmailSignature | undefined;
}

export interface EmailRenderOutput {
  text: string;
  html: string;
}

export function renderEmailWithSignature(
  input: EmailRenderInput,
): EmailRenderOutput {
  const body = input.body.trim();
  const sigText = pickNonEmpty(input.signature?.text, input.defaults?.text);
  const sigHtml = pickNonEmpty(input.signature?.html, input.defaults?.html);

  // When the operator only filled in the HTML signature, derive a
  // matching plain-text fallback by stripping tags. Outlook /
  // Microsoft 365 score wide divergence between the HTML and text
  // bodies as a spam signal — surfacing the same content in both
  // parts keeps the alignment heuristic happy. The admin tab
  // already advertises this behaviour ("Plain text falls back to
  // HTML-stripped when not provided"); this is the half that was
  // missing.
  const sigTextFallback = sigText ?? (sigHtml ? htmlSignatureToText(sigHtml) : undefined);

  const text = sigTextFallback
    ? `${body}\n\n-- \n${sigTextFallback.trim()}`
    : body;
  const html = buildHtml(body, sigHtml ?? null);
  return { text, html };
}

/**
 * Build a default signature block from workspace + owner context. Used
 * when the operator hasn't customised one. Non-binding — the caller
 * may skip the default entirely and pass an empty signature to emit a
 * bare body. All inputs are optional; the output gracefully omits
 * missing fields (e.g. no phone → phone line absent).
 */
export interface DefaultSignatureInput {
  fullName?: string | null;
  title?: string | null;
  companyName?: string | null;
  email?: string | null;
  phone?: string | null;
  websiteUrl?: string | null;
}

export function buildDefaultSignature(
  input: DefaultSignatureInput,
): EmailSignature {
  const lines: string[] = [];
  if (input.fullName) lines.push(input.fullName);
  if (input.title) lines.push(input.title);
  if (input.companyName) lines.push(input.companyName);
  const contactBits: string[] = [];
  if (input.phone) contactBits.push(input.phone);
  if (input.email) contactBits.push(input.email);
  if (contactBits.length > 0) lines.push(contactBits.join(" · "));
  if (input.websiteUrl) lines.push(input.websiteUrl);

  const text = lines.length > 0 ? lines.join("\n") : undefined;

  // HTML: name bold, title muted, contact line with `mailto:` + `tel:`
  // + website link. Kept inline — no external stylesheet because email
  // clients strip them.
  const htmlParts: string[] = [];
  if (input.fullName) {
    htmlParts.push(
      `<div style="font-weight:600;color:#1a1a1a;">${escapeHtml(input.fullName)}</div>`,
    );
  }
  if (input.title) {
    htmlParts.push(
      `<div style="color:#555;font-size:13px;">${escapeHtml(input.title)}</div>`,
    );
  }
  if (input.companyName) {
    htmlParts.push(
      `<div style="color:#1a1a1a;font-size:13px;">${escapeHtml(input.companyName)}</div>`,
    );
  }
  const contactHtml: string[] = [];
  if (input.phone) {
    contactHtml.push(
      `<a href="tel:${escapeHtmlAttr(stripPhoneFormatting(input.phone))}" style="color:#555;text-decoration:none;">${escapeHtml(input.phone)}</a>`,
    );
  }
  if (input.email) {
    contactHtml.push(
      `<a href="mailto:${escapeHtmlAttr(input.email)}" style="color:#555;text-decoration:none;">${escapeHtml(input.email)}</a>`,
    );
  }
  if (contactHtml.length > 0) {
    htmlParts.push(
      `<div style="color:#555;font-size:13px;margin-top:4px;">${contactHtml.join(' <span style="color:#ccc;">·</span> ')}</div>`,
    );
  }
  if (input.websiteUrl) {
    const href = input.websiteUrl.startsWith("http")
      ? input.websiteUrl
      : `https://${input.websiteUrl}`;
    htmlParts.push(
      `<div style="font-size:13px;margin-top:2px;"><a href="${escapeHtmlAttr(href)}" style="color:#7c5cff;text-decoration:none;">${escapeHtml(input.websiteUrl)}</a></div>`,
    );
  }
  const html =
    htmlParts.length > 0
      ? `<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;">${htmlParts.join("")}</div>`
      : undefined;

  const out: EmailSignature = {};
  if (text) out.text = text;
  if (html) out.html = html;
  return out;
}

function buildHtml(body: string, sigHtml: string | null): string {
  const bodyHtml = paragraphsToHtml(body);
  const signatureBlock = sigHtml
    ? `<hr style="border:none;border-top:1px solid #e5e5e5;margin:20px 0 14px;" />${sigHtml}`
    : "";
  return (
    `<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:14px;line-height:1.55;color:#1a1a1a;max-width:620px;">` +
    bodyHtml +
    signatureBlock +
    `</div>`
  );
}

function paragraphsToHtml(body: string): string {
  const paragraphs = body
    .split(/\r?\n\s*\r?\n/)
    .map((p) => p.replace(/\r\n/g, "\n").trim())
    .filter((p) => p.length > 0);
  if (paragraphs.length === 0) return "";
  return paragraphs
    .map((p) => `<p style="margin:0 0 12px;">${escapeHtml(p).replace(/\n/g, "<br/>")}</p>`)
    .join("");
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeHtmlAttr(s: string): string {
  return escapeHtml(s);
}

function stripPhoneFormatting(s: string): string {
  return s.replace(/[^\d+]/g, "");
}

/**
 * Best-effort HTML → plain-text conversion for an operator-authored
 * signature. Used when the workspace has an HTML signature but no
 * matching text signature — surfacing the same content in both
 * MIME parts is a deliverability signal (Outlook / M365 down-rank
 * wide HTML/text divergence as a spam pattern).
 *
 * Not a general-purpose HTML sanitiser — intentionally narrow:
 *   1. Drop entire <script>/<style> blocks (defence in depth, even
 *      though the renderer doesn't use either).
 *   2. Treat <br>, </p>, </div>, </tr>, </li>, </h1..6> as line breaks
 *      so a tabular signature collapses into one-line-per-row instead
 *      of running into a single blob.
 *   3. Strip remaining tags.
 *   4. Decode the handful of HTML entities the formatter itself emits
 *      (`&amp;`, `&lt;`, `&gt;`, `&quot;`, `&#39;`, plus `&nbsp;`).
 *   5. Trim each line and collapse runs of >2 blank lines to 1 — a
 *      typical signature table renders into a tidy 4–6 line block.
 *
 * Operator-pasted HTML often contains `<img>`, `<a>` href attrs, and
 * inline CSS we don't surface in text. That's intentional: the text
 * fallback is for screen readers and plain-text-only clients; the
 * full styled experience lives in the HTML part.
 */
export function htmlSignatureToText(html: string): string {
  let s = html;
  // 1. Drop script / style blocks entirely.
  s = s.replace(/<script[\s\S]*?<\/script>/gi, "");
  s = s.replace(/<style[\s\S]*?<\/style>/gi, "");
  // 2. Block-ish tags become line breaks.
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<\/(p|div|tr|li|h[1-6])>/gi, "\n");
  // 3. Strip remaining tags.
  s = s.replace(/<[^>]+>/g, "");
  // 4. Decode the entities our HTML escaper emits, plus &nbsp;.
  s = s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
  // 5. Tidy whitespace: trim each line, collapse 3+ blank lines.
  const lines = s
    .split(/\r?\n/)
    .map((line) => line.replace(/[ \t]+/g, " ").trim());
  const collapsed: string[] = [];
  for (const line of lines) {
    if (line.length === 0 && collapsed[collapsed.length - 1] === "") continue;
    collapsed.push(line);
  }
  return collapsed.join("\n").trim();
}

function pickNonEmpty(
  ...values: ReadonlyArray<string | null | undefined>
): string | undefined {
  for (const v of values) {
    if (typeof v === "string" && v.trim().length > 0) return v;
  }
  return undefined;
}
