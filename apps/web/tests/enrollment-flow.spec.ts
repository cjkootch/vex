import { test, expect, type Page } from "@playwright/test";

/**
 * Sprint H — end-to-end coverage for the campaign enrollment flow
 * surfaces. Three slices:
 *
 *   1. Approvals inbox renders the Sprint F `campaign.enroll_batch`
 *      card correctly (recipient count, plan steps, rationale,
 *      fallback for older action types).
 *   2. Campaign detail's Plan tab accepts a new step via the inline
 *      form, wires the POST correctly, and refreshes the step list.
 *   3. Campaign detail's Enrollments tab renders the Sprint G
 *      click-to-expand branch-history timeline with the correct
 *      outcome palette.
 *
 * All API responses are stubbed via `page.route` — no apps/api
 * dependency. The PLAYWRIGHT=1 bypass in middleware skips auth.
 */

const CAMPAIGN_ID = "01HSEEDCPN0000000000000001";

// -----------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------

async function stubCampaignDetail(page: Page): Promise<void> {
  await page.route("**/api/marketing/campaigns/" + CAMPAIGN_ID, async (route) => {
    const method = route.request().method();
    if (method !== "GET") return route.continue();
    const now = new Date().toISOString();
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        campaign: {
          id: CAMPAIGN_ID,
          channel: "email",
          source: "resend",
          medium: "nurture",
          accountRef: null,
          spend: null,
          objective: "spring pricing check-in",
          status: "active",
          touchpointCount: 0,
          sent: 0,
          delivered: 0,
          opened: 0,
          clicked: 0,
          bounced: 0,
          createdAt: now,
          updatedAt: now,
          touchpoints: [],
        },
      }),
    });
  });
}

async function stubStepsEndpoint(
  page: Page,
  initialSteps: Array<Record<string, unknown>>,
): Promise<{
  getCalls: () => number;
  postCalls: () => Array<{ body: Record<string, unknown> }>;
}> {
  const getCalls = { n: 0 };
  const postCalls: Array<{ body: Record<string, unknown> }> = [];
  // Let the server return a mutable step list — when the test adds
  // a step via POST we push into the list so the next GET reflects it.
  const steps = [...initialSteps];
  await page.route(
    `**/api/marketing/campaigns/${CAMPAIGN_ID}/steps`,
    async (route) => {
      const method = route.request().method();
      if (method === "GET") {
        getCalls.n += 1;
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            steps,
            validation: steps.length === 0 ? "plan has no steps" : null,
          }),
        });
        return;
      }
      if (method === "POST") {
        const body = JSON.parse(route.request().postData() ?? "{}") as Record<
          string,
          unknown
        >;
        postCalls.push({ body });
        const now = new Date().toISOString();
        const created = {
          id: `01HSTUBSTP${String(steps.length + 1).padStart(18, "0")}`,
          campaignId: CAMPAIGN_ID,
          position: steps.length,
          channel: String(body["channel"] ?? "email"),
          delayAfterPriorMs: Number(body["delayAfterPriorMs"] ?? 0),
          templateRef: (body["templateRef"] as string | undefined) ?? null,
          gateConditionJson: {},
          tier: String(body["tier"] ?? "T2"),
          autoApprove: Boolean(body["autoApprove"] ?? false),
          createdAt: now,
          updatedAt: now,
        };
        steps.push(created);
        await route.fulfill({
          status: 201,
          contentType: "application/json",
          body: JSON.stringify({ step: created }),
        });
        return;
      }
      await route.continue();
    },
  );
  return {
    getCalls: () => getCalls.n,
    postCalls: () => postCalls,
  };
}

async function stubEnrollmentsEndpoint(
  page: Page,
  enrollments: Array<Record<string, unknown>>,
  counts: Record<string, number>,
): Promise<void> {
  await page.route(
    `**/api/marketing/campaigns/${CAMPAIGN_ID}/enrollments*`,
    async (route) => {
      if (route.request().method() !== "GET") return route.continue();
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ enrollments, counts }),
      });
    },
  );
}

async function stubApprovals(
  page: Page,
  approvals: Array<Record<string, unknown>>,
): Promise<void> {
  await page.route("**/api/approvals**", async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ approvals }),
    });
  });
}

// -----------------------------------------------------------------
// Approvals inbox — campaign.enroll_batch card
// -----------------------------------------------------------------

