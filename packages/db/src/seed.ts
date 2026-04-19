// `pg` is CommonJS; Node's strict ESM resolver can't pull named exports off it.
import pg from "pg";
const { Pool } = pg;
import { drizzle } from "drizzle-orm/node-postgres";
import { loadEnv } from "@vex/config";
import { createId } from "@vex/domain";
import * as schema from "./schema/index.js";
import {
  calculateFuelDeal,
  type FuelDealInputs,
} from "./deals/calculator.js";
import {
  SEED_ADMIN_USER_ID,
  SEED_CAMPAIGN_IDS,
  SEED_CONTACT_IDS,
  SEED_COUNTERPARTY_SCORE_IDS,
  SEED_EVENT_IDS,
  SEED_FUEL_DEAL_CASHFLOW_IDS,
  SEED_FUEL_DEAL_COST_STACK_IDS,
  SEED_FUEL_DEAL_IDS,
  SEED_FUEL_DEAL_REFS,
  SEED_FUEL_DEAL_SCENARIO_IDS,
  SEED_FUEL_MARKET_RATE_IDS,
  SEED_ORG_IDS,
  SEED_RAW_EVENT_IDS,
  SEED_SUMMARY_IDS,
  SEED_TOUCHPOINT_IDS,
  SEED_WORKSPACE_ID,
} from "./seed-ids.js";

/**
 * Seed the demo tenant "Acme Demo".
 *
 * Run via `pnpm --filter=@vex/db seed`. Uses MIGRATION_DATABASE_URL (direct
 * Neon endpoint) because the pooler doesn't reliably buffer the volume of
 * inserts.
 */
