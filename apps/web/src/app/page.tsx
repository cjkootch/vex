import { manifestFallback, validateManifest } from "@vex/ui";
import { ManifestRenderer } from "@/components/manifest-renderer";

/**
 * Marketing landing. Hand-authored manifest demonstrates the panel surface.
 * The /app page (auth-gated) renders model-produced manifests through the
 * exact same renderer.
 */
export default function Home() {
  const result = validateManifest({
    panels: [
      {
        type: "profile",
        objectType: "platform",
        objectId: "vex",
        fields: {
          Name: "Vex",
          Tagline: "AI-native revenue intelligence",
          URL: "https://vexhq.ai",
        },
      },
    ],
  });
  const manifest = result.success ? result.manifest : manifestFallback("Welcome to Vex.");

  return (
    <main style={{ padding: 32, fontFamily: "system-ui, sans-serif" }}>
      <ManifestRenderer manifest={manifest} />
    </main>
  );
}
