import { test, expect, type Page } from "@playwright/test";

/**
 * Admin console smoke. Stubs the four admin proxy routes so tests
 * run without a live apps/api. The PLAYWRIGHT=1 bypass in
 * middleware.ts uses a fixture session with role=owner, which gates
 * /app/admin server-side.
 *
 * Covers the critical behaviours:
 *  - page renders with five tabs
 *  - agent toggle PATCHes /api/admin/settings with the right body
 *  - kill switch requires a second confirmation click
 *  - health tab shows stats + the per-agent table
 *  - cost tab renders totals + entries
 *  - rollout slider PATCHes feature_rollout
 *  - evals tab shows regressions banner when present
 */

const DEFAULT_SETTINGS = {
  source_priority: ["internal", "apollo", "ga4", "resend"],
  enabled_agents: ["daily_brief", "follow_up"],
  daily_cost_limit: 5,
  kill_all_agents: false,
  feature_rollout: { voice_alpha: 25 },
  sharing_enabled: false,
};

async function stubSettings(
  page: Page,
  overrides?: Partial<typeof DEFAULT_SETTINGS>,
): Promise<Array<{ method: string; body: string }>> {
  const calls: Array<{ method: string; body: string }> = [];
  await page.route("**/api/admin/settings", async (route) => {
    const method = route.request().method();
    const body = route.request().postData() ?? "";
    calls.push({ method, body });
    if (method === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ settings: { ...DEFAULT_SETTINGS, ...(overrides ?? {}) } }),
      });
      return;
    }
    // PATCH: echo merged back
    const patch = body ? (JSON.parse(body) as Record<string, unknown>) : {};
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        settings: { ...DEFAULT_SETTINGS, ...(overrides ?? {}), ...patch },
      }),
    });
  });
  return calls;
}

async function stubHealth(page: Page): Promise<void> {
  await page.route("**/api/admin/health", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        window: { from: new Date().toISOString(), to: new Date().toISOString() },
        totalRuns: 42,
        completed: 40,
        failed: 2,
        failureRate: 0.0476,
        avgDurationSeconds: 3.5,
        totalCostUsd: 1.23,
        byAgent: [
          { agentName: "daily_brief", runs: 7, failures: 0, totalCostUsd: 0.21, avgDurationSeconds: 5.1 },
          { agentName: "research", runs: 12, failures: 1, totalCostUsd: 0.42, avgDurationSeconds: 4.2 },
        ],
      }),
    });
  });
}

async function stubCostLedger(page: Page): Promise<void> {
  await page.route("**/api/admin/cost-ledger*", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        window: { from: new Date().toISOString(), to: new Date().toISOString() },
        entries: [
          {
            id: "cl-1",
            operation: "llm.completion",
            provider: "anthropic",
            model: "claude-sonnet-4-20250514",
            agentRunId: "run-1",
            agentName: "daily_brief",
            units: 1200,
            unitKind: "tokens",
            costUsd: 0.04,
            occurredAt: new Date().toISOString(),
          },
        ],
        totals: { today: 0.04, week: 0.24, month: 1.23 },
      }),
    });
  });
}

async function stubEvals(page: Page, regressions: string[] = []): Promise<void> {
  await page.route("**/api/admin/evals/latest", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        status: "ok",
        results: {
          runAt: new Date().toISOString(),
          totalFixtures: 10,
          passed: 9,
          failed: 1,
          passRate: 0.9,
          regressions,
          fixtures: [
            { id: "eval_001", question: "Find Acme", passed: true },
            { id: "eval_002", question: "Which contact?", passed: true },
            {
              id: "eval_003",
              question: "Broken fixture",
              passed: false,
              errors: ["answer did not mention 'X'"],
            },
          ],
        },
      }),
    });
  });
}

