import type { Config } from "tailwindcss";

export default {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: "#0d1117",
        canvas: "#0a0a0c",
        muted: "#1f2026",
        line: "#2a2c33",
        accent: "#7c5cff",
        good: "#22c55e",
        warn: "#f59e0b",
        bad: "#ef4444",
      },
    },
  },
  plugins: [],
} satisfies Config;