async function main(): Promise<void> {
  const env = loadEnv();
  const pool = new Pool({ connectionString: env.MIGRATION_DATABASE_URL });

  const tenantId = SEED_WORKSPACE_ID;
  const now = new Date();

  const client = await pool.connect();
  try {
    // Seed needs to write rows that span tenants and bypass the RLS WITH
    // CHECK constraint on every business table. vex_migrator (BYPASSRLS) is
    // the same role the migration runner uses for the same reason.
    try {
      await client.query("SET ROLE vex_migrator");
    } catch {
      // Pre-Sprint-3 deployments don't have the role yet — RLS isn't enabled
      // either, so the seed can run as the connection's default role.
    }

    // Idempotent reset — delete every row whose id starts with the
    // `01HSEED` seed prefix before inserting. Real user-created rows
    // use createId() which generates Date.now()-prefixed ULIDs that
    // never start with `01HSEED`, so this is safe against hand-entered
    // data. Order respects FK dependencies:
    //   - scenarios / cost-stack / cashflow / documents / counterparty
    //     all reference fuel_deals → delete first
    //   - fuel_deals references organizations → delete before orgs
    //   - contact_org_memberships CASCADEs on contact/org delete
    //   - contacts references organizations → delete before orgs
    //   - everything references workspace via tenant_id (text, not FK)
    //     so workspace can be deleted last
    // Diagnostic — print every public table present. Useful when a
    // migration didn't land and the seed hits a missing-relation error.
    const tableList = await client.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name`,
    );
    // eslint-disable-next-line no-console
    console.log(
      `seed: public tables (${tableList.rows.length}): ${tableList.rows
        .map((r) => r.table_name)
        .join(", ")}`,
    );

    const reset = async (
      table: string,
      column: string = "id",
    ): Promise<void> => {
      try {
        await client.query(
          `DELETE FROM ${table} WHERE ${column} LIKE '01HSEED%'`,
        );
      } catch (err) {
        // Swallow "relation does not exist" (42P01) so a partial
        // migration state doesn't block the rest of the reset. Any
        // such missing table will re-surface when the seed tries to
        // INSERT into it — at which point the failure mode is
        // obvious and migrate-then-seed is the answer.
        if ((err as { code?: string }).code === "42P01") {
          // eslint-disable-next-line no-console
          console.log(`seed: table ${table} not present — skipping reset`);
          return;
        }
        throw err;
      }
    };
    // Fuel-deal child tables first — delete by deal_id too, so any
    // orphan rows from a partial prior seed (where ON DELETE CASCADE
    // didn't run because the parent was missing) are cleared even
    // when their own id doesn't start with 01HSEED.
    await reset("fuel_deal_cost_stack");
    await reset("fuel_deal_cost_stack", "deal_id");
    await reset("fuel_deal_cashflow_events");
    await reset("fuel_deal_cashflow_events", "deal_id");
    await reset("fuel_deal_scenarios");
    await reset("fuel_deal_scenarios", "deal_id");
    await reset("fuel_deal_documents");
    await reset("fuel_deal_documents", "deal_id");
    await reset("fuel_deal_counterparty_scores");
    await reset("fuel_deals");
    await reset("fuel_market_rates");
    await reset("touchpoints");
    await reset("summaries");
    await reset("events");
    await reset("raw_events");
    await reset("contacts"); // cascades contact_org_memberships
    await reset("leads");
    await reset("campaigns");
    await reset("organizations");
    await reset("users");
    await reset("workspaces");
    // eslint-disable-next-line no-console
    console.log("seed: previous seed rows cleared");

    const db = drizzle(client, { schema });

    await db.insert(schema.workspaces).values({
      id: SEED_WORKSPACE_ID,
      name: "Acme Demo",
      plan: "pro",
      settings: {
        source_priority: ["internal", "apollo", "ga4", "resend"],
        enabled_agents: ["qualifier", "composer"],
        daily_cost_limit: 50,
        kill_all_agents: false,
        feature_rollout: {
          voice_alpha: 100,
          pstn_calls: 100,
          deal_evaluator: 100,
        },
        sharing_enabled: false,
      },
    });

    await db.insert(schema.users).values({
      id: SEED_ADMIN_USER_ID,
      tenantId,
      workspaceId: SEED_WORKSPACE_ID,
      email: "admin@acme-demo.test",
      name: "Acme Admin",
      role: "owner",
    });

    await db.insert(schema.organizations).values([
      {
        id: SEED_ORG_IDS.acme,
        tenantId,
        legalName: "Acme Corporation",
        domain: "acme.test",
        industry: "Manufacturing",
        fitScore: 0.91,
        sourceOfTruth: "internal",
        externalKeys: { apollo: "apollo-acme-001", salesforce: "0015x00000Acme01" },
        fieldConfidence: {
          legalName: {
            value: "Acme Corporation",
            source: "internal",
            confidence: 1.0,
            updated_at: now.toISOString(),
          },
        },
      },
      {
        id: SEED_ORG_IDS.globex,
        tenantId,
        legalName: "Globex Industries",
        domain: "globex.test",
        industry: "Energy",
        fitScore: 0.74,
        sourceOfTruth: "apollo",
        externalKeys: { apollo: "apollo-globex-004" },
        fieldConfidence: {},
      },
      {
        id: SEED_ORG_IDS.initech,
        tenantId,
        legalName: "Initech LLC",
        domain: "initech.test",
        industry: "Software",
        fitScore: 0.82,
        sourceOfTruth: "internal",
        externalKeys: { apollo: "apollo-initech-099", hubspot: "hs-initech-0009" },
        fieldConfidence: {},
      },
      {
        id: SEED_ORG_IDS.umbrella,
        tenantId,
        legalName: "Umbrella Biotech",
        domain: "umbrella.test",
        industry: "Biotech",
        fitScore: 0.58,
        sourceOfTruth: "apollo",
        externalKeys: { apollo: "apollo-umbrella-210" },
        fieldConfidence: {},
      },
      {
        id: SEED_ORG_IDS.stark,
        tenantId,
        legalName: "Stark Industries",
        domain: "stark.test",
        industry: "Defense",
        fitScore: 0.97,
        sourceOfTruth: "internal",
        externalKeys: { apollo: "apollo-stark-777", salesforce: "0015x00000Stark2" },
        fieldConfidence: {},
      },
      // Sprint 11 — Caribbean buyers for the fuel deal seed.
      {
        id: SEED_ORG_IDS.massy,
        tenantId,
        legalName: "Massy United Industries",
        domain: "massyunited.test",
        industry: "Fuel Distribution",
        geo: { country: "JM", region: "Kingston" },
        fitScore: 0.88,
        sourceOfTruth: "internal",
        externalKeys: { internal: "vtc-buyer-massy" },
        fieldConfidence: {},
      },
      {
        id: SEED_ORG_IDS.punta,
        tenantId,
        legalName: "Punta Caucedo Energy",
        domain: "puntacaucedo.test",
        industry: "Fuel Distribution",
        geo: { country: "DO", region: "Santo Domingo" },
        fitScore: 0.81,
        sourceOfTruth: "internal",
        externalKeys: { internal: "vtc-buyer-punta" },
        fieldConfidence: {},
      },
      {
        id: SEED_ORG_IDS.caribAir,
        tenantId,
        legalName: "Caribbean Airlines",
        domain: "caribbean-airlines.test",
        industry: "Aviation",
        geo: { country: "TT", region: "Port of Spain" },
        fitScore: 0.76,
        sourceOfTruth: "internal",
        externalKeys: { internal: "vtc-buyer-caribair" },
        fieldConfidence: {},
      },
    ]);

    const orgIds = Object.values(SEED_ORG_IDS);
    await db.insert(schema.contacts).values(
      SEED_CONTACT_IDS.map((id, i) => ({
        id,
        tenantId,
        orgId: orgIds[i % orgIds.length]!,
        fullName: `Contact ${i + 1}`,
        title: ["VP Sales", "CFO", "CTO", "Director", "Manager"][i % 5]!,
        emails: [`contact${i + 1}@${new URL(`https://example${i}.test`).hostname}`],
        phones: [],
        roleScore: 0.5 + ((i % 5) * 0.1),
        externalKeys: { apollo: `apollo-contact-${i + 1}` },
        fieldConfidence: {},
        status: "active" as const,
        timezone: ["America/New_York", "America/Los_Angeles", "Europe/London"][i % 3]!,
      })),
    );

    // Sprint 14 — seed a primary membership for every contact so the
    // m:n model agrees with the legacy `contacts.org_id`. Then add
    // secondary memberships for the first two contacts so the demo
    // shows a person represented at more than one org.
    await db.insert(schema.contactOrgMemberships).values(
      SEED_CONTACT_IDS.map((id, i) => ({
        tenantId,
        contactId: id,
        orgId: orgIds[i % orgIds.length]!,
        role: ["VP Sales", "CFO", "CTO", "Director", "Manager"][i % 5]!,
        isPrimary: true,
      })),
    );
    await db.insert(schema.contactOrgMemberships).values([
      {
        tenantId,
        contactId: SEED_CONTACT_IDS[0]!,
        orgId: orgIds[1]!,
        role: "Advisor",
        isPrimary: false,
      },
      {
        tenantId,
        contactId: SEED_CONTACT_IDS[1]!,
        orgId: orgIds[2]!,
        role: "Board Observer",
        isPrimary: false,
      },
    ]);

    await db.insert(schema.campaigns).values([
      {
        id: SEED_CAMPAIGN_IDS.emailNurture,
        tenantId,
        channel: "email",
        source: "resend",
        medium: "nurture",
        accountRef: "resend-account-acme",
        spend: 0,
        objective: "reactivate cold leads",
        status: "active",
      },
      {
        id: SEED_CAMPAIGN_IDS.paidSearchQ2,
        tenantId,
        channel: "paid_search",
        source: "google_ads",
        medium: "cpc",
        accountRef: "ga-123-456",
        spend: 12_000,
        objective: "inbound demo requests",
        status: "active",
      },
      {
        id: SEED_CAMPAIGN_IDS.outboundSdrs,
        tenantId,
        channel: "outbound",
        source: "sdr_team",
        medium: "cold_email",
        accountRef: "team-sdr-a",
        spend: 2_500,
        objective: "enterprise pipeline",
        status: "active",
      },
    ]);

    const campaignIds = Object.values(SEED_CAMPAIGN_IDS);
    // 15 realistic touchpoints that mirror what the Resend + Twilio
    // normalizers write in production: channel encodes the provider
    // event verb (sent / delivered / opened / clicked / bounced /
    // received / failed) and metadata carries direction + preview so
    // the inbox UI renders meaningful rows on a fresh seed.
    const touchpointFixtures: Array<{
      channel: string;
      direction: "inbound" | "outbound";
      preview: string;
      actor: string;
      offsetMinutes: number;
    }> = [
      {
        channel: "email.sent",
        direction: "outbound",
        preview: "Quick check-in on the Acme proposal",
        actor: "agent.composer",
        offsetMinutes: 5,
      },
      {
        channel: "email.delivered",
        direction: "outbound",
        preview: "Quick check-in on the Acme proposal",
        actor: "provider.resend",
        offsetMinutes: 6,
      },
      {
        channel: "email.opened",
        direction: "inbound",
        preview: "Quick check-in on the Acme proposal",
        actor: "provider.resend",
        offsetMinutes: 42,
      },
      {
        channel: "email.clicked",
        direction: "inbound",
        preview: "https://app.vex.ai/brief/today",
        actor: "provider.resend",
        offsetMinutes: 47,
      },
      {
        channel: "sms.sent",
        direction: "outbound",
        preview:
          "Hey — quick follow-up on the trade you mentioned last week. Free to chat tomorrow?",
        actor: "agent.composer",
        offsetMinutes: 120,
      },
      {
        channel: "sms.delivered",
        direction: "outbound",
        preview: "Hey — quick follow-up on the trade you mentioned last week.",
        actor: "provider.twilio",
        offsetMinutes: 121,
      },
      {
        channel: "sms.received",
        direction: "inbound",
        preview: "can you send over the deck? interested to learn more",
        actor: "provider.twilio",
        offsetMinutes: 180,
      },
      {
        channel: "whatsapp.sent",
        direction: "outbound",
        preview: "Heads-up on the batch pricing you asked about earlier",
        actor: "agent.composer",
        offsetMinutes: 360,
      },
      {
        channel: "whatsapp.delivered",
        direction: "outbound",
        preview: "Heads-up on the batch pricing you asked about earlier",
        actor: "provider.twilio",
        offsetMinutes: 361,
      },
      {
        channel: "whatsapp.read",
        direction: "inbound",
        preview: "Heads-up on the batch pricing you asked about earlier",
        actor: "provider.twilio",
        offsetMinutes: 402,
      },
      {
        channel: "email.bounced",
        direction: "inbound",
        preview: "Mailbox does not exist — 550 5.1.1",
        actor: "provider.resend",
        offsetMinutes: 540,
      },
      {
        channel: "email.sent",
        direction: "outbound",
        preview: "Did you have any questions on the pricing?",
        actor: "agent.composer",
        offsetMinutes: 720,
      },
      {
        channel: "email.replied",
        direction: "inbound",
        preview:
          "Thanks — yes, one thing: how does onboarding handle our Salesforce data?",
        actor: "provider.resend",
        offsetMinutes: 905,
      },
      {
        channel: "sms.failed",
        direction: "outbound",
        preview: "Unknown destination (error 30003)",
        actor: "provider.twilio",
        offsetMinutes: 1_080,
      },
      {
        channel: "email.opened",
        direction: "inbound",
        preview: "Welcome to Vex — here's your first daily brief",
        actor: "provider.resend",
        offsetMinutes: 1_440,
      },
    ];
    await db.insert(schema.touchpoints).values(
      SEED_TOUCHPOINT_IDS.map((id, i) => {
        const fx = touchpointFixtures[i]!;
        return {
          id,
          tenantId,
          channel: fx.channel,
          actor: fx.actor,
          occurredAt: new Date(now.getTime() - fx.offsetMinutes * 60_000),
          campaignId: campaignIds[i % campaignIds.length]!,
          leadId: null,
          contactId: SEED_CONTACT_IDS[i % SEED_CONTACT_IDS.length]!,
          orgId: orgIds[i % orgIds.length]!,
          metadata: {
            direction: fx.direction,
            subject: fx.channel.startsWith("email.") ? fx.preview : undefined,
            text: fx.channel.startsWith("email.") ? undefined : fx.preview,
            preview: fx.preview,
          },
        };
      }),
    );

    // A couple of voice_call activities so /app/inbox shows calls
    // alongside messages. One live, one completed-with-recording.
    await db.delete(schema.activities);
    await db.insert(schema.activities).values([
      {
        id: "01HSEEDACT0000000000000001",
        tenantId,
        type: "voice_call",
        relatedObjectIds: { contact_id: SEED_CONTACT_IDS[0]! },
        occurredAt: new Date(now.getTime() - 3 * 60_000),
        result: "in-progress",
        durationSeconds: null,
        transcriptRef: null,
        metadata: {
          session_id: "outbound-call-01HSEEDRUN0000000000000099",
          call_sid: "CASEED0000000000000000000000000001",
          status: "in-progress",
        },
      },
      {
        id: "01HSEEDACT0000000000000002",
        tenantId,
        type: "voice_call",
        relatedObjectIds: { contact_id: SEED_CONTACT_IDS[1]! },
        occurredAt: new Date(now.getTime() - 4 * 3_600_000),
        result: "recorded",
        durationSeconds: 247,
        transcriptRef: `recordings/${tenantId}/CASEED0000000000000000000000000002.mp3`,
        metadata: {
          session_id: "outbound-call-01HSEEDRUN0000000000000098",
          call_sid: "CASEED0000000000000000000000000002",
          status: "completed",
        },
      },
    ]);

    await db.insert(schema.summaries).values([
      {
        id: SEED_SUMMARY_IDS.acmeOrgSummary,
        tenantId,
        subjectType: "organization",
        subjectId: SEED_ORG_IDS.acme,
        summaryType: "profile",
        version: 1,
        content: "Acme Corporation is a manufacturing incumbent evaluating Vex for pipeline intelligence.",
      },
      {
        id: SEED_SUMMARY_IDS.globexOrgSummary,
        tenantId,
        subjectType: "organization",
        subjectId: SEED_ORG_IDS.globex,
        summaryType: "profile",
        version: 1,
        content: "Globex Industries is a mid-market energy buyer with fragmented RevOps tooling.",
      },
      {
        id: SEED_SUMMARY_IDS.initechOrgSummary,
        tenantId,
        subjectType: "organization",
        subjectId: SEED_ORG_IDS.initech,
        summaryType: "profile",
        version: 1,
        content: "Initech LLC is a late-stage SaaS firm with active AE-led motions.",
      },
      {
        id: SEED_SUMMARY_IDS.contact1Summary,
        tenantId,
        subjectType: "contact",
        subjectId: SEED_CONTACT_IDS[0]!,
        summaryType: "engagement",
        version: 1,
        content: "Contact 1 engaged with email nurture twice in the last 14 days.",
      },
      {
        id: SEED_SUMMARY_IDS.contact2Summary,
        tenantId,
        subjectType: "contact",
        subjectId: SEED_CONTACT_IDS[1]!,
        summaryType: "engagement",
        version: 1,
        content: "Contact 2 opted out after the Q1 paid-search sequence.",
      },
    ]);

    await db.insert(schema.rawEvents).values(
      SEED_RAW_EVENT_IDS.map((id, i) => ({
        id,
        tenantId,
        provider: "resend",
        providerEventId: `resend-evt-${i + 1}`,
        headers: { "content-type": "application/json" },
        payload: {
          type: "email.clicked",
          data: {
            campaign_id: SEED_CAMPAIGN_IDS.emailNurture,
            contact_email: `contact${i + 1}@example.test`,
          },
        },
        receivedAt: new Date(Date.UTC(2026, 3, 10 + i, 12, 0, 0)),
        checksum: `sha256-${createId()}`,
        status: "processed" as const,
      })),
    );

    await db.insert(schema.events).values(
      SEED_EVENT_IDS.map((id, i) => ({
        id,
        tenantId,
        verb: "email.clicked",
        subjectType: "contact",
        subjectId: SEED_CONTACT_IDS[i]!,
        actorType: "campaign",
        actorId: SEED_CAMPAIGN_IDS.emailNurture,
        objectType: "campaign",
        objectId: SEED_CAMPAIGN_IDS.emailNurture,
        occurredAt: new Date(Date.UTC(2026, 3, 10 + i, 12, 5, 0)),
        idempotencyKey: `email-click-${i + 1}`,
        metadata: { from_raw_event: SEED_RAW_EVENT_IDS[i] },
      })),
    );

    // -----------------------------------------------------------------------
    // Sprint 11 — Deal 1 (VTC-2026-001)
    //
    // ULSD Houston → Kingston, Jamaica. CIF, LC sight payment. Ships on an
    // MR tanker carrying only 14% of its capacity — this exists to
    // demonstrate the vessel-underutilization critical warning and the
    // matching "do_not_proceed" recommendation regardless of numeric score.
    // OFAC screening is in_progress, so a secondary compliance caution
    // also surfaces.
    // -----------------------------------------------------------------------
    const deal1Inputs: FuelDealInputs = {
      dealRef: SEED_FUEL_DEAL_REFS.deal1,
      product: "ulsd",
      incoterm: "cif",
      volumeUsg: 2_000_000,
      densityKgL: 0.845, // ULSD @ 15°C
      volumeTolerancePct: 5,
      sellPricePerUsg: 2.9,
      buyerCurrencyCode: "usd",
      fxRateToUsd: 1,
      fxHedgeInPlace: false,
      productCostPerUsg: 2.4, // Platts USGC ULSD + 4¢
      productQualityPremiumPerUsg: 0,
      // freightPerUsg gets the all-in rate from calculateVesselEconomics's
      // full-load reference; the vessel sub-record carries the actual
      // utilization penalty, which the warning generator surfaces.
      freightPerUsg: 0.255,
      cargoInsurancePct: 0.0018,
      warRiskPremiumPct: 0.0005,
      politicalRiskPremiumPct: 0.0002,
      dischargeHandlingPerUsg: 0.012,
      compliancePerUsg: 0.003,
      tradeFinancePerUsg: 0.008,
      intermediaryFeePerUsg: 0.005,
      vtcVariableOpsPerUsg: 0.003,
      vessel: {
        capacityUsg: 14_000_000, // typical MR tanker ~42 kMT
        utilizationPct: 14,
        freightLumpSumUsd: 500_000,
        demurrageRatePerDay: 25_000,
        demurrageEstimatedDays: 0.5,
        despatchRatePerDay: 12_500,
        portDuesLoadUsd: 18_000,
        portDuesDischargeUsd: 22_000,
        canalTransitUsd: 0,
      },
      overheadAllocationUsd: 35_000,
      tradeFinance: {
        type: "lc_sight",
        lcValueUsd: 5_800_000,
        lcMarginPct: 0.1,
      },
      counterpartyRiskScore: 30,
      countryRiskScore: 40, // Jamaica — Coface/OECD mid band
      thresholds: {
        maxPeakCashExposureUsd: 5_000_000,
        minGrossMarginPct: 0.05,
        minNetMarginPerUsg: 0.03,
        maxCounterpartyRiskScore: 65,
        maxCountryRiskScore: 70,
        maxDemurrageDays: 2,
      },
      monthlyFixedOverheadUsd: 120_000,
      compliance: {
        ofac: "in_progress",
        bisRequired: false,
        bisIssued: false,
        eeiRequired: true,
        eeiFiled: false,
      },
    };
    const deal1Results = calculateFuelDeal(deal1Inputs);

    await db.insert(schema.fuelDeals).values({
      id: SEED_FUEL_DEAL_IDS.deal1,
      tenantId,
      dealRef: SEED_FUEL_DEAL_REFS.deal1,
      status: "negotiating",
      dealType: "spot",
      product: "ulsd",
      productGrade: "ULSD 15 ppm S",
      productSpecNotes: "Flashpoint 52°C min, cetane 40 min",
      originCountry: "US",
      originPort: "Houston",
      originTerminal: "Kinder Morgan Galena Park",
      destinationCountry: "JM",
      destinationPort: "Kingston",
      destinationTerminal: "Petrojam Refinery",
      incoterm: "cif",
      pricingBasis: "platts",
      pricingFormula: "Platts US Gulf Coast ULSD + $0.04/gal",
      priceLockDate: "2026-04-14",
      priceLockTime: "Platts 10-day average around BL date",
      volumeUsg: deal1Inputs.volumeUsg,
      volumeMt: deal1Results.volumeMt,
      volumeBbls: deal1Results.volumeBbls,
      densityKgL: deal1Inputs.densityKgL,
      volumeTolerancePct: deal1Inputs.volumeTolerancePct,
      currency: "usd",
      fxRateToUsd: 1,
      fxHedgeInPlace: false,
      buyerOrgId: SEED_ORG_IDS.massy,
      laycanStart: "2026-04-22",
      laycanEnd: "2026-04-26",
      blDateEstimated: "2026-04-24",
      etaDestination: "2026-04-30",
      paymentTerms: "lc_sight",
      lcIssuingBank: "National Commercial Bank Jamaica",
      lcConfirmingBank: "Citibank N.A.",
      lcValueUsd: 5_800_000,
      lcExpiryDate: "2026-05-20",
      lcMarginPct: 0.1,
      tradeFinanceCostPct: 0.012,
      ofacScreeningStatus: "in_progress",
      bisLicenseRequired: false,
      eeiFilingRequired: true,
      complianceHold: false,
      counterpartyRiskScore: 30,
      countryRiskScore: 40,
      politicalRiskInsured: false,
      notes:
        "Repeat Kingston lane. Freight is carrying a heavy underutilization penalty — vessel share search open.",
      internalNotes: "VTC demo deal — seeded to exercise the vessel utilization warning path.",
      createdBy: SEED_ADMIN_USER_ID,
    });

    await db.insert(schema.fuelDealCostStack).values({
      id: SEED_FUEL_DEAL_COST_STACK_IDS.deal1,
      tenantId,
      dealId: SEED_FUEL_DEAL_IDS.deal1,
      productCostPerUsg: deal1Inputs.productCostPerUsg,
      productQualityPremiumUsg: 0,
      productCostBasis: "Platts + 4¢ settled 2026-04-14",
      vesselName: "MT Osprey Venture",
      vesselType: "tanker_mr",
      vesselCapacityUsg: deal1Inputs.vessel!.capacityUsg,
      vesselUtilizationPct: deal1Inputs.vessel!.utilizationPct,
      freightBasis: "lump_sum",
      freightRateRaw: deal1Inputs.vessel!.freightLumpSumUsd,
      freightRatePerUsg: deal1Results.vessel!.freightPerUsgIfFullLoad,
      freightCurrency: "usd",
      demurrageRatePerDay: deal1Inputs.vessel!.demurrageRatePerDay,
      demurrageAllowedHours: 72,
      demurrageDaysEstimated: deal1Inputs.vessel!.demurrageEstimatedDays,
      demurrageCostEstimated:
        deal1Inputs.vessel!.demurrageRatePerDay * deal1Inputs.vessel!.demurrageEstimatedDays,
      despatchRatePerDay: deal1Inputs.vessel!.despatchRatePerDay,
      portDuesLoadUsd: deal1Inputs.vessel!.portDuesLoadUsd,
      portDuesDischargeUsd: deal1Inputs.vessel!.portDuesDischargeUsd,
      canalTransitCostUsd: 0,
      freightTotalUsd:
        deal1Inputs.vessel!.freightLumpSumUsd +
        deal1Inputs.vessel!.portDuesLoadUsd +
        deal1Inputs.vessel!.portDuesDischargeUsd,
      freightPerUsgAllIn: deal1Results.vessel!.freightActualPerUsg,
      cargoInsurancePct: deal1Inputs.cargoInsurancePct,
      cargoInsuranceUsd: deal1Results.insurance.cargoInsuranceUsd,
      warRiskPremiumPct: deal1Inputs.warRiskPremiumPct,
      warRiskUsd: deal1Results.insurance.warRiskUsd,
      politicalRiskPremiumPct: deal1Inputs.politicalRiskPremiumPct,
      politicalRiskUsd: deal1Results.insurance.politicalRiskUsd,
      totalInsurancePerUsg: deal1Results.insurance.totalInsurancePerUsg,
      dischargeHandlingPerUsg: deal1Inputs.dischargeHandlingPerUsg,
      inspectionFeeUsd: 4_500,
      samplingTestingUsd: 2_500,
      totalCompliancePerUsg: deal1Inputs.compliancePerUsg,
      ofacScreeningFeeUsd: 1_500,
      eeiFilingFeeUsd: 300,
      complianceLegalUsd: 4_000,
      lcFeeUsd: 29_000,
      tradeFinanceTotalUsd: deal1Inputs.tradeFinancePerUsg * deal1Inputs.volumeUsg,
      tradeFinancePerUsg: deal1Inputs.tradeFinancePerUsg,
      brokeragePct: 0.002,
      intermediaryFeePct: 0,
      totalAgentPerUsg: deal1Inputs.intermediaryFeePerUsg,
      vtcVariableOpsPerUsg: deal1Inputs.vtcVariableOpsPerUsg,
      overheadAllocationUsd: deal1Inputs.overheadAllocationUsd,
      overheadPerUsg: deal1Results.perUsg.overheadAllocation,
      totalLandedCostPerUsg:
        deal1Results.perUsg.totalVariableCost + deal1Results.perUsg.overheadAllocation,
      grossMarginPerUsg: deal1Results.perUsg.grossMargin,
      grossMarginPct: deal1Results.totals.grossMarginPct,
      netMarginPerUsg: deal1Results.perUsg.netMargin,
      netMarginPct: deal1Results.totals.ebitdaMarginPct,
      ebitdaUsd: deal1Results.totals.ebitdaUsd,
      breakevenSellPriceUsg: deal1Results.breakeven.sellPricePerUsg,
    });

    await db.insert(schema.fuelDealCashflowEvents).values([
      {
        id: SEED_FUEL_DEAL_CASHFLOW_IDS[0]!,
        tenantId,
        dealId: SEED_FUEL_DEAL_IDS.deal1,
        dayRelative: -10,
        label: "Freight deposit (20% of freight)",
        direction: "outflow",
        eventType: "freight_deposit",
        baseType: "freight",
        amountPct: 0.2,
        amountFixedUsd: null,
        amountCalculatedUsd: 0.2 * deal1Results.totals.freightUsd,
        counterparty: "Osprey Shipping Agents",
        paymentMethod: "wire",
      },
      {
        id: SEED_FUEL_DEAL_CASHFLOW_IDS[1]!,
        tenantId,
        dealId: SEED_FUEL_DEAL_IDS.deal1,
        dayRelative: -3,
        label: "Product purchase (100% of product cost)",
        direction: "outflow",
        eventType: "product_purchase",
        baseType: "product_cost",
        amountPct: 1,
        amountFixedUsd: null,
        amountCalculatedUsd: deal1Results.totals.productCostUsd,
        counterparty: "US Gulf Coast supplier",
        paymentMethod: "wire",
      },
      {
        id: SEED_FUEL_DEAL_CASHFLOW_IDS[2]!,
        tenantId,
        dealId: SEED_FUEL_DEAL_IDS.deal1,
        dayRelative: 1,
        label: "Buyer LC payment on documents (100% of revenue)",
        direction: "inflow",
        eventType: "lc_payment",
        baseType: "revenue",
        amountPct: 1,
        amountFixedUsd: null,
        amountCalculatedUsd: deal1Results.totals.revenueUsd,
        counterparty: "Massy United Industries",
        paymentMethod: "lc",
      },
    ]);

    await db.insert(schema.fuelDealScenarios).values({
      id: SEED_FUEL_DEAL_SCENARIO_IDS.deal1Base,
      tenantId,
      dealId: SEED_FUEL_DEAL_IDS.deal1,
      scenarioName: "Base Case",
      scenarioType: "base",
      isActive: true,
      sellPricePerUsg: deal1Inputs.sellPricePerUsg,
      resultsJson: deal1Results as unknown as Record<string, unknown>,
      score: deal1Results.scorecard.overallScore,
      recommendation: deal1Results.scorecard.recommendation,
      calculatedAt: now,
      notes:
        "Base case at current Platts. Critical vessel utilization warning is expected — share-vessel negotiation needed before approval.",
    });

    // -----------------------------------------------------------------------
    // Sprint 11 — Deal 2 (VTC-2026-002)
    //
    // ULSD Houston → Santo Domingo (Punta Caucedo). FOB pricing basis but
    // VTC still coordinates the vessel for reimbursement against the LC.
    // Vessel is a small coastal tanker at 85% utilization — freight is
    // healthy and the deal prices comfortably above breakeven.
    // OFAC is cleared, BIS not required, EEI filed — clean compliance.
    // Expected scorecard lands in the "acceptable" band (~78).
    // -----------------------------------------------------------------------
    const deal2Inputs: FuelDealInputs = {
      dealRef: SEED_FUEL_DEAL_REFS.deal2,
      product: "ulsd",
      incoterm: "fob",
      volumeUsg: 3_500_000,
      densityKgL: 0.845,
      volumeTolerancePct: 5,
      sellPricePerUsg: 2.59,
      buyerCurrencyCode: "usd",
      fxRateToUsd: 1,
      fxHedgeInPlace: false,
      productCostPerUsg: 2.35, // Platts FOB USGC ULSD
      productQualityPremiumPerUsg: 0,
      freightPerUsg: 0.07, // matches the vessel full-load figure
      cargoInsurancePct: 0.0015,
      warRiskPremiumPct: 0.0003,
      politicalRiskPremiumPct: 0.0001,
      dischargeHandlingPerUsg: 0.01,
      compliancePerUsg: 0.0025,
      tradeFinancePerUsg: 0.006,
      intermediaryFeePerUsg: 0.002,
      vtcVariableOpsPerUsg: 0.002,
      vessel: {
        capacityUsg: 4_200_000, // small coastal tanker (~13 kMT)
        utilizationPct: 85,
        freightLumpSumUsd: 250_000,
        demurrageRatePerDay: 18_000,
        demurrageEstimatedDays: 0.3,
        despatchRatePerDay: 9_000,
        portDuesLoadUsd: 15_000,
        portDuesDischargeUsd: 19_000,
        canalTransitUsd: 0,
      },
      overheadAllocationUsd: 60_000,
      tradeFinance: {
        type: "lc_sight",
        lcValueUsd: 9_100_000,
        lcMarginPct: 0.08,
      },
      counterpartyRiskScore: 40,
      countryRiskScore: 55, // Dominican Republic — Coface B
      thresholds: {
        maxPeakCashExposureUsd: 5_000_000,
        minGrossMarginPct: 0.05,
        minNetMarginPerUsg: 0.03,
        maxCounterpartyRiskScore: 65,
        maxCountryRiskScore: 70,
        maxDemurrageDays: 2,
      },
      monthlyFixedOverheadUsd: 120_000,
      compliance: {
        ofac: "cleared",
        bisRequired: false,
        bisIssued: false,
        eeiRequired: true,
        eeiFiled: true,
      },
    };
    const deal2Results = calculateFuelDeal(deal2Inputs);

    await db.insert(schema.fuelDeals).values({
      id: SEED_FUEL_DEAL_IDS.deal2,
      tenantId,
      dealRef: SEED_FUEL_DEAL_REFS.deal2,
      status: "approved",
      dealType: "spot",
      product: "ulsd",
      productGrade: "ULSD 15 ppm S",
      productSpecNotes: "Flashpoint 52°C min, cetane 40 min",
      originCountry: "US",
      originPort: "Houston",
      originTerminal: "Magellan East Houston",
      destinationCountry: "DO",
      destinationPort: "Santo Domingo",
      destinationTerminal: "Punta Caucedo",
      incoterm: "fob",
      pricingBasis: "platts",
      pricingFormula: "Platts US Gulf Coast ULSD FOB + $0.02/gal",
      priceLockDate: "2026-04-15",
      priceLockTime: "Platts 5-day average around BL date",
      volumeUsg: deal2Inputs.volumeUsg,
      volumeMt: deal2Results.volumeMt,
      volumeBbls: deal2Results.volumeBbls,
      densityKgL: deal2Inputs.densityKgL,
      volumeTolerancePct: deal2Inputs.volumeTolerancePct,
      currency: "usd",
      fxRateToUsd: 1,
      fxHedgeInPlace: false,
      buyerOrgId: SEED_ORG_IDS.punta,
      laycanStart: "2026-04-25",
      laycanEnd: "2026-04-29",
      blDateEstimated: "2026-04-27",
      etaDestination: "2026-05-02",
      paymentTerms: "lc_sight",
      lcIssuingBank: "Banco Popular Dominicano",
      lcConfirmingBank: "JPMorgan Chase Bank",
      lcValueUsd: 9_100_000,
      lcExpiryDate: "2026-05-25",
      lcMarginPct: 0.08,
      tradeFinanceCostPct: 0.009,
      ofacScreeningStatus: "cleared",
      bisLicenseRequired: false,
      eeiFilingRequired: true,
      eeiItn: "AES-X20260415-00342",
      complianceHold: false,
      counterpartyRiskScore: 40,
      countryRiskScore: 55,
      politicalRiskInsured: true,
      approvedBy: SEED_ADMIN_USER_ID,
      notes: "Healthy vessel economics at 85% utilization. Approved for loading in the 25–29 Apr window.",
      internalNotes: "VTC demo deal — seeded to exercise the acceptable recommendation path with clean compliance.",
      createdBy: SEED_ADMIN_USER_ID,
    });

    await db.insert(schema.fuelDealCostStack).values({
      id: SEED_FUEL_DEAL_COST_STACK_IDS.deal2,
      tenantId,
      dealId: SEED_FUEL_DEAL_IDS.deal2,
      productCostPerUsg: deal2Inputs.productCostPerUsg,
      productQualityPremiumUsg: 0,
      productCostBasis: "Platts FOB + 2¢ settled 2026-04-15",
      vesselName: "MT Caribbean Horizon",
      vesselType: "coastal_tanker",
      vesselCapacityUsg: deal2Inputs.vessel!.capacityUsg,
      vesselUtilizationPct: deal2Inputs.vessel!.utilizationPct,
      freightBasis: "lump_sum",
      freightRateRaw: deal2Inputs.vessel!.freightLumpSumUsd,
      freightRatePerUsg: deal2Results.vessel!.freightPerUsgIfFullLoad,
      freightCurrency: "usd",
      demurrageRatePerDay: deal2Inputs.vessel!.demurrageRatePerDay,
      demurrageAllowedHours: 72,
      demurrageDaysEstimated: deal2Inputs.vessel!.demurrageEstimatedDays,
      demurrageCostEstimated:
        deal2Inputs.vessel!.demurrageRatePerDay * deal2Inputs.vessel!.demurrageEstimatedDays,
      despatchRatePerDay: deal2Inputs.vessel!.despatchRatePerDay,
      portDuesLoadUsd: deal2Inputs.vessel!.portDuesLoadUsd,
      portDuesDischargeUsd: deal2Inputs.vessel!.portDuesDischargeUsd,
      canalTransitCostUsd: 0,
      freightTotalUsd:
        deal2Inputs.vessel!.freightLumpSumUsd +
        deal2Inputs.vessel!.portDuesLoadUsd +
        deal2Inputs.vessel!.portDuesDischargeUsd,
      freightPerUsgAllIn: deal2Results.vessel!.freightActualPerUsg,
      cargoInsurancePct: deal2Inputs.cargoInsurancePct,
      cargoInsuranceUsd: deal2Results.insurance.cargoInsuranceUsd,
      warRiskPremiumPct: deal2Inputs.warRiskPremiumPct,
      warRiskUsd: deal2Results.insurance.warRiskUsd,
      politicalRiskPremiumPct: deal2Inputs.politicalRiskPremiumPct,
      politicalRiskUsd: deal2Results.insurance.politicalRiskUsd,
      totalInsurancePerUsg: deal2Results.insurance.totalInsurancePerUsg,
      dischargeHandlingPerUsg: deal2Inputs.dischargeHandlingPerUsg,
      inspectionFeeUsd: 3_800,
      samplingTestingUsd: 2_200,
      totalCompliancePerUsg: deal2Inputs.compliancePerUsg,
      ofacScreeningFeeUsd: 1_200,
      eeiFilingFeeUsd: 280,
      complianceLegalUsd: 3_000,
      lcFeeUsd: 36_400,
      tradeFinanceTotalUsd: deal2Inputs.tradeFinancePerUsg * deal2Inputs.volumeUsg,
      tradeFinancePerUsg: deal2Inputs.tradeFinancePerUsg,
      brokeragePct: 0.001,
      intermediaryFeePct: 0,
      totalAgentPerUsg: deal2Inputs.intermediaryFeePerUsg,
      vtcVariableOpsPerUsg: deal2Inputs.vtcVariableOpsPerUsg,
      overheadAllocationUsd: deal2Inputs.overheadAllocationUsd,
      overheadPerUsg: deal2Results.perUsg.overheadAllocation,
      totalLandedCostPerUsg:
        deal2Results.perUsg.totalVariableCost + deal2Results.perUsg.overheadAllocation,
      grossMarginPerUsg: deal2Results.perUsg.grossMargin,
      grossMarginPct: deal2Results.totals.grossMarginPct,
      netMarginPerUsg: deal2Results.perUsg.netMargin,
      netMarginPct: deal2Results.totals.ebitdaMarginPct,
      ebitdaUsd: deal2Results.totals.ebitdaUsd,
      breakevenSellPriceUsg: deal2Results.breakeven.sellPricePerUsg,
    });

    await db.insert(schema.fuelDealCashflowEvents).values([
      {
        id: SEED_FUEL_DEAL_CASHFLOW_IDS[3]!,
        tenantId,
        dealId: SEED_FUEL_DEAL_IDS.deal2,
        dayRelative: -8,
        label: "Freight deposit (20% of freight)",
        direction: "outflow",
        eventType: "freight_deposit",
        baseType: "freight",
        amountPct: 0.2,
        amountFixedUsd: null,
        amountCalculatedUsd: 0.2 * deal2Results.totals.freightUsd,
        counterparty: "Caribbean Horizon Shipping",
        paymentMethod: "wire",
      },
      {
        id: SEED_FUEL_DEAL_CASHFLOW_IDS[4]!,
        tenantId,
        dealId: SEED_FUEL_DEAL_IDS.deal2,
        dayRelative: -2,
        label: "Product purchase (100% of product cost)",
        direction: "outflow",
        eventType: "product_purchase",
        baseType: "product_cost",
        amountPct: 1,
        amountFixedUsd: null,
        amountCalculatedUsd: deal2Results.totals.productCostUsd,
        counterparty: "US Gulf Coast supplier",
        paymentMethod: "wire",
      },
      {
        id: SEED_FUEL_DEAL_CASHFLOW_IDS[5]!,
        tenantId,
        dealId: SEED_FUEL_DEAL_IDS.deal2,
        dayRelative: 2,
        label: "Buyer LC payment on documents (100% of revenue)",
        direction: "inflow",
        eventType: "lc_payment",
        baseType: "revenue",
        amountPct: 1,
        amountFixedUsd: null,
        amountCalculatedUsd: deal2Results.totals.revenueUsd,
        counterparty: "Punta Caucedo Energy",
        paymentMethod: "lc",
      },
    ]);

    await db.insert(schema.fuelDealScenarios).values({
      id: SEED_FUEL_DEAL_SCENARIO_IDS.deal2Base,
      tenantId,
      dealId: SEED_FUEL_DEAL_IDS.deal2,
      scenarioName: "Base Case",
      scenarioType: "base",
      isActive: true,
      sellPricePerUsg: deal2Inputs.sellPricePerUsg,
      resultsJson: deal2Results as unknown as Record<string, unknown>,
      score: deal2Results.scorecard.overallScore,
      recommendation: deal2Results.scorecard.recommendation,
      calculatedAt: now,
      notes:
        "Base case at current Platts FOB. Healthy vessel utilization, clean compliance — recommendation lands in the acceptable band.",
    });

    // -----------------------------------------------------------------------
    // Sprint 11 — Deal 3 (VTC-2026-003)
    //
    // Jet A-1 Houston → Pointe-à-Pierre (Caribbean Airlines). Draft status,
    // no vessel chartered yet — the `vessel` sub-record is intentionally
    // omitted so calculateVesselEconomics returns undefined and no vessel
    // warnings fire. The critical warning instead comes from the BIS
    // export licence being required but not yet issued; EEI filing is
    // also outstanding (caution). Expected recommendation: do_not_proceed
    // regardless of numeric score, per the compliance gate.
    // -----------------------------------------------------------------------
    const deal3Inputs: FuelDealInputs = {
      dealRef: SEED_FUEL_DEAL_REFS.deal3,
      product: "jet_a1",
      incoterm: "cif",
      volumeUsg: 1_500_000,
      densityKgL: 0.8, // Jet A-1 nominal
      volumeTolerancePct: 5,
      sellPricePerUsg: 2.9,
      buyerCurrencyCode: "usd",
      fxRateToUsd: 1,
      fxHedgeInPlace: false,
      productCostPerUsg: 2.55, // Platts USGC Jet
      productQualityPremiumPerUsg: 0,
      freightPerUsg: 0.1, // placeholder — no vessel chartered yet
      cargoInsurancePct: 0.0018,
      warRiskPremiumPct: 0.0008,
      politicalRiskPremiumPct: 0.0002,
      dischargeHandlingPerUsg: 0.015,
      compliancePerUsg: 0.003,
      tradeFinancePerUsg: 0.008,
      intermediaryFeePerUsg: 0.005,
      vtcVariableOpsPerUsg: 0.003,
      // vessel intentionally omitted — draft deal, no charter yet.
      overheadAllocationUsd: 40_000,
      tradeFinance: {
        type: "prepayment_80_20",
        prepaymentPct: 0.8,
      },
      counterpartyRiskScore: 20,
      countryRiskScore: 35, // Trinidad & Tobago — lower risk
      thresholds: {
        maxPeakCashExposureUsd: 5_000_000,
        minGrossMarginPct: 0.05,
        minNetMarginPerUsg: 0.03,
        maxCounterpartyRiskScore: 65,
        maxCountryRiskScore: 70,
        maxDemurrageDays: 2,
      },
      monthlyFixedOverheadUsd: 120_000,
      compliance: {
        ofac: "cleared",
        bisRequired: true,
        bisIssued: false,
        eeiRequired: true,
        eeiFiled: false,
      },
    };
    const deal3Results = calculateFuelDeal(deal3Inputs);

    await db.insert(schema.fuelDeals).values({
      id: SEED_FUEL_DEAL_IDS.deal3,
      tenantId,
      dealRef: SEED_FUEL_DEAL_REFS.deal3,
      status: "draft",
      dealType: "spot",
      product: "jet_a1",
      productGrade: "Jet A-1 DEF STAN 91-091",
      productSpecNotes: "Flashpoint 38°C min, freeze point -47°C max, AN-8 anti-icing required",
      originCountry: "US",
      originPort: "Houston",
      originTerminal: "Kinder Morgan Pasadena",
      destinationCountry: "TT",
      destinationPort: "Pointe-à-Pierre",
      destinationTerminal: "Petrotrin Refinery Jetty",
      incoterm: "cif",
      pricingBasis: "platts",
      pricingFormula: "Platts US Gulf Coast Jet + $0.05/gal",
      priceLockDate: "2026-04-16",
      priceLockTime: "Platts 7-day average around BL date",
      volumeUsg: deal3Inputs.volumeUsg,
      volumeMt: deal3Results.volumeMt,
      volumeBbls: deal3Results.volumeBbls,
      densityKgL: deal3Inputs.densityKgL,
      volumeTolerancePct: deal3Inputs.volumeTolerancePct,
      currency: "usd",
      fxRateToUsd: 1,
      fxHedgeInPlace: false,
      buyerOrgId: SEED_ORG_IDS.caribAir,
      laycanStart: "2026-05-05",
      laycanEnd: "2026-05-10",
      blDateEstimated: "2026-05-07",
      etaDestination: "2026-05-11",
      paymentTerms: "prepayment_80_20",
      tradeFinanceCostPct: 0.005,
      ofacScreeningStatus: "cleared",
      bisLicenseRequired: true,
      // BIS licence number and expiry intentionally null — the licence
      // is the blocker that forces the do_not_proceed recommendation.
      bisLicenseNumber: null,
      bisLicenseExpiry: null,
      eeiFilingRequired: true,
      eeiItn: null,
      complianceHold: true,
      complianceNotes:
        "BIS export licence application submitted 2026-04-10, awaiting adjudication. EEI filing blocked on BIS issuance.",
      counterpartyRiskScore: 20,
      countryRiskScore: 35,
      politicalRiskInsured: false,
      notes:
        "Draft. Cannot progress beyond negotiating until BIS licence is issued — airline has agreed to 80/20 prepayment structure contingent on licence clearance.",
      internalNotes: "VTC demo deal — seeded to exercise the BIS-critical compliance path and the do_not_proceed recommendation.",
      createdBy: SEED_ADMIN_USER_ID,
    });

    await db.insert(schema.fuelDealCostStack).values({
      id: SEED_FUEL_DEAL_COST_STACK_IDS.deal3,
      tenantId,
      dealId: SEED_FUEL_DEAL_IDS.deal3,
      productCostPerUsg: deal3Inputs.productCostPerUsg,
      productQualityPremiumUsg: 0,
      productCostBasis: "Platts Jet USGC + 5¢ (preliminary, to be re-locked at BL)",
      // Vessel fields left null — no charter yet; the cost-stack row for
      // a pre-charter deal stores only the product + shore-side + finance
      // build-up. Freight figures still carry the placeholder so panels
      // that read the stack have something to render.
      freightBasis: "per_usg",
      freightRateRaw: deal3Inputs.freightPerUsg,
      freightRatePerUsg: deal3Inputs.freightPerUsg,
      freightCurrency: "usd",
      freightTotalUsd: deal3Inputs.freightPerUsg * deal3Inputs.volumeUsg,
      freightPerUsgAllIn: deal3Inputs.freightPerUsg,
      cargoInsurancePct: deal3Inputs.cargoInsurancePct,
      cargoInsuranceUsd: deal3Results.insurance.cargoInsuranceUsd,
      warRiskPremiumPct: deal3Inputs.warRiskPremiumPct,
      warRiskUsd: deal3Results.insurance.warRiskUsd,
      politicalRiskPremiumPct: deal3Inputs.politicalRiskPremiumPct,
      politicalRiskUsd: deal3Results.insurance.politicalRiskUsd,
      totalInsurancePerUsg: deal3Results.insurance.totalInsurancePerUsg,
      dischargeHandlingPerUsg: deal3Inputs.dischargeHandlingPerUsg,
      inspectionFeeUsd: 5_500, // Jet A-1 requires a fuller MSEP/particulate panel
      samplingTestingUsd: 3_000,
      totalCompliancePerUsg: deal3Inputs.compliancePerUsg,
      ofacScreeningFeeUsd: 1_200,
      bisLicenseFeeUsd: 2_500,
      eeiFilingFeeUsd: 300,
      complianceLegalUsd: 6_500,
      tradeFinanceTotalUsd: deal3Inputs.tradeFinancePerUsg * deal3Inputs.volumeUsg,
      tradeFinancePerUsg: deal3Inputs.tradeFinancePerUsg,
      brokeragePct: 0.002,
      intermediaryFeePct: 0,
      totalAgentPerUsg: deal3Inputs.intermediaryFeePerUsg,
      vtcVariableOpsPerUsg: deal3Inputs.vtcVariableOpsPerUsg,
      overheadAllocationUsd: deal3Inputs.overheadAllocationUsd,
      overheadPerUsg: deal3Results.perUsg.overheadAllocation,
      totalLandedCostPerUsg:
        deal3Results.perUsg.totalVariableCost + deal3Results.perUsg.overheadAllocation,
      grossMarginPerUsg: deal3Results.perUsg.grossMargin,
      grossMarginPct: deal3Results.totals.grossMarginPct,
      netMarginPerUsg: deal3Results.perUsg.netMargin,
      netMarginPct: deal3Results.totals.ebitdaMarginPct,
      ebitdaUsd: deal3Results.totals.ebitdaUsd,
      breakevenSellPriceUsg: deal3Results.breakeven.sellPricePerUsg,
    });

    await db.insert(schema.fuelDealCashflowEvents).values([
      {
        id: SEED_FUEL_DEAL_CASHFLOW_IDS[6]!,
        tenantId,
        dealId: SEED_FUEL_DEAL_IDS.deal3,
        dayRelative: -10,
        label: "Buyer prepayment (80% of revenue)",
        direction: "inflow",
        eventType: "buyer_prepayment",
        baseType: "revenue",
        amountPct: 0.8,
        amountFixedUsd: null,
        amountCalculatedUsd: 0.8 * deal3Results.totals.revenueUsd,
        counterparty: "Caribbean Airlines",
        paymentMethod: "wire",
      },
      {
        id: SEED_FUEL_DEAL_CASHFLOW_IDS[7]!,
        tenantId,
        dealId: SEED_FUEL_DEAL_IDS.deal3,
        dayRelative: -3,
        label: "Product purchase (100% of product cost)",
        direction: "outflow",
        eventType: "product_purchase",
        baseType: "product_cost",
        amountPct: 1,
        amountFixedUsd: null,
        amountCalculatedUsd: deal3Results.totals.productCostUsd,
        counterparty: "US Gulf Coast Jet supplier",
        paymentMethod: "wire",
      },
      {
        id: SEED_FUEL_DEAL_CASHFLOW_IDS[8]!,
        tenantId,
        dealId: SEED_FUEL_DEAL_IDS.deal3,
        dayRelative: 5,
        label: "Buyer final payment (20% of revenue)",
        direction: "inflow",
        eventType: "buyer_final_payment",
        baseType: "revenue",
        amountPct: 0.2,
        amountFixedUsd: null,
        amountCalculatedUsd: 0.2 * deal3Results.totals.revenueUsd,
        counterparty: "Caribbean Airlines",
        paymentMethod: "wire",
      },
    ]);

    await db.insert(schema.fuelDealScenarios).values({
      id: SEED_FUEL_DEAL_SCENARIO_IDS.deal3Base,
      tenantId,
      dealId: SEED_FUEL_DEAL_IDS.deal3,
      scenarioName: "Base Case",
      scenarioType: "base",
      isActive: true,
      sellPricePerUsg: deal3Inputs.sellPricePerUsg,
      resultsJson: deal3Results as unknown as Record<string, unknown>,
      score: deal3Results.scorecard.overallScore,
      recommendation: deal3Results.scorecard.recommendation,
      calculatedAt: now,
      notes:
        "Base case at current Platts Jet. BIS export licence is the gating item — recommendation is do_not_proceed until the licence is issued.",
    });

    // -----------------------------------------------------------------------
    // Sprint 11 — Benchmark prices (fuel_market_rates)
    //
    // Five trailing days: three ULSD rows (Platts USGC ULSD) and two Jet
    // A-1 rows (Platts USGC Jet). Prices are in USD/USG with per-barrel
    // and per-metric-tonne alternates derived at a fixed ULSD density of
    // 0.845 kg/L and Jet A-1 density of 0.800 kg/L. Source is stamped as
    // the benchmark publisher so the rate provenance survives in the UI.
    // -----------------------------------------------------------------------
    const ULSD_USG_PER_MT = 1000 / (0.845 * 3.785411784); // ≈ 312.69
    const JET_USG_PER_MT = 1000 / (0.8 * 3.785411784); // ≈ 330.21
    await db.insert(schema.fuelMarketRates).values([
      {
        id: SEED_FUEL_MARKET_RATE_IDS[0]!,
        tenantId,
        rateDate: "2026-04-13",
        product: "ulsd",
        benchmark: "platts_usgc_ulsd",
        pricePerUsg: 2.38,
        pricePerBbl: 2.38 * 42,
        pricePerMt: 2.38 * ULSD_USG_PER_MT,
        currency: "usd",
        source: "platts",
      },
      {
        id: SEED_FUEL_MARKET_RATE_IDS[1]!,
        tenantId,
        rateDate: "2026-04-14",
        product: "ulsd",
        benchmark: "platts_usgc_ulsd",
        pricePerUsg: 2.4,
        pricePerBbl: 2.4 * 42,
        pricePerMt: 2.4 * ULSD_USG_PER_MT,
        currency: "usd",
        source: "platts",
      },
      {
        id: SEED_FUEL_MARKET_RATE_IDS[2]!,
        tenantId,
        rateDate: "2026-04-15",
        product: "ulsd",
        benchmark: "platts_usgc_ulsd",
        pricePerUsg: 2.41,
        pricePerBbl: 2.41 * 42,
        pricePerMt: 2.41 * ULSD_USG_PER_MT,
        currency: "usd",
        source: "platts",
      },
      {
        id: SEED_FUEL_MARKET_RATE_IDS[3]!,
        tenantId,
        rateDate: "2026-04-16",
        product: "jet_a1",
        benchmark: "platts_usgc_jet",
        pricePerUsg: 2.54,
        pricePerBbl: 2.54 * 42,
        pricePerMt: 2.54 * JET_USG_PER_MT,
        currency: "usd",
        source: "platts",
      },
      {
        id: SEED_FUEL_MARKET_RATE_IDS[4]!,
        tenantId,
        rateDate: "2026-04-17",
        product: "jet_a1",
        benchmark: "platts_usgc_jet",
        pricePerUsg: 2.55,
        pricePerBbl: 2.55 * 42,
        pricePerMt: 2.55 * JET_USG_PER_MT,
        currency: "usd",
        source: "platts",
      },
    ]);

    // -----------------------------------------------------------------------
    // Sprint 11 — Counterparty risk scores
    //
    // One row per seeded Caribbean buyer. Each dimension is 0-100 with
    // higher = riskier; composite_score is the simple arithmetic mean of
    // the eight dimensions. risk_tier reflects the scoring committee's
    // judgement (not a pure function of composite_score), and the
    // recommended payment terms + max exposure capture the policy the
    // desk should enforce on future deals.
    // -----------------------------------------------------------------------
    await db.insert(schema.fuelDealCounterpartyScores).values([
      {
        id: SEED_COUNTERPARTY_SCORE_IDS.massy,
        tenantId,
        orgId: SEED_ORG_IDS.massy,
        scoredBy: SEED_ADMIN_USER_ID,
        countryRisk: 40, // Jamaica — Coface B
        paymentHistoryRisk: 20,
        creditRisk: 30,
        sanctionsExposureRisk: 10,
        ownershipTransparencyRisk: 15,
        regulatoryComplexityRisk: 30,
        operationalRisk: 25,
        concentrationRisk: 15,
        compositeScore: 23.125,
        riskTier: "tier_2",
        recommendedPaymentTerms: "LC at sight, confirmed by US money-center bank",
        recommendedMaxExposureUsd: 8_000_000,
        notes:
          "Long-standing Caribbean buyer. Payment history clean; LC confirmation required due to sovereign banking risk.",
      },
      {
        id: SEED_COUNTERPARTY_SCORE_IDS.punta,
        tenantId,
        orgId: SEED_ORG_IDS.punta,
        scoredBy: SEED_ADMIN_USER_ID,
        countryRisk: 55, // Dominican Republic — Coface B
        paymentHistoryRisk: 30,
        creditRisk: 40,
        sanctionsExposureRisk: 15,
        ownershipTransparencyRisk: 25,
        regulatoryComplexityRisk: 35,
        operationalRisk: 30,
        concentrationRisk: 20,
        compositeScore: 31.25,
        riskTier: "tier_2",
        recommendedPaymentTerms: "LC at sight + political risk insurance",
        recommendedMaxExposureUsd: 6_000_000,
        notes:
          "Moderate exposure. Political risk cover required for any single-shipment value above $3M.",
      },
      {
        id: SEED_COUNTERPARTY_SCORE_IDS.caribAir,
        tenantId,
        orgId: SEED_ORG_IDS.caribAir,
        scoredBy: SEED_ADMIN_USER_ID,
        countryRisk: 35, // Trinidad & Tobago — Coface A4
        paymentHistoryRisk: 15,
        creditRisk: 20,
        sanctionsExposureRisk: 5,
        ownershipTransparencyRisk: 10, // state-owned, high transparency
        regulatoryComplexityRisk: 25,
        operationalRisk: 20,
        concentrationRisk: 15,
        compositeScore: 18.125,
        riskTier: "tier_1",
        recommendedPaymentTerms: "Prepayment 80/20 or LC at sight",
        recommendedMaxExposureUsd: 10_000_000,
        notes:
          "State-owned flag carrier. Strong credit profile, preferred counterparty for Jet A-1 volume.",
      },
    ]);

    // eslint-disable-next-line no-console
    console.log("seed complete");
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