test.describe("Admin console", () => {
  test("renders all five tabs when role=owner", async ({ page }) => {
    await stubSettings(page);
    await stubHealth(page);
    await stubCostLedger(page);
    await stubEvals(page);
    await page.goto("/app/admin");
    await expect(page.getByRole("heading", { name: "Admin" })).toBeVisible();
    for (const label of ["Agents", "Health", "Cost", "Rollout", "Evals"]) {
      await expect(page.getByRole("tab", { name: label })).toBeVisible();
    }
  });

  test("toggling an agent PATCHes /api/admin/settings", async ({ page }) => {
    const calls = await stubSettings(page);
    await page.goto("/app/admin");
    // Wait for initial GET.
    await page.getByRole("switch", { name: /Enable Research/i }).waitFor();
    const switchBefore = page.getByRole("switch", { name: /Enable Research/i });
    expect(await switchBefore.getAttribute("aria-checked")).toBe("false");
    await switchBefore.click();
    await expect.poll(() => calls.filter((c) => c.method === "PATCH").length).toBeGreaterThan(0);
    const patchCall = calls.find((c) => c.method === "PATCH");
    expect(patchCall).toBeDefined();
    const body = JSON.parse(patchCall!.body) as { enabled_agents: string[] };
    expect(body.enabled_agents).toContain("research");
    expect(body.enabled_agents).toContain("daily_brief");
    expect(body.enabled_agents).toContain("follow_up");
  });

  test("kill switch requires a second confirmation click", async ({ page }) => {
    const calls = await stubSettings(page);
    await page.goto("/app/admin");
    const engage = page.getByRole("button", { name: /Engage kill switch/i });
    await engage.waitFor();
    await engage.click();
    // Armed — Engage + Cancel buttons appear; no PATCH yet.
    await expect(page.getByRole("button", { name: "Engage" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Cancel" })).toBeVisible();
    expect(calls.filter((c) => c.method === "PATCH").length).toBe(0);
    await page.getByRole("button", { name: "Engage" }).click();
    await expect
      .poll(() => calls.filter((c) => c.method === "PATCH").length)
      .toBeGreaterThan(0);
    const patch = calls.find((c) => c.method === "PATCH");
    expect(JSON.parse(patch!.body)).toEqual({ kill_all_agents: true });
  });

  test("health tab renders stats + per-agent table", async ({ page }) => {
    await stubSettings(page);
    await stubHealth(page);
    await page.goto("/app/admin");
    await page.getByRole("tab", { name: "Health" }).click();
    await expect(page.getByText(/42/)).toBeVisible();
    await expect(page.getByText(/4\.8%|4\.76%|4\.7%/)).toBeVisible();
    await expect(
      page.locator('[data-table="health-by-agent"]'),
    ).toBeVisible();
    await expect(page.getByText("daily_brief").first()).toBeVisible();
  });

  test("cost tab renders totals + at least one entry row", async ({ page }) => {
    await stubSettings(page);
    await stubCostLedger(page);
    await page.goto("/app/admin");
    await page.getByRole("tab", { name: "Cost" }).click();
    await expect(page.locator('[data-table="cost-ledger"]')).toBeVisible();
    await expect(page.getByText("$0.04")).toBeVisible();
  });

  test("rollout slider PATCHes feature_rollout", async ({ page }) => {
    const calls = await stubSettings(page);
    await page.goto("/app/admin");
    await page.getByRole("tab", { name: "Rollout" }).click();
    const voice = page.locator('[data-feature="voice_alpha"]');
    const slider = voice.getByRole("slider");
    await slider.fill("75");
    await voice.getByRole("button", { name: "Save" }).click();
    await expect
      .poll(() => calls.filter((c) => c.method === "PATCH").length)
      .toBeGreaterThan(0);
    const patch = calls.find((c) => c.method === "PATCH");
    expect(patch).toBeDefined();
    const body = JSON.parse(patch!.body) as {
      feature_rollout: Record<string, number>;
    };
    expect(body.feature_rollout.voice_alpha).toBe(75);
  });

  test("evals tab renders a regression banner when results carry any", async ({
    page,
  }) => {
    await stubSettings(page);
    await stubEvals(page, ["eval_007", "eval_deal_002"]);
    await page.goto("/app/admin");
    await page.getByRole("tab", { name: "Evals" }).click();
    await expect(
      page.locator('[data-regressions="present"]'),
    ).toBeVisible();
    await expect(page.getByText("eval_007")).toBeVisible();
    await expect(page.getByText("eval_deal_002")).toBeVisible();
  });
});
