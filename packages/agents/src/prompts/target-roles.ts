/**
 * Renders the workspace's `target_roles_by_category` registry as a
 * compact preamble for the chat system prompt. Lets the agent pick
 * candidate titles when biasing a Tavily enrichment query AND
 * populate the options on a "which function?" clarifying question
 * when the operator's enrichment intent is vague.
 *
 * Empty / missing registry → empty string. The clarifier branch in
 * the prompt skips when no options are available.
 */
export function renderTargetRolesPreamble(
  registry: Record<string, string[]> | null | undefined,
): string {
  if (!registry) return "";
  const categories = Object.entries(registry).filter(
    ([, roles]) => Array.isArray(roles) && roles.length > 0,
  );
  if (categories.length === 0) return "";

  const lines: string[] = [
    "## Target roles by category (for contact enrichment)",
    "",
    "Use this map when the operator asks for an enrichment without",
    "naming a specific role (e.g. \"find someone at Vitol\"):",
    "  1. Match the org's `kind` / product category to a key below.",
    "  2. Offer 2-3 of these titles as the clarifier options.",
    "  3. Once the operator picks (or says \"broad\"), pass the",
    "     selected title list to `research_contact` via the",
    "     `context` arg — \"candidate titles: A, B, C\".",
    "",
    "Treat the order of titles in each list as a soft priority hint",
    "when ranking enrichment candidates after Tavily returns.",
    "",
  ];

  for (const [category, roles] of categories) {
    lines.push(`- **${category}**: ${roles.join(", ")}`);
  }

  lines.push("", "---", "", "");
  return lines.join("\n");
}
