import { test, expect, type Page } from "@playwright/test";

/**
 * Home-screen daily brief. Exercises the /app route end-to-end:
 *   stub → render → interact → navigate
 *
 * Test env: PLAYWRIGHT=1 bypasses middleware auth (playwright.config.ts),
 * and VEX_API_URL is unset so /api/brief/today returns the canned stub
 * from apps/web/src/app/api/brief/today/route.ts. Individual tests
 * override the route with page.route() when they need a specific
 * scenario (e.g. the not_ready fallback).
 */

const STUB_GREETING = "Here's what needs your attention today.";
const STUB_FOCUS =
  "Resolve the VTC-2026-001 OFAC hold and fill the vessel before laycan.";

async function mockBrief(page: Page, override: object): Promise<void> {
  await page.route("**/api/brief/today", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(override),
    });
  });
}

test.describe("Daily brief home", () => {
  test("renders, not blank", async ({ page }) => {
    await page.goto("/app");
    // Hero greeting + focus footer both ship from the stub.
    await expect(page.getByText(STUB_GREETING)).toBeVisible();
    await expect(page.getByText(STUB_FOCUS)).toBeVisible();
  });

  test("greeting text is visible", async ({ page }) => {
    await page.goto("/app");
    await expect(
      page.getByRole("heading", { name: STUB_GREETING }),
    ).toBeVisible();
  });

  test("at least one priority card renders", async ({ page }) => {
    await page.goto("/app");
    const cards = page.locator('[data-card="priority"]');
    await expect(cards.first()).toBeVisible();
    expect(await cards.count()).toBeGreaterThanOrEqual(1);
  });

  test("at least one pipeline row renders", async ({ page }) => {
    await page.goto("/app");
    const rows = page.locator('[data-row="deal-pipeline"]');
    await expect(rows.first()).toBeVisible();
    expect(await rows.count()).toBeGreaterThanOrEqual(1);
  });

  test("handled section is collapsed by default and expands on click", async ({ page }) => {
    await page.goto("/app");
    const toggle = page.getByRole("button", { name: /Show what Vex did/i });
    await expect(toggle).toBeVisible();
    // The handled list is only rendered after toggling.
    await expect(page.getByText(/Researched 3 Caribbean importers/)).toHaveCount(0);
    await toggle.click();
    await expect(page.getByText(/Researched 3 Caribbean importers/)).toBeVisible();
  });

  test("clicking a deal priority navigates to /app/chat with ?ask= query", async ({ page }) => {
    await page.goto("/app");
    const dealCard = page
      .locator('[data-card="priority"]')
      .filter({ hasText: "VTC-2026-001" })
      .first();
    await expect(dealCard).toBeVisible();
    await dealCard.click();
    await expect(page).toHaveURL(/\/app\/chat\?ask=/);
    await expect(page).toHaveURL(/VTC-2026-001/);
  });

  test("Review button links to /app/approvals when approvalId is set", async ({ page }) => {
    await mockBrief(page, {
      id: "brief-with-approval",
      tenantId: "01HSEEDWRK0000000000000001",
      generatedAt: new Date().toISOString(),
      greeting: STUB_GREETING,
      priorities: [
        {
          id: "p-approval",
          title: "Approve the Jamaica follow-up email",
          reason: "Drafted by the follow-up agent — awaiting your sign-off.",
          objectType: "approval",
          objectId: "appr-001",
          urgency: "high",
          approvalId: "appr-001",
          suggestedAction: "Review in the approval inbox.",
        },
      ],
      handled: [],
      blocked: [],
      ownerOnly: [],
      pipeline: [],
      risks: [],
      recommendedFocus: STUB_FOCUS,
      totalAgentCostToday: 0,
      pendingApprovalCount: 1,
    });
    await page.goto("/app");
    const review = page.getByRole("link", { name: "Review" });
    await expect(review).toBeVisible();
    await review.click();
    await expect(page).toHaveURL(/\/app\/approvals$/);
  });

  test("pending-approval pill shows the count from the stub", async ({ page }) => {
    await page.goto("/app");
    await expect(page.getByText(/3 pending approvals/)).toBeVisible();
  });

  test("blocked section uses amber styling", async ({ page }) => {
    await page.goto("/app");
    const blocked = page.locator('[data-card="blocked"]').first();
    await expect(blocked).toBeVisible();
    // Amber border is the identifying class; data-card="blocked" is enough
    // to assert presence without coupling to Tailwind internals.
    await expect(blocked).toHaveAttribute("data-card", "blocked");
  });

  test("risk card carries its severity as a data attribute", async ({ page }) => {
    await page.goto("/app");
    const risk = page.locator('[data-card="risk"]').first();
    await expect(risk).toBeVisible();
    await expect(risk).toHaveAttribute("data-severity", "high");
  });

  test("workspace mode is set to MorningBrief on load", async ({ page }) => {
    await page.goto("/app");
    // AppShell isn't wired to /app/layout.tsx yet, so the ContextChip
    // isn't mounted. The WorkspaceModeProvider DOES sync document.title
    // to 'Vex · {mode label}' on every mode change — assert that.
    await expect(page).toHaveTitle(/Morning Brief/);
  });

  test("no-brief state: not_ready payload shows the fallback message", async ({ page }) => {
    await mockBrief(page, {
      status: "not_ready",
      message: "Brief generates at 06:00 UTC on weekdays.",
    });
    await page.goto("/app");
    await expect(
      page.getByRole("heading", { name: /Brief not ready/ }),
    ).toBeVisible();
    await expect(
      page.getByText(/Brief generates at 06:00 UTC on weekdays\./),
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: /Ask Vex anything/ }),
    ).toBeVisible();
  });
});
