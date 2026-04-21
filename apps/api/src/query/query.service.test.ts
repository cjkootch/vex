import { describe, expect, it } from "vitest";
import { enforceAiModeWhenVexIsTheCaller } from "./query.service.js";
import type { ProposedAction } from "@vex/integrations";

function outboundCall(
  payload: Record<string, unknown> = {},
  rationale = "qualify lead",
): ProposedAction {
  return {
    kind: "outbound_call",
    tier: "T3",
    payload: {
      contactId: "01KPMGZNB2EN6SVCBJVGRVEDK1",
      orgId: "01KPMGZNB2EN6SVCBJVGRVEDK2",
      toNumber: "+18324927169",
      ...payload,
    },
    rationale,
  };
}

describe("enforceAiModeWhenVexIsTheCaller", () => {
  it("sets aiMode=true when the user asks Vex to call", () => {
    const [action] = enforceAiModeWhenVexIsTheCaller(
      [outboundCall()],
      "Have Vex call Cole Kutschinski",
    );
    expect(action?.payload["aiMode"]).toBe(true);
  });

  it("sets aiMode=true for 'AI call X'", () => {
    const [action] = enforceAiModeWhenVexIsTheCaller(
      [outboundCall()],
      "AI call Cole",
    );
    expect(action?.payload["aiMode"]).toBe(true);
  });

  it("sets aiMode=true for 'have the agent talk to X'", () => {
    const [action] = enforceAiModeWhenVexIsTheCaller(
      [outboundCall()],
      "have the agent talk to Cole about pipeline",
    );
    expect(action?.payload["aiMode"]).toBe(true);
  });

  it("leaves aiMode alone when the phrase implies operator dial", () => {
    const [action] = enforceAiModeWhenVexIsTheCaller(
      [outboundCall()],
      "Dial Cole for me",
    );
    expect(action?.payload["aiMode"]).toBeUndefined();
  });

  it("preserves an explicit aiMode=false", () => {
    const [action] = enforceAiModeWhenVexIsTheCaller(
      [outboundCall({ aiMode: false })],
      "Have Vex call Cole",
    );
    expect(action?.payload["aiMode"]).toBe(false);
  });

  it("ignores non-outbound_call actions", () => {
    const emailAction: ProposedAction = {
      kind: "email.send",
      tier: "T2",
      payload: { to: "a@b.com", subject: "hi", body: "hi" },
      rationale: "follow up",
    };
    const [action] = enforceAiModeWhenVexIsTheCaller(
      [emailAction],
      "Have Vex call Cole",
    );
    expect(action).toBe(emailAction);
  });
});
