"use client";

import { motion } from "framer-motion";
import { validateManifest } from "@vex/ui";
import type { ManifestPanel } from "@vex/ui";
import { resolvePanel } from "./registry";
import { PanelErrorBoundary } from "./panel-error-boundary";
import { FallbackPanel } from "./panels/fallback-panel";

interface Props {
  /** Raw model output. Validated here — never assume the upstream did it. */
  manifest: unknown;
  /** When validation fails, we still want to show *something* useful. */
  rawAnswer?: string;
}

/**
 * Single entry point for rendering a model-produced manifest.
 *
 * Pipeline:
 *   1. Validate via `ManifestValidator`. On failure, render a single
 *      `FallbackPanel` with the raw answer text — never throw, never
 *      attempt to render unvalidated content.
 *   2. Resolve each panel through the `ComponentRegistry`. Unknown panel
 *      types fall back to `FallbackPanel`.
 *   3. Wrap each panel in `PanelErrorBoundary` so a single broken panel
 *      can't crash the canvas.
 *   4. Animate panels in with a stagger so the canvas feels composed,
 *      not assembled.
 */
export function ManifestCanvas({ manifest, rawAnswer }: Props) {
  const result = validateManifest(manifest);

  if (!result.success) {
    return (
      <div data-canvas="invalid" className="space-y-3">
        <FallbackPanel
          type="(validation failed)"
          text={rawAnswer ?? "Vex couldn't compose a response."}
          error={result.error.slice(0, 200)}
        />
      </div>
    );
  }

  return (
    <div data-canvas="valid" className="space-y-3">
      {result.manifest.panels.map((panel, i) => (
        <motion.div
          key={i}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.2, delay: i * 0.05 }}
        >
          <PanelErrorBoundary panelType={panel.type}>
            <PanelHost panel={panel} />
          </PanelErrorBoundary>
        </motion.div>
      ))}
    </div>
  );
}

function PanelHost({ panel }: { panel: ManifestPanel }) {
  const Component = resolvePanel(panel.type) as React.ComponentType<Record<string, unknown>>;
  // The registry's typing collapses the discriminated union, so cast at this
  // single boundary; PanelErrorBoundary catches any prop-shape mismatch.
  return <Component {...(panel as unknown as Record<string, unknown>)} />;
}
