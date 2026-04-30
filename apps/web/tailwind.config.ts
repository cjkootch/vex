import type { Config } from "tailwindcss";

/**
 * Vex design tokens.
 *
 * The palette is intentionally narrow — a trading desk doesn't need
 * sixteen shades of blue. The tiers below exist so a component can
 * reach for the right surface by intent ("raised" vs "overlay") and
 * the whole system shifts together when a tone changes.
 *
 *   bg        page canvas (deepest, near-black with a hint of blue)
 *   surface-1 raised card that sits on the canvas
 *   surface-2 overlay / modal / popover — sits above surface-1
 *   line      default hairline border
 *   line-soft quieter divider inside a single surface
 *   line-strong for framed surfaces that need to read as distinct
 *
 * The `intel` tone is reserved for AI-generated content — anything
 * Vex wrote / recommended / is working on. A single subtle violet
 * cast across the product is our AI signature.
 */
export default {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // ── Canonical token aliases (mirror tokens.css) ─────────────
        // Maps Tailwind utility names to CSS variables defined in
        // apps/web/src/styles/tokens.css. The same set of names lives
        // in procur's tailwind config; the only difference is the
        // values in the per-app tokens.css. Don't add literal hex
        // values here — keep this file mode-agnostic.
        background: "var(--color-background)",
        foreground: "var(--color-foreground)",
        subtle: {
          DEFAULT: "var(--color-subtle)",
          foreground: "var(--color-subtle-foreground)",
        },
        border: "var(--color-border)",
        "border-strong": "var(--color-border-strong)",
        input: "var(--color-input)",
        ring: "var(--color-ring)",
        success: {
          DEFAULT: "var(--color-success)",
          foreground: "var(--color-success-foreground)",
          subtle: "var(--color-success-subtle)",
        },
        warning: {
          DEFAULT: "var(--color-warning)",
          foreground: "var(--color-warning-foreground)",
          subtle: "var(--color-warning-subtle)",
        },
        danger: {
          DEFAULT: "var(--color-danger)",
          foreground: "var(--color-danger-foreground)",
          subtle: "var(--color-danger-subtle)",
        },
        info: {
          DEFAULT: "var(--color-info)",
          foreground: "var(--color-info-foreground)",
          subtle: "var(--color-info-subtle)",
        },

        // ── Legacy aliases (kept for incremental migration) ─────────
        // These map to the new tokens where the meaning is the same,
        // and stay literal where the legacy color was intentionally
        // distinct. Removing them would require migrating ~hundreds
        // of usages across every page; do that incrementally in a
        // follow-up.
        ink: "#0d1117",
        canvas: "var(--color-background)",
        muted: {
          DEFAULT: "var(--color-muted)",
          foreground: "var(--color-muted-foreground)",
        },
        line: "var(--color-border)",
        accent: {
          DEFAULT: "var(--color-accent)",
          foreground: "var(--color-accent-foreground)",
        },
        good: "var(--color-success)",
        warn: "var(--color-warning)",
        bad: "var(--color-danger)",
        // Tiered surface system. surface-1 = elevated card, surface-2
        // = overlay/popover. Procur has the same names with light
        // values. These keep their literal hex for now because the
        // per-tier shading is finer-grained than the token set.
        bg: "var(--color-background)",
        "surface-1": "#101116",
        "surface-2": "#16181f",
        "surface-3": "#1c1f27",
        "line-soft": "#1e2027",
        "line-strong": "var(--color-border-strong)",
        "text-primary": "var(--color-foreground)",
        "text-secondary": "#a8abb4",
        "text-muted": "var(--color-muted-foreground)",
        "accent-soft": "var(--color-accent-subtle)",
        "accent-strong": "var(--color-accent-hover)",
        intel: "var(--color-accent)",
        "intel-soft": "var(--color-accent-subtle)",
      },
      fontFamily: {
        sans: [
          "var(--font-montserrat)",
          "var(--font-sans)",
          "ui-sans-serif",
          "system-ui",
          "sans-serif",
        ],
        mono: ["var(--font-mono)", "ui-monospace", "SFMono-Regular", "monospace"],
      },
      fontSize: {
        // Tight tracking for display + title to read as editorial.
        display: ["2rem", { lineHeight: "1.15", letterSpacing: "-0.02em", fontWeight: "600" }],
        title: ["1.5rem", { lineHeight: "1.2", letterSpacing: "-0.015em", fontWeight: "600" }],
        h1: ["1.25rem", { lineHeight: "1.25", letterSpacing: "-0.01em", fontWeight: "600" }],
        h2: ["1rem", { lineHeight: "1.3", letterSpacing: "-0.005em", fontWeight: "600" }],
        eyebrow: [
          "0.6875rem",
          {
            lineHeight: "1",
            letterSpacing: "0.08em",
            textTransform: "uppercase",
            fontWeight: "600",
          },
        ],
      },
      letterSpacing: {
        wider2: "0.06em",
      },
      borderRadius: {
        // Six / eight / twelve px — tight, consistent, no 4s.
        sm: "0.375rem",
        md: "0.5rem",
        lg: "0.75rem",
        xl: "1rem",
      },
      boxShadow: {
        // Layered shadows that read as "surface sits above surface".
        soft: "0 1px 0 0 rgba(255,255,255,0.03) inset, 0 1px 2px 0 rgba(0,0,0,0.25)",
        raised:
          "0 1px 0 0 rgba(255,255,255,0.04) inset, 0 2px 8px -2px rgba(0,0,0,0.45), 0 8px 24px -12px rgba(0,0,0,0.35)",
        overlay:
          "0 1px 0 0 rgba(255,255,255,0.05) inset, 0 8px 24px -8px rgba(0,0,0,0.55), 0 24px 48px -16px rgba(0,0,0,0.45)",
        "intel-glow":
          "0 0 0 1px rgba(124,92,255,0.25) inset, 0 0 20px -8px rgba(124,92,255,0.35)",
      },
      backgroundImage: {
        // Reserved for AI-generated surfaces — one visible signature
        // so operators develop a "this came from Vex" eye.
        "intel-sheen":
          "linear-gradient(135deg, rgba(124,92,255,0.12) 0%, rgba(124,92,255,0.02) 45%, rgba(0,0,0,0) 100%)",
      },
      transitionTimingFunction: {
        // Premium easing — slightly anticipatory in, settled out.
        "out-quart": "cubic-bezier(0.25, 1, 0.5, 1)",
        // Tailwind's `transition` + `transition-colors` etc default to
        // this curve so every hover / focus / press across the product
        // reads as one hand. Keeps shell motion calm, no bouncy ease.
        DEFAULT: "cubic-bezier(0.25, 1, 0.5, 1)",
      },
      transitionDuration: {
        // 150ms is fast enough to feel instant on good hardware and
        // slow enough that state changes register as intentional.
        DEFAULT: "150ms",
      },
    },
  },
  plugins: [],
} satisfies Config;
