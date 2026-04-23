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

  const text = sigText ? `${body}\n\n-- \n${sigText.trim()}` : body;
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

function pickNonEmpty(
  ...values: ReadonlyArray<string | null | undefined>
): string | undefined {
  for (const v of values) {
    if (typeof v === "string" && v.trim().length > 0) return v;
  }
  return undefined;
}
