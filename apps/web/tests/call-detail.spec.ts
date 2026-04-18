import { test, expect, type Page } from "@playwright/test";

/**
 * Sprint I — call detail + backup-request surfaces.
 *
 * Three slices:
 *   1. Approvals inbox renders the new `call.request_backup` card
 *      (duration badge + reason + Join-call CTA wired to detail page).
 *   2. Call detail page renders callee, status pill, live-duration
 *      counter that reflects the server-supplied startedAt, and a
 *      Request-backup button that POSTs and transitions state.
 *   3. Request-backup idempotency — a `{ existed: true }` response
 *      swaps the button label to "Already pinged" without flipping
 *      to an error state.
 *
 * All API responses stubbed via page.route — no apps/api needed.
 */

const WORKFLOW_ID = "outbound-call-01HSTUBRUN0000000000000099";

// -----------------------------------------------------------------
// Shared stubs
// -----------------------------------------------------------------

async function stubCallDetail(
  page: Page,
  overrides: {
    status?: string;
    startedAtMsAgo?: number;
    durationSeconds?: number | null;
  } = {},
): Promise<void> {
  const now = Date.now();
  await page.route(`**/api/calls/${WORKFLOW_ID}`, async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const startedAt = new Date(now - (overrides.startedAtMsAgo ?? 125_000)).toISOString();
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        workflowId: WORKFLOW_ID,
        approval: {
          id: "01HAPP00000000000000000099",
          decision: "approved",
        },
        activity: {
          id: "01HSTUBACT00000000000000AA",
          callSid: "CAXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
          status: overrides.status ?? "in-progress",
          durationSeconds: overrides.durationSeconds ?? null,
          transcriptRef: null,
          startedAt,
        },
        callee: {
          id: "01HSEEDCNT0000000000000001",
          fullName: "Dana Reyes",
          phone: "+15555551234",
        },
        workflow: { status: "RUNNING" },
      }),
    });
  });
}

async function stubRequestBackup(
  page: Page,
  options: { existed?: boolean; failOnce?: boolean } = {},
): Promise<{ callCount: () => number; bodies: () => string[] }> {
  const bodies: string[] = [];
  let failedYet = false;
  await page.route(
    `**/api/calls/${WORKFLOW_ID}/request-backup`,
    async (route) => {
      const method = route.request().method();
      if (method !== "POST") return route.continue();
      bodies.push(route.request().postData() ?? "");
      if (options.failOnce && !failedYet) {
        failedYet = true;
        await route.fulfill({
          status: 500,
          contentType: "application/json",
          body: JSON.stringify({ error: "boom" }),
        });
        return;
      }
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({
          approvalId: "01HAPP_BACKUP_01HSTUBRUN0099",
          existed: options.existed ?? false,
        }),
      });
    },
  );
  return {
    callCount: () => bodies.length,
    bodies: () => bodies,
  };
}

// -----------------------------------------------------------------
// Approvals inbox — call.request_backup card
// -----------------------------------------------------------------

