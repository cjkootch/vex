import { describe, expect, it } from "vitest";
import {
  bundleActionsIfMultiple,
  enforceAiModeWhenVexIsTheCaller,
} from "./query.service.js";
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
  it("defaults aiMode=true for 'Have Vex call X'", () => {
    const [action] = enforceAiModeWhenVexIsTheCaller(
      [outboundCall()],
      "Have Vex call Cole Kutschinski",
    );
    expect(action?.payload["aiMode"]).toBe(true);
  });

  it("defaults aiMode=true for 'AI call X'", () => {
    const [action] = enforceAiModeWhenVexIsTheCaller(
      [outboundCall()],
      "AI call Cole",
    );
    expect(action?.payload["aiMode"]).toBe(true);
  });

  it("defaults aiMode=true for a plain 'Call X'", () => {
    const [action] = enforceAiModeWhenVexIsTheCaller(
      [outboundCall()],
      "Call Cole about the Q3 rice tender",
    );
    expect(action?.payload["aiMode"]).toBe(true);
  });

  it("defaults aiMode=true for 'Dial X for me'", () => {
    const [action] = enforceAiModeWhenVexIsTheCaller(
      [outboundCall()],
      "Dial Cole for me",
    );
    expect(action?.payload["aiMode"]).toBe(true);
  });

  it("flips aiMode=false when the operator says they'll join the call", () => {
    const [action] = enforceAiModeWhenVexIsTheCaller(
      [outboundCall()],
      "Call Cole and I'll take the call",
    );
    expect(action?.payload["aiMode"]).toBe(false);
  });

  it("flips aiMode=false on 'conference me in'", () => {
    const [action] = enforceAiModeWhenVexIsTheCaller(
      [outboundCall()],
      "Dial Cole and conference me in",
    );
    expect(action?.payload["aiMode"]).toBe(false);
  });

  it("preserves an explicit aiMode=false regardless of phrasing", () => {
    const [action] = enforceAiModeWhenVexIsTheCaller(
      [outboundCall({ aiMode: false })],
      "Have Vex call Cole",
    );
    expect(action?.payload["aiMode"]).toBe(false);
  });

  it("preserves an explicit aiMode=true regardless of phrasing", () => {
    const [action] = enforceAiModeWhenVexIsTheCaller(
      [outboundCall({ aiMode: true })],
      "I'll take the call with Cole",
    );
    expect(action?.payload["aiMode"]).toBe(true);
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

describe("bundleActionsIfMultiple", () => {
  function emailSend(to: string, lang?: string): ProposedAction {
    return {
      kind: "email.send",
      tier: "T2",
      payload: {
        to: [to],
        subject: "hi",
        body: "hi",
        ...(lang ? { lang } : {}),
      },
      rationale: "follow up",
    };
  }

  it("returns single action unchanged", () => {
    const out = bundleActionsIfMultiple([emailSend("a@b.com")]);
    expect(out).toHaveLength(1);
    expect(out[0]?.kind).toBe("email.send");
  });

  it("keeps homogeneous email.send batch un-bundled (carousel render)", () => {
    const drafts = [
      emailSend("alice@x.com", "en"),
      emailSend("bob@x.com", "es"),
      emailSend("chen@x.com", "zh"),
    ];
    const out = bundleActionsIfMultiple(drafts);
    expect(out).toHaveLength(3);
    expect(out.every((a) => a.kind === "email.send")).toBe(true);
  });

  it("bundles mixed-kind multi-action lists", () => {
    const mixed: ProposedAction[] = [
      emailSend("a@b.com"),
      {
        kind: "crm.note",
        tier: "T1",
        payload: {
          organizationId: "01KPMGZNB2EN6SVCBJVGRVEDK1",
          body: "noted",
        },
        rationale: "log",
      },
    ];
    const out = bundleActionsIfMultiple(mixed);
    expect(out).toHaveLength(1);
    expect(out[0]?.kind).toBe("bundle");
  });

  it("non-carousel same-kind actions still bundle (e.g. multiple crm.notes)", () => {
    const notes: ProposedAction[] = [
      {
        kind: "crm.note",
        tier: "T1",
        payload: {
          organizationId: "01KPMGZNB2EN6SVCBJVGRVEDK1",
          body: "first",
        },
        rationale: "log",
      },
      {
        kind: "crm.note",
        tier: "T1",
        payload: {
          organizationId: "01KPMGZNB2EN6SVCBJVGRVEDK2",
          body: "second",
        },
        rationale: "log",
      },
    ];
    const out = bundleActionsIfMultiple(notes);
    expect(out).toHaveLength(1);
    expect(out[0]?.kind).toBe("bundle");
  });
});