test.describe("Approvals — campaign.enroll_batch card", () => {
  test("renders recipient count + plan steps + rationale", async ({ page }) => {
    await stubApprovals(page, [
      {
        id: "01HAPP00000000000000000001",
        actionType: "campaign.enroll_batch",
        decision: "pending",
        createdAt: new Date().toISOString(),
        proposedPayload: {
          tier: "T2",
          campaign_id: CAMPAIGN_ID,
          contact_ids: ["c1", "c2", "c3", "c4"],
          recipient_count: 4,
          plan_summary: [
            {
              position: 0,
              channel: "email",
              tier: "T2",
              auto_approve: true,
              delay_after_prior_ms: 0,
            },
            {
              position: 1,
              channel: "sms",
              tier: "T2",
              auto_approve: false,
              delay_after_prior_ms: 3 * 86_400_000,
            },
          ],
          rationale: "Q2 expansion targets",
        },
      },
    ]);

    await page.goto("/app/approvals");
    const row = page.getByTestId("approval-row");
    await expect(row).toHaveCount(1);
    await expect(row.getByTestId("enroll-batch-heading")).toContainText(
      "4 contacts",
    );
    const steps = row.getByTestId("enroll-batch-step");
    await expect(steps).toHaveCount(2);
    await expect(steps.nth(0)).toContainText("email");
    await expect(steps.nth(0)).toContainText("auto-approve");
    await expect(steps.nth(1)).toContainText("sms");
    await expect(steps.nth(1)).toContainText("wait 3d");
    // Rationale surfaces as quoted text under the step list.
    await expect(row).toContainText("Q2 expansion targets");
  });

  test("singular 'contact' for a single-recipient batch", async ({ page }) => {
    await stubApprovals(page, [
      {
        id: "01HAPP00000000000000000002",
        actionType: "campaign.enroll_batch",
        decision: "pending",
        createdAt: new Date().toISOString(),
        proposedPayload: {
          tier: "T2",
          campaign_id: CAMPAIGN_ID,
          contact_ids: ["c1"],
          recipient_count: 1,
          plan_summary: [
            {
              position: 0,
              channel: "email",
              tier: "T2",
              auto_approve: false,
            },
          ],
        },
      },
    ]);
    await page.goto("/app/approvals");
    await expect(
      page.getByTestId("approval-row").getByTestId("enroll-batch-heading"),
    ).toContainText("1 contact");
  });

  test("older follow_up.suggestion cards still render subject + opening", async ({
    page,
  }) => {
    await stubApprovals(page, [
      {
        id: "01HAPP00000000000000000003",
        actionType: "follow_up.suggestion",
        decision: "pending",
        createdAt: new Date().toISOString(),
        proposedPayload: {
          subject_type: "lead",
          subject_id: "01HSEEDDEA0000000000000001",
          subject_line: "Quick check-in on the Acme proposal",
          opening_line:
            "Hey — wanted to follow up on the deck we shared last week.",
          channel: "email",
          tier: "T1",
        },
      },
    ]);
    await page.goto("/app/approvals");
    const row = page.getByTestId("approval-row");
    await expect(row).toContainText("Quick check-in on the Acme proposal");
    await expect(row).toContainText("Hey — wanted to follow up");
    // enroll-batch testids should NOT be present on this card.
    await expect(row.getByTestId("enroll-batch-heading")).toHaveCount(0);
  });
});

// -----------------------------------------------------------------
// Campaign detail — Plan tab
// -----------------------------------------------------------------

