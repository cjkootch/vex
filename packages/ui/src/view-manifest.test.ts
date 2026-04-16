import { describe, expect, it } from "vitest";
import { validateManifest } from "./view-manifest.js";

describe("validateManifest", () => {
  it("accepts a minimal valid manifest", () => {
    const manifest = validateManifest({
      version: 1,
      title: "Account summary",
      root: {
        kind: "stack",
        direction: "column",
        children: [
          { kind: "heading", level: 1, value: "Acme Corp" },
          { kind: "kv", label: "ARR", value: "$120k" },
        ],
      },
    });
    expect(manifest.title).toBe("Account summary");
    expect(manifest.root.kind).toBe("stack");
  });

  it("rejects manifests missing a title", () => {
    expect(() =>
      validateManifest({
        version: 1,
        root: { kind: "text", value: "hi" },
      }),
    ).toThrowError(/ManifestValidator rejected/);
  });

  it("rejects unknown node kinds", () => {
    expect(() =>
      validateManifest({
        version: 1,
        title: "X",
        root: { kind: "iframe", src: "https://evil.example" },
      }),
    ).toThrowError(/ManifestValidator rejected/);
  });

  it("rejects HTML strings dressed up as a node", () => {
    // Smoke test: a raw string is not a valid root; the renderer must never
    // see a ViewNode shaped like { html: "..." }.
    expect(() =>
      validateManifest({
        version: 1,
        title: "X",
        root: "<div>evil</div>",
      }),
    ).toThrowError();
  });

  it("requires an actionId on action nodes", () => {
    expect(() =>
      validateManifest({
        version: 1,
        title: "X",
        root: { kind: "action", tier: "T2", label: "Send", actionId: "" },
      }),
    ).toThrowError();
  });
});
