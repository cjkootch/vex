import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    // Playwright owns the e2e suite under tests/.
    exclude: ["node_modules", "tests/**", ".next/**"],
  },
});
