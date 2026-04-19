import { z } from "zod";
import {
  ApprovalTier,
  isUlid,
  requiresApproval,
  type ApprovalTier as ApprovalTierT,
} from "@vex/domain";

const zUlid = z.string().refine(isUlid, { message: "expected ULID" });

/**
 * Typed descriptor for an action an agent wants to take. The descriptor is
 * what gets stored on the `approvals.proposed_payload` column so reviewers
 * see exactly what they're approving — no free-form strings or raw tool-call
 * blobs.
 */
export const ActionDescriptor = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("email.send"),
    tier: z.literal(ApprovalTier.T2),
    to: z.array(z.string().email()).min(1),
    subject: z.string().min(1),
    body: z.string().min(1),
  }),
  z.object({
    kind: z.literal("crm.note"),
    tier: z.literal(ApprovalTier.T1),
    organizationId: zUlid,
    body: z.string().min(1),
  }),
  z.object({
    kind: z.literal("lead.close"),
    tier: z.literal(ApprovalTier.T3),
    leadId: zUlid,
    outcome: z.enum(["won", "lost"]),
    reason: z.string().min(1),
  }),
  // Sprint 14 Group 4 — chat-initiated CRM writes. The agent proposes
  // the shape; the approval executor applies it after a human approves.
  z.object({
    kind: z.literal("crm.create_company"),
    tier: z.literal(ApprovalTier.T2),
    legalName: z.string().min(1).max(200),
    domain: z.string().max(255).optional(),
    industry: z.string().max(120).optional(),
    rationale: z.string().min(1).max(1000),
  }),
  z.object({
    kind: z.literal("crm.create_contact"),
    tier: z.literal(ApprovalTier.T2),
    fullName: z.string().min(1).max(200),
    title: z.string().max(200).optional(),
    emails: z.array(z.string().email()).max(10).optional(),
    phones: z.array(z.string().max(40)).max(10).optional(),
    // Exactly one org must be marked primary — the executor enforces.
    orgs: z
      .array(
        z.object({
          orgId: zUlid,
          role: z.string().max(200).optional(),
          isPrimary: z.boolean().optional(),
        }),
      )
      .min(1)
      .max(20),
    rationale: z.string().min(1).max(1000),
  }),
  z.object({
    kind: z.literal("crm.create_deal"),
    tier: z.literal(ApprovalTier.T2),
    dealRef: z.string().min(1).max(50),
    product: z.enum([
      "ulsd",
      "gasoline_87",
      "gasoline_91",
      "jet_a",
      "jet_a1",
      "avgas",
      "lfo",
      "hfo",
      "lng",
      "lpg",
      "biodiesel_b20",
    ]),
    incoterm: z.enum(["fob", "cif", "cfr", "dap", "exw", "fas"]),
    pricingBasis: z.enum([
      "platts",
      "argus",
      "opis",
      "nymex_wti",
      "nymex_rbob",
      "ice_brent",
      "fixed",
      "negotiated",
    ]),
    paymentTerms: z.enum([
      "prepayment_100",
      "prepayment_80_20",
      "lc_sight",
      "lc_60d",
      "lc_90d",
      "lc_120d",
      "sblc",
      "open_account",
      "telegraphic_transfer",
      "mixed",
    ]),
    volumeUsg: z.number().positive(),
    densityKgL: z.number().positive().max(2),
    buyerOrgId: zUlid,
    destinationPort: z.string().optional(),
    laycanStart: z.string().optional(),
    laycanEnd: z.string().optional(),
    notes: z.string().optional(),
    rationale: z.string().min(1).max(1000),
  }),
  // Sprint M — chat-initiated marketing enrollment. The agent proposes
  // a batch of contacts to enroll in an existing campaign plan; the
  // approval executor (Sprint F) starts one CampaignEnrollmentWorkflow
  // per contact once approved.
  z.object({
    kind: z.literal("campaign.enroll_batch"),
    tier: z.literal(ApprovalTier.T2),
    campaignId: zUlid,
    contactIds: z.array(zUlid).min(1).max(500),
    rationale: z.string().min(1).max(1000),
  }),
  // Sprint N — chat-initiated one-off messaging. The agent proposes a
  // single SMS or WhatsApp message at a specific phone number. On
  // approve, the executor fires through Twilio's Messages API and
  // records the result as an `sms.sent`/`whatsapp.sent` touchpoint.
  z.object({
    kind: z.literal("sms.send"),
    tier: z.literal(ApprovalTier.T2),
    to: z
      .string()
      .regex(/^\+[1-9]\d{7,14}$/, "to must be E.164 (e.g. +18324927169)"),
    body: z.string().min(1).max(1_500),
    contactId: zUlid.optional(),
    rationale: z.string().min(1).max(1000),
  }),
  z.object({
    kind: z.literal("whatsapp.send"),
    tier: z.literal(ApprovalTier.T2),
    to: z
      .string()
      .regex(/^\+[1-9]\d{7,14}$/, "to must be E.164 (e.g. +18324927169)"),
    body: z.string().min(1).max(1_500),
    contactId: zUlid.optional(),
    rationale: z.string().min(1).max(1000),
  }),
  // Sprint N — chat-initiated deal status transition. Matches the
  // executor branch that's already wired (applyDealStatusChange).
  // Tier T2 because it has meaningful downstream effects but is
  // reversible at the DB level.
  z.object({
    kind: z.literal("deal.status_change"),
    tier: z.literal(ApprovalTier.T2),
    deal_id: zUlid,
    to_status: z.enum([
      "draft",
      "qualified",
      "proposed",
      "negotiating",
      "approved",
      "cancelled",
      "closed_won",
      "closed_lost",
    ]),
    from_status: z.string().optional(),
    rationale: z.string().min(1).max(1000),
  }),
  // Sprint N — opt a contact out of all outbound outreach. Tier T2
  // because it's reversible but changes the suppression default that
  // the call/email workflows honour.
  z.object({
    kind: z.literal("contact.opt_out"),
    tier: z.literal(ApprovalTier.T2),
    contactId: zUlid,
    reason: z.string().min(1).max(500),
  }),
  // Sprint O — chat-initiated outbound voice call. Tier T3 because
  // it dials a real phone line; the approval executor starts the
  // same OutboundCallWorkflow that POST /calls triggers. Mirrors
  // the existing proposed_payload shape so the workflow + approval
  // gate code paths are identical.
  z.object({
    kind: z.literal("outbound_call"),
    tier: z.literal(ApprovalTier.T3),
    contactId: zUlid,
    orgId: zUlid,
    toNumber: z
      .string()
      .regex(/^\+[1-9]\d{7,14}$/, "toNumber must be E.164 (e.g. +18324927169)"),
    rationale: z.string().min(1).max(1000),
  }),
  // Sprint O — steer an in-flight CampaignEnrollmentWorkflow without
  // unsubscribing the contact entirely. The executor signals the
  // workflow via its `enrollment.control` signal. Note: tier is T2
  // because pause/resume are reversible; unsubscribe is irreversible
  // within the workflow and should trigger the existing
  // contact.opt_out flow instead for the cleanest audit trail.
  z.object({
    kind: z.literal("enrollment.control"),
    tier: z.literal(ApprovalTier.T2),
    enrollmentId: zUlid,
    action: z.enum(["pause", "resume", "unsubscribe"]),
    note: z.string().max(500).optional(),
    rationale: z.string().min(1).max(1000),
  }),
  // Sprint O — append a free-form tag to an organization. Tier T1
  // because it's low risk + easily reversed. Multiple tags per row
  // are stored as a JSONB string array; appendTag is idempotent.
  z.object({
    kind: z.literal("org.tag"),
    tier: z.literal(ApprovalTier.T1),
    orgId: zUlid,
    tag: z.string().min(1).max(64),
    rationale: z.string().max(500).optional(),
  }),
  z.object({
    kind: z.literal("org.untag"),
    tier: z.literal(ApprovalTier.T1),
    orgId: zUlid,
    tag: z.string().min(1).max(64),
    rationale: z.string().max(500).optional(),
  }),
  z.object({
    kind: z.literal("contact.tag"),
    tier: z.literal(ApprovalTier.T1),
    contactId: zUlid,
    tag: z.string().min(1).max(64),
    rationale: z.string().max(500).optional(),
  }),
  z.object({
    kind: z.literal("contact.untag"),
    tier: z.literal(ApprovalTier.T1),
    contactId: zUlid,
    tag: z.string().min(1).max(64),
    rationale: z.string().max(500).optional(),
  }),
  // Sprint P — schedule a deferred follow-up. Backs "remind me
  // about Acme next Thursday" AND "assign this to Jane" (via
  // assignedTo). Executor inserts a follow_ups row; the
  // /app/follow-ups UI + optional cron surface them when due.
  z.object({
    kind: z.literal("follow_up.schedule"),
    tier: z.literal(ApprovalTier.T1),
    title: z.string().min(1).max(200),
    note: z.string().max(2000).optional(),
    /** ISO-8601 UTC timestamp when the follow-up is due. */
    dueAt: z
      .string()
      .regex(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?Z$/,
        "dueAt must be ISO-8601 UTC (e.g. 2026-04-25T15:00:00Z)",
      ),
    subjectType: z
      .enum(["organization", "contact", "deal", "enrollment", "campaign"])
      .optional(),
    subjectId: zUlid.optional(),
    assignedTo: z.string().max(200).optional(),
    rationale: z.string().max(500).optional(),
  }),
]);

export type ActionDescriptorT = z.infer<typeof ActionDescriptor>;

/**
 * Returns true iff executing the action requires a decided-approved approval
 * row. The tier is captured on the descriptor itself so it can't drift from
 * the action shape.
 */
export function actionRequiresApproval(action: ActionDescriptorT): boolean {
  const tier: ApprovalTierT = action.tier;
  return requiresApproval(tier);
}
