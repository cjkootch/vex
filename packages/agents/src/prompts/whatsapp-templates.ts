import type { WhatsAppTemplate } from "@vex/db";

/**
 * Renders the workspace's registered WhatsApp Business Message
 * Templates as a compact preamble appended to the chat system prompt.
 * Lets the chat agent pick a template by name when an operator asks
 * for COLD WhatsApp outreach (where freeform `whatsapp.send` would
 * fail with Twilio error 63016 outside the 24h customer-care window).
 *
 * Returns an empty string when no templates are registered; cold
 * WhatsApp outreach simply isn't available in that case and the
 * model should say so plainly rather than invent a contentSid.
 */
export function renderWhatsAppTemplatesPreamble(
  templates: readonly WhatsAppTemplate[] | null | undefined,
): string {
  if (!templates || templates.length === 0) return "";
  const lines: string[] = [
    "## WhatsApp Business templates registered for this workspace",
    "",
    "Used by `whatsapp.send_template` for COLD WhatsApp outreach (the only",
    "way to message a recipient who hasn't messaged the workspace's",
    "WhatsApp number in the last 24h — freeform `whatsapp.send` is",
    "rejected by Twilio with error 63016 outside that window).",
    "",
    "When the operator asks to send a template, pick by `name`, resolve",
    "each variable from evidence (or ASK ONE LINE if a required variable",
    "isn't in scope), and emit `whatsapp.send_template` with the",
    "matching `contentSid`. Carry the chosen `name` as `templateName` so",
    "the chip + audit trail show the operator-friendly label.",
    "",
  ];

  for (const t of templates) {
    lines.push(`- **${t.name}** — \`${t.contentSid}\``);
    if (t.description && t.description.trim()) {
      lines.push(`  Description: ${t.description.trim()}`);
    }
    if (t.variables && t.variables.length > 0) {
      const labelled = t.variables
        .map((v: string, i: number) => `{{${i + 1}}} = ${v}`)
        .join(", ");
      lines.push(`  Variables: ${labelled}`);
    }
  }

  lines.push("", "---", "", "");
  return lines.join("\n");
}
