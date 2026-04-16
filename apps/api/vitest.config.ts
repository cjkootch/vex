import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    // NestJS calls process.abort() on initialization failures; vitest's
    // default `threads` pool can't service that, masking the real error.
    pool: "forks",
  },
});