test.describe("Campaign detail — Plan tab", () => {
  test("adding a step fires POST and refreshes the list", async ({ page }) => {
    await stubCampaignDetail(page);
    const recorder = await stubStepsEndpoint(page, []);
    await stubEnrollmentsEndpoint(page, [], {
      enrolled: 0,
      completed: 0,
      paused: 0,
      unsubscribed: 0,
      errored: 0,
    });

    await page.goto(`/app/marketing/${CAMPAIGN_ID}`);
    await page.getByRole("tab", { name: "Plan" }).click();

    // Initial state: validation warning for empty plan.
    await expect(page.getByText("plan has no steps")).toBeVisible();

    // Fill the form and submit.
    await page.getByLabel(/^Channel$/).selectOption("email");
    await page.getByLabel(/^Wait \(hours\)$/).fill("2");
    await page.getByLabel(/^Tier$/).selectOption("T2");
    await page.getByLabel(/^Template ref$/).fill("tpl_welcome");
    await page.getByTestId("add-step-submit").click();

    // Wait for the refetch to reflect the new step.
    await expect(page.getByText(/#0/)).toBeVisible();
    await expect(page.getByText(/tpl_welcome/)).toBeVisible();

    // POST body carried the right shape.
    const posts = recorder.postCalls();
    expect(posts).toHaveLength(1);
    expect(posts[0]!.body).toMatchObject({
      position: 0,
      channel: "email",
      tier: "T2",
      templateRef: "tpl_welcome",
      // 2 hours → 7,200,000 ms
      delayAfterPriorMs: 7_200_000,
    });
  });
});

// -----------------------------------------------------------------
// Campaign detail — Enrollments tab branch-history timeline
// -----------------------------------------------------------------

test.describe("Campaign detail — Enrollments tab", () => {
  const enrollments = [
    {
      id: "01HSTUBENR0000000000000001",
      campaignId: CAMPAIGN_ID,
      contactId: "01HSEEDCNT0000000000000001",
      currentStep: 2,
      state: "enrolled",
      lastEventAt: new Date().toISOString(),
      branchHistoryJson: [
        {
          step_id: "s0",
          position: 0,
          outcome: "auto_approved",
          approval_id: "01HAPP0000000000000000001A",
        },
        {
          step_id: "s1",
          position: 1,
          outcome: "skipped_gate",
          gate_reason: "opened_in_last_days: no hit in last 7d",
        },
      ],
      error: null,
      createdAt: new Date(Date.now() - 3_600_000).toISOString(),
    },
    {
      // Flat row without branch history — should not be expandable.
      id: "01HSTUBENR0000000000000002",
      campaignId: CAMPAIGN_ID,
      contactId: "01HSEEDCNT0000000000000002",
      currentStep: 0,
      state: "enrolled",
      lastEventAt: null,
      branchHistoryJson: [],
      error: null,
      createdAt: new Date().toISOString(),
    },
  ];

  test("state-counts strip reflects the counts payload", async ({ page }) => {
    await stubCampaignDetail(page);
    await stubStepsEndpoint(page, [
      {
        id: "s0",
        campaignId: CAMPAIGN_ID,
        position: 0,
        channel: "email",
        delayAfterPriorMs: 0,
        templateRef: null,
        gateConditionJson: {},
        tier: "T2",
        autoApprove: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ]);
    await stubEnrollmentsEndpoint(page, enrollments, {
      enrolled: 2,
      completed: 5,
      paused: 1,
      unsubscribed: 0,
      errored: 0,
    });

    await page.goto(`/app/marketing/${CAMPAIGN_ID}`);
    await page.getByRole("tab", { name: "Enrollments" }).click();
    await expect(page.getByText(/Enrolled:.*2/)).toBeVisible();
    await expect(page.getByText(/Completed:.*5/)).toBeVisible();
    await expect(page.getByText(/Paused:.*1/)).toBeVisible();
  });

  test("expanding a row reveals the branch-history timeline with outcome badges", async ({
    page,
  }) => {
    await stubCampaignDetail(page);
    await stubStepsEndpoint(page, []);
    await stubEnrollmentsEndpoint(page, enrollments, {
      enrolled: 2,
      completed: 0,
      paused: 0,
      unsubscribed: 0,
      errored: 0,
    });

    await page.goto(`/app/marketing/${CAMPAIGN_ID}`);
    await page.getByRole("tab", { name: "Enrollments" }).click();

    const rows = page.getByTestId("enrollment-row");
    await expect(rows).toHaveCount(2);

    // Timeline starts hidden.
    await expect(page.getByTestId("branch-history-timeline")).toHaveCount(0);

    // First row has history → expand.
    await rows.nth(0).click();
    const timeline = page.getByTestId("branch-history-timeline");
    await expect(timeline).toBeVisible();
    await expect(timeline).toContainText("auto_approved");
    await expect(timeline).toContainText("skipped_gate");
    await expect(timeline).toContainText(
      "opened_in_last_days: no hit in last 7d",
    );

    // Second row has empty history — clicking it should not open a
    // second timeline (aria-expanded stays false, button disabled).
    await rows.nth(1).click();
    await expect(page.getByTestId("branch-history-timeline")).toHaveCount(1);
  });
});
