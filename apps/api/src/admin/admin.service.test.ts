import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFile as fsReadFile } from "node:fs/promises";
import { AdminService, type SettingsPatch } from "./admin.service.js";

/**
 * AdminService covers settings CRUD + eval-results file reads. The
 * health + cost ledger queries are pure Drizzle passthroughs and are
 * covered by the upstream integration tests (they'd require real
 * tables to mock faithfully).
 */

const TENANT = "01HSEEDWRK0000000000000001";
const WORKSPACE = TENANT;

vi.mock("@vex/db", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("@vex/db");
  return {
    ...actual,
    withTenant: async (
      _db: unknown,
      _tenantId: string,
      fn: (tx: unknown) => Promise<unknown>,
    ) => fn({ __fake_tx: true }),
  };
});

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(),
}));

const currentSettings = {
  source_priority: ["internal", "apollo"],
  enabled_agents: ["daily_brief", "follow_up"],
  daily_cost_limit: 5,
  kill_all_agents: false,
  feature_rollout: { voice_alpha: 10 },
};

function buildService(overrides: { currentSettings?: unknown } = {}) {
  const getSettings = vi
    .fn()
    .mockResolvedValue(
      overrides.currentSettings === undefined
        ? currentSettings
        : overrides.currentSettings,
    );
  const updateSettingsRepo = vi.fn().mockImplementation(async (_db, _id, settings) => ({
    id: WORKSPACE,
    settings,
    updatedAt: new Date("2026-10-01T00:00:00Z"),
  }));
  const eventsInsertIfNotExists = vi.fn().mockResolvedValue(undefined);

  const service = new AdminService(
    {} as never, // db
    { getSettings, updateSettings: updateSettingsRepo } as never,
    { insertIfNotExists: eventsInsertIfNotExists } as never,
    "/tmp/eval-results.json", // evalResultsPath
  );
  return {
    service,
    mocks: { getSettings, updateSettingsRepo, eventsInsertIfNotExists },
  };
}

describe("AdminService.getSettings", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns the current settings blob", async () => {
    const { service } = buildService();
    expect(await service.getSettings(WORKSPACE)).toEqual(currentSettings);
  });

  it("throws 404 when the workspace does not exist", async () => {
    const { service } = buildService({ currentSettings: null });
    await expect(service.getSettings(WORKSPACE)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

describe("AdminService.updateSettings", () => {
  beforeEach(() => vi.clearAllMocks());

  it("refuses a cross-tenant write (tenantId !== workspaceId)", async () => {
    const { service, mocks } = buildService();
    await expect(
      service.updateSettings("other-tenant", WORKSPACE, {}, "user-1"),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(mocks.updateSettingsRepo).not.toHaveBeenCalled();
    expect(mocks.eventsInsertIfNotExists).not.toHaveBeenCalled();
  });

  it("merges the patch into the current settings and writes + audits", async () => {
    const { service, mocks } = buildService();
    const patch: SettingsPatch = {
      kill_all_agents: true,
      daily_cost_limit: 12,
      feature_rollout: { voice_alpha: 50, pstn_calls: 25 },
    };
    const next = await service.updateSettings(
      TENANT,
      WORKSPACE,
      patch,
      "01HSEEDPRS0000000000000001",
    );
    expect(next).toEqual({
      ...currentSettings,
      kill_all_agents: true,
      daily_cost_limit: 12,
      feature_rollout: { voice_alpha: 50, pstn_calls: 25 },
    });
    expect(mocks.updateSettingsRepo).toHaveBeenCalledOnce();
    expect(mocks.eventsInsertIfNotExists).toHaveBeenCalledOnce();
    const event = mocks.eventsInsertIfNotExists.mock.calls[0]![2];
    expect(event.verb).toBe("admin.settings.updated");
    expect(event.metadata.patch).toEqual(patch);
    expect(event.metadata.before).toEqual(currentSettings);
    expect(event.metadata.after).toEqual(next);
  });

  it("no-op patch still writes an audit event", async () => {
    const { service, mocks } = buildService();
    await service.updateSettings(TENANT, WORKSPACE, {}, "user-1");
    expect(mocks.eventsInsertIfNotExists).toHaveBeenCalledOnce();
  });
});

describe("AdminService.getLatestEvalResults", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns null when the results file does not exist yet", async () => {
    const err: NodeJS.ErrnoException = new Error("ENOENT");
    err.code = "ENOENT";
    vi.mocked(fsReadFile).mockRejectedValueOnce(err);
    const { service } = buildService();
    expect(await service.getLatestEvalResults()).toBeNull();
  });

  it("parses JSON when the file is present", async () => {
    const payload = {
      runAt: "2026-10-01T00:00:00Z",
      totalFixtures: 20,
      passed: 18,
      failed: 2,
      passRate: 0.9,
      fixtures: [],
    };
    vi.mocked(fsReadFile).mockResolvedValueOnce(JSON.stringify(payload));
    const { service } = buildService();
    expect(await service.getLatestEvalResults()).toEqual(payload);
  });

  it("re-throws non-ENOENT errors", async () => {
    const err: NodeJS.ErrnoException = new Error("EACCES");
    err.code = "EACCES";
    vi.mocked(fsReadFile).mockRejectedValueOnce(err);
    const { service } = buildService();
    await expect(service.getLatestEvalResults()).rejects.toThrow(/EACCES/);
  });
});
