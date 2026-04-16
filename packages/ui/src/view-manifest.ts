import { z } from "zod";

/**
 * The ViewManifest is Vex's canonical model-output format.
 *
 * Invariants enforced by this schema:
 *   - The model never returns HTML — it returns a typed tree of `ViewNode`s.
 *   - `ManifestValidator` (see `validateManifest`) runs before any component
 *     renders a manifest. If validation fails, the renderer falls back to a
 *     safe empty state and raises a telemetry event.
 */

// Forward reference — defined below and plugged in via z.lazy.
export type ViewNodeT =
  | { kind: "text"; value: string }
  | { kind: "heading"; level: 1 | 2 | 3; value: string }
  | { kind: "stack"; direction: "row" | "column"; children: ViewNodeT[] }
  | { kind: "list"; items: ViewNodeT[] }
  | {
      kind: "action";
      tier: "T0" | "T1" | "T2" | "T3";
      label: string;
      actionId: string;
    }
  | { kind: "kv"; label: string; value: string };

export const ViewNode: z.ZodType<ViewNodeT> = z.lazy(() =>
  z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("text"), value: z.string() }),
    z.object({
      kind: z.literal("heading"),
      level: z.union([z.literal(1), z.literal(2), z.literal(3)]),
      value: z.string(),
    }),
    z.object({
      kind: z.literal("stack"),
      direction: z.enum(["row", "column"]),
      children: z.array(ViewNode),
    }),
    z.object({ kind: z.literal("list"), items: z.array(ViewNode) }),
    z.object({
      kind: z.literal("action"),
      tier: z.enum(["T0", "T1", "T2", "T3"]),
      label: z.string().min(1),
      actionId: z.string().min(1),
    }),
    z.object({ kind: z.literal("kv"), label: z.string(), value: z.string() }),
  ]),
);

export const ViewManifest = z.object({
  version: z.literal(1),
  title: z.string().min(1),
  root: ViewNode,
});
export type ViewManifestT = z.infer<typeof ViewManifest>;

/**
 * Run the ManifestValidator. Throws a descriptive error if the manifest is
 * malformed. Call this before handing a manifest to any renderer.
 */
export function validateManifest(raw: unknown): ViewManifestT {
  const result = ViewManifest.safeParse(raw);
  if (!result.success) {
    throw new Error(`ManifestValidator rejected manifest: ${result.error.message}`);
  }
  return result.data;
}
