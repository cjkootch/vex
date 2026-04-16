import { validateManifest } from "@vex/ui";
import { ManifestRenderer } from "@/components/manifest-renderer";

/**
 * Sprint 0 landing page. Demonstrates the end-to-end manifest flow:
 *   1. A ViewManifest is produced (here hand-authored; later model-produced).
 *   2. The manifest is validated by ManifestValidator before rendering.
 *   3. The renderer walks the typed node tree — never interprets HTML.
 */
export default function Home() {
  const manifest = validateManifest({
    version: 1,
    title: "Vex",
    root: {
      kind: "stack",
      direction: "column",
      children: [
        { kind: "heading", level: 1, value: "Vex" },
        { kind: "text", value: "AI-native revenue intelligence platform" },
        { kind: "kv", label: "URL", value: "https://vexhq.ai" },
      ],
    },
  });

  return (
    <main style={{ padding: 32, fontFamily: "system-ui, sans-serif" }}>
      <ManifestRenderer manifest={manifest} />
    </main>
  );
}