test.describe("Approvals — call.request_backup card", () => {
  test("renders duration + reason + Join-call CTA wired to detail page", async ({
    page,
  }) => {
    await page.route("**/api/approvals**", async (route) => {
      if (route.request().method() !== "GET") return route.continue();
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          approvals: [
            {
              id: "01HAPP00000000000000000001",
              actionType: "call.request_backup",
              decision: "pending",
              createdAt: new Date().toISOString(),
              proposedPayload: {
                tier: "T2",
                workflow_id: WORKFLOW_ID,
                call_sid: "CAXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
                duration_at_request_seconds: 185,
                reason: "caller asked to speak to a manager",
              },
            },
          ],
        }),
      });
    });

    await page.goto("/app/approvals");
    const row = page.getByTestId("approval-row");
    await expect(row).toHaveCount(1);
    await expect(row.getByTestId("call-backup-heading")).toContainText(
      "3m 5s on call",
    );
    await expect(row).toContainText("caller asked to speak to a manager");

    const join = row.getByTestId("call-backup-join");
    await expect(join).toHaveAttribute(
      "href",
      `/app/calls/${WORKFLOW_ID}`,
    );
  });

  test("short-duration calls render the singular 's' suffix", async ({ page }) => {
    await page.route("**/api/approvals**", async (route) => {
      if (route.request().method() !== "GET") return route.continue();
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          approvals: [
            {
              id: "01HAPP00000000000000000002",
              actionType: "call.request_backup",
              decision: "pending",
              createdAt: new Date().toISOString(),
              proposedPayload: {
                tier: "T2",
                workflow_id: WORKFLOW_ID,
                duration_at_request_seconds: 42,
              },
            },
          ],
        }),
      });
    });
    await page.goto("/app/approvals");
    await expect(
      page.getByTestId("call-backup-heading"),
    ).toContainText("42s on call");
  });
});

// -----------------------------------------------------------------
// Call detail page
// -----------------------------------------------------------------

test.describe("Call detail page", () => {
  test("renders callee, status pill, live duration, and pulse", async ({ page }) => {
    // 125s ago → MM:SS formatter says "02:05".
    await stubCallDetail(page, { startedAtMsAgo: 125_000 });
    await page.goto(`/app/calls/${WORKFLOW_ID}`);

    await expect(page.getByRole("heading", { name: "Dana Reyes" })).toBeVisible();
    await expect(page.getByText("+15555551234")).toBeVisible();
    await expect(page.getByText("in-progress")).toBeVisible();

    // Live-duration counter formats MM:SS and reflects the tick seed.
    const duration = page.getByTestId("live-duration");
    await expect(duration).toBeVisible();
    await expect(duration).toContainText(/^\d{1,2}:\d{2}$/);
    const seconds = Number(
      await duration.getAttribute("data-live-seconds"),
    );
    expect(seconds).toBeGreaterThanOrEqual(124);
    expect(seconds).toBeLessThanOrEqual(127);

    await expect(page.getByTestId("live-pulse")).toBeVisible();
  });

  test("terminal status suppresses the pulse and disables the backup button", async ({ page }) => {
    await stubCallDetail(page, {
      status: "completed",
      durationSeconds: 240,
    });
    await page.goto(`/app/calls/${WORKFLOW_ID}`);

    await expect(page.getByText("completed")).toBeVisible();
    await expect(page.getByTestId("live-pulse")).toHaveCount(0);
    const btn = page.getByTestId("request-backup");
    await expect(btn).toBeDisabled();
    // Uses server-supplied durationSeconds, not the tick clock.
    await expect(page.getByTestId("live-duration")).toHaveAttribute(
      "data-live-seconds",
      "240",
    );
    await expect(page.getByTestId("live-duration")).toContainText("04:00");
  });

  test("request-backup button POSTs then flips to confirmation state", async ({
    page,
  }) => {
    await stubCallDetail(page);
    const recorder = await stubRequestBackup(page);
    await page.goto(`/app/calls/${WORKFLOW_ID}`);

    const btn = page.getByTestId("request-backup");
    await expect(btn).toHaveText("Request backup");
    await btn.click();
    await expect(btn).toHaveText("Backup requested");
    await expect(btn).toBeDisabled();
    expect(recorder.callCount()).toBe(1);

    // Confirmation banner with a link to the inbox renders.
    await expect(
      page.getByRole("link", { name: "approvals inbox" }),
    ).toBeVisible();
  });

  test("idempotent response (`existed: true`) surfaces as 'Already pinged'", async ({ page }) => {
    await stubCallDetail(page);
    await stubRequestBackup(page, { existed: true });
    await page.goto(`/app/calls/${WORKFLOW_ID}`);

    await page.getByTestId("request-backup").click();
    await expect(page.getByTestId("request-backup")).toHaveText("Already pinged");
  });
});
