import { describe, expect, it } from "vitest";
import { parseModelOutput, renderEvidencePack } from "./anthropic.js";
import type { EvidencePack } from "@vex/domain";

describe("parseModelOutput", () => {
  it("splits the model output into answer + manifest + actions", () => {
    const text = `Acme Corporation is a manufacturing buyer.

\`\`\`json
{
  "view_manifest": {
    "panels": [
      { "type": "table", "title": "x", "columns": ["a"], "rows": [{ "a": "b" }] }
    ]
  },
  "proposed_actions": [
    { "kind": "crm.note", "tier": "T1", "payload": { "body": "follow up" } }
  ]
}
\`\`\``;
    const result = parseModelOutput(text);
    expect(result.answer).toBe("Acme Corporation is a manufacturing buyer.");
    expect(result.viewManifest).toMatchObject({
      panels: [{ type: "table", title: "x" }],
    });
    expect(result.proposedActions).toHaveLength(1);
    expect(result.proposedActions[0]?.kind).toBe("crm.note");
  });

  it("returns an empty manifest stub when the model omits the JSON block", () => {
    const result = parseModelOutput("just plain text, no json");
    expect(result.answer).toBe("just plain text, no json");
    expect(result.viewManifest).toEqual({ panels: [] });
    expect(result.proposedActions).toEqual([]);
  });

  it("ignores actions that don't match the ProposedAction shape", () => {
    const text = `ok\n\`\`\`json\n{ "view_manifest": { "panels": [] }, "proposed_actions": [{ "garbage": true }] }\n\`\`\``;
    const result = parseModelOutput(text);
    expect(result.proposedActions).toHaveLength(0);
  });
});

describe("renderEvidencePack", () => {
  it("renders summaries before items in stable order", () => {
    const pack: EvidencePack = {
      summaries: [
        {
          chunk_id: "s1",
          object_type: "organization",
          object_id: "o1",
          chunk_text: "Acme summary text",
          source_ref: "summary v3 / Acme",
          source_type: "summary",
          occurred_at: new Date("2026-04-01T00:00:00Z"),
          freshness_hours: 100,
          confidence_score: 0.9,
          corroborated_by_count: 0,
          permission_scope: "workspace",
          raw_event_ref: null,
          summary_version: 3,
        },
      ],
      items: [
        {
          chunk_id: "c1",
          object_type: "contact",
          object_id: "p1",
          chunk_text: "click on demo link",
          source_ref: "touchpoint",
          source_type: "event",
          occurred_at: new Date("2026-04-15T13:00:00Z"),
          freshness_hours: 12,
          confidence_score: 0.7,
          corroborated_by_count: 1,
          permission_scope: "workspace",
          raw_event_ref: "01HSEEDRAW0000000000000001",
          summary_version: null,
        },
      ],
      estimated_tokens: 20,
    };
    const text = renderEvidencePack(pack);
    expect(text).toContain("# Evidence pack");
    expect(text.indexOf("Scope summaries")).toBeLessThan(text.indexOf("Evidence items"));
    expect(text).toContain("chunk_id=c1");
    expect(text).toContain("Acme summary text");
  });
});
