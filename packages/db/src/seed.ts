import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { loadEnv } from "@vex/config";
import { createId } from "@vex/domain";
import * as schema from "./schema/index.js";
import {
  SEED_ADMIN_USER_ID,
  SEED_CAMPAIGN_IDS,
  SEED_CONTACT_IDS,
  SEED_EVENT_IDS,
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
  const db = drizzle(pool, { schema });

  const tenantId = SEED_WORKSPACE_ID;
  const now = new Date();

  try {
    await db.insert(schema.workspaces).values({
      id: SEED_WORKSPACE_ID,
      name: "Acme Demo",
      plan: "pro",
      settings: {
        source_priority: ["internal", "apollo", "ga4", "resend"],
        enabled_agents: ["qualifier", "composer"],
        daily_cost_limit: 50,
        kill_all_agents: false,
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
    const channels = ["email", "paid_search", "outbound", "organic", "referral"];
    await db.insert(schema.touchpoints).values(
      SEED_TOUCHPOINT_IDS.map((id, i) => ({
        id,
        tenantId,
        channel: channels[i % channels.length]!,
        actor: i % 2 === 0 ? "agent.composer" : "human.sdr",
        occurredAt: new Date(now.getTime() - i * 3_600_000),
        campaignId: campaignIds[i % campaignIds.length]!,
        leadId: null,
        contactId: SEED_CONTACT_IDS[i % SEED_CONTACT_IDS.length]!,
        orgId: orgIds[i % orgIds.length]!,
        metadata: { subject: `Touch #${i + 1}` },
      })),
    );

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

    // eslint-disable-next-line no-console
    console.log("seed complete");
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
