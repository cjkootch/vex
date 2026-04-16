import { describe, expect, it } from "vitest";
import { loadEnv } from "./env.js";

const baseEnv = {
  APPLICATION_DATABASE_URL: "postgres://user:pass@pooler.example.com/vex",
  MIGRATION_DATABASE_URL: "postgres://user:pass@direct.example.com/vex",
  REDIS_URL: "redis://localhost:6379",
  S3_BUCKET: "vex-local",
  S3_ACCESS_KEY_ID: "test",
  S3_SECRET_ACCESS_KEY: "test",
  ANTHROPIC_API_KEY: "sk-ant-test",
  OPENAI_API_KEY: "sk-test",
} satisfies NodeJS.ProcessEnv;

describe("loadEnv", () => {
  it("accepts a valid env with defaults", () => {
    const env = loadEnv(baseEnv);
    expect(env.NODE_ENV).toBe("development");
    expect(env.APPLICATION_DATABASE_URL).toContain("pooler");
    expect(env.MIGRATION_DATABASE_URL).toContain("direct");
    expect(env.ANTHROPIC_REASONING_MODEL).toBe("claude-sonnet-4-20250514");
    expect(env.OPENAI_EMBEDDING_MODEL).toBe("text-embedding-3-small");
  });

  it("fails when APPLICATION_DATABASE_URL is missing", () => {
    const { APPLICATION_DATABASE_URL: _omit, ...rest } = baseEnv;
    expect(() => loadEnv(rest)).toThrowError(/APPLICATION_DATABASE_URL/);
  });

  it("fails when MIGRATION_DATABASE_URL is missing", () => {
    const { MIGRATION_DATABASE_URL: _omit, ...rest } = baseEnv;
    expect(() => loadEnv(rest)).toThrowError(/MIGRATION_DATABASE_URL/);
  });

  it("coerces PORT to a number", () => {
    const env = loadEnv({ ...baseEnv, PORT: "4001" });
    expect(env.PORT).toBe(4001);
  });
});
