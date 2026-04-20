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
    /**
     * Sprint V — which book this deal lives in. Controls which
     * products are valid, whether density is required, and which
     * downstream signal rules apply. Default 'fuel' keeps legacy
     * agent proposals valid.
     */
    lineOfBusiness: z.enum(["fuel", "food"]).default("fuel"),
    product: z.enum([
      // Fuel
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
      // Food
      "rice",
      "beans",
      "pork",
      "chicken",
      "cooking_oil",
      "powdered_milk",
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
    /** Unit the `volumeUsg` field is denominated in. Food defaults to MT. */
    volumeUnit: z
      .enum(["usg", "mt", "kg", "lbs", "containers"])
      .default("usg"),
    /** Required for fuel; optional for food (no density concept). */
    densityKgL: z.number().positive().max(2).optional(),
    /** Food-only: weeks between PO and shipment-ready. */
    productionLeadTimeWeeks: z.number().int().min(0).max(52).optional(),
    /** Food-only: reefer / cold-chain flag (pork, chicken, dairy). */
    coldChainRequired: z.boolean().optional(),
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
      "negotiating",
      "pending_approval",
      "approved",
      "loading",
      "in_transit",
      "delivered",
      "settled",
      "cancelled",
      "failed",
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
    /**
     * When true, the workflow opens the AI talkback Media Stream
     * instead of a conference bridge — Vex holds the conversation
     * directly via OpenAI Realtime. Default false keeps the
     * operator-join conference path for backwards-compatibility.
     */
    aiMode: z.boolean().optional(),
    /**
     * Custom system prompt for the AI conversation (requires aiMode).
     * Overrides the built-in fuel-qualifier prompt. Useful when the
     * user types "have Vex call John and ask about their BL timing
     * on deal 003" — the agent crafts a focused scenario rather
     * than running the generic qualifier script.
     */
    aiInstructions: z.string().min(1).max(5000).optional(),
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
  // Record a shipment / compliance / payment milestone against a
  // fuel deal. Writes a structured event row so the deal timeline +
  // summary views surface it. The specific milestone types reflect
  // the VTC workflow — BL issued, cargo loaded, OFAC cleared, etc.
  // T1 because milestones are factual records, not outbound action.
  z.object({
    kind: z.literal("deal.milestone"),
    tier: z.literal(ApprovalTier.T1),
    dealId: zUlid,
    milestone: z.enum([
      "bis_license_issued",
      "ofac_cleared",
      "contract_signed",
      "prepayment_received",
      "product_purchased",
      // Sprint V (food line of business)
      "production_started",
      "fumigation_complete",
      "inspection_passed",
      "cargo_loaded",
      "vessel_departed",
      "bl_issued",
      "vessel_arrived",
      "cargo_discharged",
      "final_payment_received",
      "deal_closed",
    ]),
    /** Actual timestamp this happened (ISO-8601 UTC). Defaults to now. */
    occurredAt: z
      .string()
      .regex(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?Z$/,
        "occurredAt must be ISO-8601 UTC (e.g. 2026-04-25T15:00:00Z)",
      )
      .optional(),
    note: z.string().max(2000).optional(),
    rationale: z.string().max(500).optional(),
  }),
  // Catch-all for commands outside the current action catalog. The
  // executor logs a structured event so operators can review what
  // users are asking for but can't get done — this turns capability
  // gaps into a product-feedback signal instead of the AI
  // hallucinating or refusing opaquely. Always T1 (just a log).
  z.object({
    kind: z.literal("unsupported_request"),
    tier: z.literal(ApprovalTier.T1),
    /** The user's original chat message, as they wrote it. */
    originalCommand: z.string().min(1).max(2000),
    /** Why the AI couldn't fulfil it. */
    reason: z.string().min(1).max(500),
    /** Closest supported action, if any. Empty when there's no good fit. */
    suggestion: z.string().max(500).optional(),
  }),
  // Sprint W — counterparty modelling.
  //
  // org.set_kind: classify an org as buyer / supplier / broker /
  // buyer_broker / internal / competitor. Tier T1 (low risk, purely
  // an attribute flip, fully reversible). Use when the user says
  // "Acme is a rice broker", "tag Cibao Foods as a buyer", etc.
  z.object({
    kind: z.literal("org.set_kind"),
    tier: z.literal(ApprovalTier.T1),
    orgId: zUlid,
    orgKind: z.enum([
      "buyer",
      "supplier",
      "broker",
      "buyer_broker",
      "internal",
      "competitor",
    ]),
    rationale: z.string().max(500).optional(),
  }),
  // org.add_product: tag an org with a product it deals in.
  // Attaches to both suppliers and brokers. A broker whose upstream
  // suppliers are unknown gets product rows without relationships —
  // that's the clean "opaque upstream" pattern. Tier T1.
  z.object({
    kind: z.literal("org.add_product"),
    tier: z.literal(ApprovalTier.T1),
    orgId: zUlid,
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
      "rice",
      "beans",
      "pork",
      "chicken",
      "cooking_oil",
      "powdered_milk",
    ]),
    notes: z.string().max(1000).optional(),
    rationale: z.string().max(500).optional(),
  }),
  // org.link_relationship: directed edge between two orgs. Primary
  // use-case is "Broker A brokers_for Supplier B" with optional
  // product. Leave product null when the relationship spans every
  // product they have in common. Tier T1.
  z.object({
    kind: z.literal("org.link_relationship"),
    tier: z.literal(ApprovalTier.T1),
    fromOrgId: zUlid,
    toOrgId: zUlid,
    relationshipType: z.enum([
      "brokers_for",
      "sources_from",
      "partners_with",
      "subsidiary_of",
    ]),
    product: z
      .enum([
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
        "rice",
        "beans",
        "pork",
        "chicken",
        "cooking_oil",
        "powdered_milk",
      ])
      .optional(),
    notes: z.string().max(1000).optional(),
    rationale: z.string().max(500).optional(),
  }),
  // deal.set_broker: attach a buy-side or sell-side broker to an
  // existing deal with their own commission + payment terms.
  // Payment terms are free-form text so the agent can capture
  // whatever structure the user describes ("1.5% on delivery",
  // "$0.002/USG wired at BL", "flat $5k on signing"). Tier T2 —
  // material impact on deal economics.
  z.object({
    kind: z.literal("deal.set_broker"),
    tier: z.literal(ApprovalTier.T2),
    dealId: zUlid,
    side: z.enum(["buy", "sell"]),
    brokerOrgId: zUlid,
    commissionPct: z.number().min(0).max(1).optional(),
    paymentTerms: z.string().max(500).optional(),
    rationale: z.string().max(500).optional(),
  }),
  // lead.reactivate_draft: trigger a multi-step reactivation
  // workflow. One operator approval kicks off an agent run that:
  //   1) loads each named contact + their org + recent activity
  //   2) drafts a personalised re-engagement email per contact via
  //      Claude (market-outreach prompt)
  //   3) creates one pending email.send approval per contact
  // Operator reviews each draft individually in the inbox. The
  // parent approval is T2 because it spawns N downstream
  // email.send approvals; each draft stays T2 too so the human
  // reviews copy before it leaves the building.
  //
  // Claude supplies the contact ids directly from the evidence
  // pack (up to 20). productContext + angle are free-form strings
  // the reactivation agent feeds into the per-contact Claude call
  // so every draft shares the same thesis (e.g. "Q3 parboiled rice
  // availability", "LC60D terms opened"). The operator's "why now"
  // sits in `rationale`.
  z.object({
    kind: z.literal("lead.reactivate_draft"),
    tier: z.literal(ApprovalTier.T2),
    contactIds: z.array(zUlid).min(1).max(20),
    productContext: z.string().min(1).max(500),
    angle: z.string().min(1).max(500).optional(),
    rationale: z.string().min(1).max(1000),
  }),
  // touchpoint.log: record a manual touchpoint (phone call, meeting,
  // off-platform chat) that the operator had with a contact or org.
  // Lands a touchpoint row so the contact timeline stays complete
  // even for interactions Vex didn't drive. Tier T1 — purely a log
  // write, no outbound effect.
  //
  // At least one of contactId/orgId/dealId must be set; we enforce
  // that in the executor rather than via Zod refine() because
  // discriminatedUnion rejects ZodEffects members. The prompt tells
  // Claude to include at least one. Channel values are scoped to
  // manual entries so they don't collide with provider-emitted
  // channels (email.resend, sms.twilio, etc).
  z.object({
    kind: z.literal("touchpoint.log"),
    tier: z.literal(ApprovalTier.T1),
    contactId: zUlid.optional(),
    orgId: zUlid.optional(),
    dealId: zUlid.optional(),
    channel: z.enum([
      "voice.manual",
      "meeting",
      "chat.manual",
      "email.manual",
      "other",
    ]),
    direction: z.enum(["inbound", "outbound"]).optional(),
    occurredAt: z.string().datetime().optional(),
    note: z.string().min(1).max(2000),
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
