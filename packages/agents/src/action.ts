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
