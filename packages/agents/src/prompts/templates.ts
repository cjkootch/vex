import type { EmailTemplate, SmsTemplate, CallTemplate } from "@vex/db";

/**
 * Render a Vex-native template body (or subject, or aiInstructions)
 * by substituting `{{name}}` placeholders with values from `vars`.
 *
 *   substituteTemplate("Hi {{recipient_name}}", { recipient_name: "Cole" })
 *     → "Hi Cole"
 *
 * Unknown placeholders left intact so the operator sees them in the
 * chip preview and can either approve-with-gap or fix the template.
 * Whitespace inside braces (`{{ recipient_name }}`) is tolerated.
 */
export function substituteTemplate(
  text: string,
  vars: Record<string, string>,
): string {
  return text.replace(/\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g, (match, key) => {
    const value = vars[key];
    return typeof value === "string" ? value : match;
  });
}

/**
 * Extract every `{{name}}` placeholder from a template string. Used
 * to validate that the operator-declared `variables[]` covers every
 * placeholder actually used in the body — a missing declaration just
 * means the agent has no hint about where to source the value.
 */
export function extractPlaceholders(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g)) {
    if (m[1]) out.add(m[1]);
  }
  return [...out].sort();
}

/**
 * Renders the workspace's Vex-native email / SMS / call template
 * registry as a compact preamble for the chat system prompt. Lets the
 * agent pick a template by name when the operator says
 * "send X the {name} email" / "text X the {name} sms" / "have vex
 * call X with the {name} script".
 *
 * Empty across all three lists → empty string; the agent then handles
 * any "send the X template" request as "no such template" instead of
 * inventing one.
 */
export function renderTemplatesPreamble(
  email: readonly EmailTemplate[] | null | undefined,
  sms: readonly SmsTemplate[] | null | undefined,
  call: readonly CallTemplate[] | null | undefined,
): string {
  const hasAny =
    (email && email.length > 0) ||
    (sms && sms.length > 0) ||
    (call && call.length > 0);
  if (!hasAny) return "";

  const lines: string[] = [
    "## Vex-native templates registered for this workspace",
    "",
    "Operator-authored templates for email, SMS, and AI-mode voice",
    "calls. Pick by `name` when the operator says \"send X the {name}",
    "email\", \"text X the {name} sms\", \"have vex call X with the",
    "{name} script\". Resolve each `{{variable}}` placeholder from the",
    "evidence pack at send time. If a required variable isn't in",
    "scope, ASK ONE LINE for it — don't promise to send and stop.",
    "",
    "Untemplated freeform sends (`email.send` / `sms.send` /",
    "`outbound_call`) continue to work the same — templates are an",
    "OPT-IN library. Use them when the operator names one explicitly,",
    "or when the request matches a template's described purpose.",
    "",
  ];

  if (email && email.length > 0) {
    lines.push("### Email templates", "");
    for (const t of email) {
      lines.push(`- **${t.name}**`);
      lines.push(`  Subject: ${t.subject}`);
      lines.push(`  Body: ${oneLine(t.body)}`);
      if (t.description?.trim()) {
        lines.push(`  Use when: ${t.description.trim()}`);
      }
      if (t.variables && t.variables.length > 0) {
        lines.push(`  Variables: ${t.variables.join(", ")}`);
      }
    }
    lines.push("");
  }

  if (sms && sms.length > 0) {
    lines.push("### SMS templates", "");
    for (const t of sms) {
      lines.push(`- **${t.name}**`);
      lines.push(`  Body: ${oneLine(t.body)}`);
      if (t.description?.trim()) {
        lines.push(`  Use when: ${t.description.trim()}`);
      }
      if (t.variables && t.variables.length > 0) {
        lines.push(`  Variables: ${t.variables.join(", ")}`);
      }
    }
    lines.push("");
  }

  if (call && call.length > 0) {
    lines.push("### AI-call templates (used as `aiInstructions` on `outbound_call`)", "");
    for (const t of call) {
      lines.push(`- **${t.name}**`);
      if (t.goal_hint?.trim()) {
        lines.push(`  Goal: ${t.goal_hint.trim()}`);
      }
      lines.push(`  Instructions: ${oneLine(t.aiInstructions)}`);
      if (t.description?.trim()) {
        lines.push(`  Use when: ${t.description.trim()}`);
      }
      if (t.variables && t.variables.length > 0) {
        lines.push(`  Variables: ${t.variables.join(", ")}`);
      }
    }
    lines.push("");
  }

  lines.push("---", "", "");
  return lines.join("\n");
}

/** Collapse newlines + runs of whitespace so a multi-line body fits one bullet. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}
