import { test, expect, type Page } from "@playwright/test";

/**
 * Sprint 12 calls surface smoke. Exercises the /app/calls page + the
 * InitiateCallButton two-click flow against the local-dev stub that
 * /api/calls/* returns when VEX_API_URL is unset.
 */

async function mockAgentRuns(page: Page, runs: unknown[]): Promise<void> {
  await page.route("**/api/agent-runs*", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ runs }),
    });
  });
}

async function mockApprovals(page: Page, approvals: unknown[]): Promise<void> {
  await page.route("**/api/approvals*", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ approvals }),
    });
  });
}

test.describe("Calls page", () => {
  test("renders with empty state when there are no calls or approvals", async ({
    page,
  }) => {
    await mockAgentRuns(page, []);
    await mockApprovals(page, []);
    await page.goto("/app/calls");
    await expect(
      page.getByRole("heading", { name: "Calls" }),
    ).toBeVisible();
    await expect(
      page.getByText(/No outbound calls yet/i),
    ).toBeVisible();
  });

  test("shows a pending-approval card when an outbound_call approval is queued", async ({
    page,
  }) => {
    await mockAgentRuns(page, []);
    await mockApprovals(page, [
      {
        id: "appr-test-1",
        actionType: "outbound_call",
        decision: "pending",
        createdAt: new Date(Date.now() - 2 * 60_000).toISOString(),
        agentRunId: "run-1",
        proposedPayload: {
          tier: "T3",
          workflow_id: "outbound-call-run-1",
          contact_id: "contact-1",
          to_number: "+15005550006",
          initiated_by: "user-1",
        },
      },
    ]);
    await page.goto("/app/calls");
    await expect(
      page.getByRole("heading", {
        name: /Outbound call to \+15005550006/i,
      }),
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Review approval" }),
    ).toHaveAttribute("href", "/app/approvals");
  });

  test("shows an active-call row with live indicator", async ({ page }) => {
    await mockAgentRuns(page, [
      {
        id: "run-active-1",
        agent_name: "outbound_call",
        status: "running",
        started_at: new Date(Date.now() - 60_000).toISOString(),
        finished_at: null,
        cost_usd: 0,
        error: null,
        has_approval: true,
        approval_status: "approved",
        summary: "Calling Massy procurement lead",
      },
    ]);
    await mockApprovals(page, []);
    await page.goto("/app/calls");
    await expect(page.getByText(/In progress/i)).toBeVisible();
    await expect(page.getByText("Calling Massy procurement lead")).toBeVisible();
    // Details link goes to /app/calls/:id
    await expect(
      page.getByRole("link", { name: /Details/i }).first(),
    ).toHaveAttribute("href", "/app/calls/run-active-1");
  });

  test("shows a completed-call row with transcript link", async ({ page }) => {
    await mockAgentRuns(page, [
      {
        id: "run-done-1",
        agent_name: "outbound_call",
        status: "completed",
        started_at: new Date(Date.now() - 10 * 60_000).toISOString(),
        finished_at: new Date(Date.now() - 5 * 60_000).toISOString(),
        cost_usd: 0.12,
        error: null,
        has_approval: true,
        approval_status: "approved",
        summary: "Massy 5min call — next step scheduled",
      },
    ]);
    await mockApprovals(page, []);
    await page.goto("/app/calls");
    await expect(page.getByText(/Completed/)).toBeVisible();
    await expect(
      page.getByText("Massy 5min call — next step scheduled"),
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: /Transcript/i }),
    ).toHaveAttribute(
      "href",
      "/app/calls/run-done-1/transcript",
    );
  });

  test("InitiateCallButton arms on first click and cancels on second", async ({
    page,
  }) => {
    await mockAgentRuns(page, []);
    await mockApprovals(page, []);
    await page.goto("/app/calls");
    const btn = page.getByRole("button", { name: /Initiate call/i });
    await expect(btn).toBeVisible();
    await btn.click();
    // Armed state exposes two buttons: Confirm + Cancel
    await expect(
      page.getByRole("button", { name: "Confirm" }),
    ).toBeVisible();
    const cancel = page.getByRole("button", { name: "Cancel" });
    await expect(cancel).toBeVisible();
    await cancel.click();
    // Back to idle
    await expect(
      page.getByRole("button", { name: /Initiate call/i }),
    ).toBeVisible();
  });

  test("InitiateCallButton confirm posts to /api/calls and shows Pending approval", async ({
    page,
  }) => {
    await mockAgentRuns(page, []);
    await mockApprovals(page, []);
    await page.route("**/api/calls", async (route) => {
      expect(route.request().method()).toBe("POST");
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          workflow_id: "outbound-call-test-wf",
          approval_id: "test-approval",
          status: "pending_approval",
        }),
      });
    });
    await page.goto("/app/calls");
    await page.getByRole("button", { name: /Initiate call/i }).click();
    await page.getByRole("button", { name: "Confirm" }).click();
    await expect(page.getByText("Pending approval")).toBeVisible();
    await expect(
      page.getByRole("link", { name: /Review/ }),
    ).toHaveAttribute("href", "/app/approvals");
  });

  test("InitiateCallButton surfaces a friendly 403 message when T3 is disabled", async ({
    page,
  }) => {
    await mockAgentRuns(page, []);
    await mockApprovals(page, []);
    await page.route("**/api/calls", async (route) => {
      await route.fulfill({
        status: 403,
        contentType: "application/json",
        body: JSON.stringify({
          message:
            "outbound_call is disabled for this workspace; enable it in settings.enabled_agents",
        }),
      });
    });
    await page.goto("/app/calls");
    await page.getByRole("button", { name: /Initiate call/i }).click();
    await page.getByRole("button", { name: "Confirm" }).click();
    await expect(page.getByText(/Call blocked:/)).toBeVisible();
    await expect(page.getByText(/outbound_call is disabled/i)).toBeVisible();
  });
});
