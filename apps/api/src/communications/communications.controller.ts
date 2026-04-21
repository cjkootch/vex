import {
  Controller,
  Get,
  Inject,
  NotFoundException,
  Param,
  Query,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard, TenantContext } from "../auth/index.js";
import {
  withTenant,
  type ActivityRepository,
  type Db,
  type TouchpointRepository,
} from "@vex/db";

/**
 * GET /communications — unified inbox feed.
 *
 * Merges touchpoints (email / SMS / WhatsApp events) and voice-call
 * activities into a single descending-by-time stream so the operator
 * UI has one place to audit what has been said across every channel.
 *
 * Filters:
 *   - `channel` — repeatable. One of `email` / `sms` / `whatsapp` /
 *     `call`. Touchpoint channels encode the event type in the suffix
 *     (e.g. `email.opened`); the repo matches `email.%` when `email`
 *     is passed. `call` pulls from the activities table instead.
 *   - `direction` — `inbound` / `outbound`. Only applies to
 *     touchpoints; calls are always outbound in Sprint 12.
 *   - `contact_id`, `campaign_id` — exact-match filters. `campaign_id`
 *     filters touchpoints only (calls don't carry a campaign link).
 *   - `before` — ISO-8601 timestamp for keyset pagination. The next
 *     page's `before` is the `occurredAt` of the last item returned.
 *   - `limit` — default 50, capped at 100.
 *
 * Response shape is stable — the UI fans out on `kind`.
 */

export const COMMUNICATIONS_DB_CLIENT = Symbol("COMMUNICATIONS_DB_CLIENT");
export const COMMUNICATIONS_TOUCHPOINT_REPO = Symbol(
  "COMMUNICATIONS_TOUCHPOINT_REPO",
);
export const COMMUNICATIONS_ACTIVITY_REPO = Symbol(
  "COMMUNICATIONS_ACTIVITY_REPO",
);

export type ChannelFilter = "email" | "sms" | "whatsapp" | "call";
const ALLOWED_CHANNELS: readonly ChannelFilter[] = [
  "email",
  "sms",
  "whatsapp",
  "call",
];

export type DirectionFilter = "inbound" | "outbound";

export type CommunicationItem =
  | {
      kind: "touchpoint";
      id: string;
      channel: string;
      channelGroup: "email" | "sms" | "whatsapp" | "other";
      direction: DirectionFilter | null;
      occurredAt: string;
      contactId: string | null;
      campaignId: string | null;
      preview: string | null;
      metadata: Record<string, unknown>;
    }
  | {
      kind: "call";
      id: string;
      occurredAt: string;
      contactId: string | null;
      workflowId: string | null;
      callSid: string | null;
      status: string | null;
      durationSeconds: number | null;
      transcriptRef: string | null;
    };

export interface CommunicationsFeedResponse {
  items: CommunicationItem[];
  nextBefore: string | null;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

@Controller("communications")
@UseGuards(JwtAuthGuard)
export class CommunicationsController {
  constructor(
    @Inject(TenantContext) private readonly tenant: TenantContext,
    @Inject(COMMUNICATIONS_DB_CLIENT) private readonly db: Db,
    @Inject(COMMUNICATIONS_TOUCHPOINT_REPO)
    private readonly touchpoints: TouchpointRepository,
    @Inject(COMMUNICATIONS_ACTIVITY_REPO)
    private readonly activities: ActivityRepository,
  ) {}

  @Get()
  async feed(
    @Query("channel") rawChannel: string | string[] | undefined,
    @Query("direction") rawDirection: string | undefined,
    @Query("contact_id") contactId: string | undefined,
    @Query("campaign_id") campaignId: string | undefined,
    @Query("before") rawBefore: string | undefined,
    @Query("limit") rawLimit: string | undefined,
  ): Promise<CommunicationsFeedResponse> {
    const channels = parseChannels(rawChannel);
    const direction = parseDirection(rawDirection);
    const before = parseBefore(rawBefore);
    const limit = parseLimit(rawLimit);

    // Channels that map to touchpoints (`call` is excluded — calls live
    // in the activities table).
    const touchpointGroups = channels.filter((c) => c !== "call");
    const wantsCalls = channels.length === 0 || channels.includes("call");
    const wantsTouchpoints =
      channels.length === 0 || touchpointGroups.length > 0;

    return withTenant(this.db, this.tenant.tenantId, async (tx) => {
      const [tpRows, callRows] = await Promise.all([
        wantsTouchpoints
          ? this.touchpoints.listFeed(
              tx,
              {
                ...(touchpointGroups.length > 0
                  ? { channelGroups: touchpointGroups }
                  : {}),
                ...(direction ? { direction } : {}),
                ...(contactId ? { contactId } : {}),
                ...(campaignId ? { campaignId } : {}),
                ...(before ? { before } : {}),
              },
              limit,
            )
          : Promise.resolve([]),
        wantsCalls && !campaignId
          ? this.activities.listFeed(
              tx,
              {
                type: "voice_call",
                ...(contactId ? { contactId } : {}),
                ...(before ? { before } : {}),
              },
              limit,
            )
          : Promise.resolve([]),
      ]);

      const tpItems: CommunicationItem[] = tpRows.map((t) => {
        const meta = (t.metadata ?? {}) as Record<string, unknown>;
        const direction =
          typeof meta["direction"] === "string"
            ? (meta["direction"] as DirectionFilter)
            : null;
        return {
          kind: "touchpoint",
          id: t.id,
          channel: t.channel,
          channelGroup: channelGroupFor(t.channel),
          direction,
          occurredAt: t.occurredAt.toISOString(),
          contactId: t.contactId,
          campaignId: t.campaignId,
          preview: extractPreview(meta),
          metadata: meta,
        };
      });

      const callItems: CommunicationItem[] = callRows.map((a) => {
        const meta = (a.metadata ?? {}) as Record<string, unknown>;
        const related = (a.relatedObjectIds ?? {}) as Record<string, unknown>;
        return {
          kind: "call",
          id: a.id,
          occurredAt: a.occurredAt.toISOString(),
          contactId:
            typeof related["contact_id"] === "string"
              ? (related["contact_id"] as string)
              : null,
          workflowId:
            typeof meta["session_id"] === "string"
              ? (meta["session_id"] as string)
              : null,
          callSid:
            typeof meta["call_sid"] === "string"
              ? (meta["call_sid"] as string)
              : null,
          status:
            typeof meta["status"] === "string"
              ? (meta["status"] as string)
              : a.result,
          durationSeconds: a.durationSeconds,
          transcriptRef: a.transcriptRef,
        };
      });

      const merged = [...tpItems, ...callItems]
        .sort((a, b) => (a.occurredAt < b.occurredAt ? 1 : -1))
        .slice(0, limit);

      const nextBefore =
        merged.length === limit
          ? (merged[merged.length - 1]?.occurredAt ?? null)
          : null;

      return { items: merged, nextBefore };
    });
  }

  /**
   * GET /communications/activities/:id — full drill-in payload for a
   * voice_call activity. Returns the raw metadata/result/duration so
   * the inbox detail page can render recording links, status history,
   * script or scenario used, etc. 404 if the id belongs to another
   * tenant (RLS in withTenant hides it).
   */
  @Get("activities/:id")
  async activity(@Param("id") id: string): Promise<{
    id: string;
    type: string;
    occurredAt: string;
    result: string | null;
    durationSeconds: number | null;
    transcriptRef: string | null;
    metadata: Record<string, unknown>;
    relatedObjectIds: Record<string, unknown>;
  }> {
    const row = await withTenant(this.db, this.tenant.tenantId, async (tx) =>
      this.activities.findById(tx, id),
    );
    if (!row) throw new NotFoundException();
    return {
      id: row.id,
      type: row.type,
      occurredAt: row.occurredAt.toISOString(),
      result: row.result,
      durationSeconds: row.durationSeconds,
      transcriptRef: row.transcriptRef,
      metadata: (row.metadata ?? {}) as Record<string, unknown>,
      relatedObjectIds: (row.relatedObjectIds ?? {}) as Record<string, unknown>,
    };
  }

  /**
   * GET /communications/touchpoints/:id — drill-in payload for an
   * email / sms / whatsapp touchpoint. Returns channel + actor +
   * contact/org linkage + full metadata (subject, from, to, body_text,
   * body_html). The inbox detail page reads this so operators can see
   * the full email body, not just the 240-char preview.
   */
  @Get("touchpoints/:id")
  async touchpoint(@Param("id") id: string): Promise<{
    id: string;
    channel: string;
    actor: string | null;
    occurredAt: string;
    contactId: string | null;
    orgId: string | null;
    campaignId: string | null;
    metadata: Record<string, unknown>;
  }> {
    const row = await withTenant(this.db, this.tenant.tenantId, async (tx) =>
      this.touchpoints.findById(tx, id),
    );
    if (!row) throw new NotFoundException();
    return {
      id: row.id,
      channel: row.channel,
      actor: row.actor,
      occurredAt: row.occurredAt.toISOString(),
      contactId: row.contactId,
      orgId: row.orgId,
      campaignId: row.campaignId,
      metadata: (row.metadata ?? {}) as Record<string, unknown>,
    };
  }
}

function parseChannels(raw: string | string[] | undefined): ChannelFilter[] {
  if (!raw) return [];
  const values = Array.isArray(raw)
    ? raw.flatMap((v) => v.split(","))
    : raw.split(",");
  return values
    .map((v) => v.trim().toLowerCase())
    .filter((v): v is ChannelFilter =>
      (ALLOWED_CHANNELS as readonly string[]).includes(v),
    );
}

function parseDirection(raw: string | undefined): DirectionFilter | undefined {
  if (raw === "inbound" || raw === "outbound") return raw;
  return undefined;
}

function parseBefore(raw: string | undefined): Date | undefined {
  if (!raw) return undefined;
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return undefined;
  return parsed;
}

function parseLimit(raw: string | undefined): number {
  if (!raw) return DEFAULT_LIMIT;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(n, MAX_LIMIT);
}

function channelGroupFor(
  channel: string,
): "email" | "sms" | "whatsapp" | "other" {
  if (channel.startsWith("email.")) return "email";
  if (channel.startsWith("sms.")) return "sms";
  if (channel.startsWith("whatsapp.")) return "whatsapp";
  return "other";
}

/**
 * Best-effort preview for a touchpoint row. Normalizers stash the
 * relevant field under different keys depending on the provider —
 * the UI wants a single string to render so the channels look
 * consistent even when the underlying data isn't.
 */
function extractPreview(meta: Record<string, unknown>): string | null {
  const candidates = [
    meta["text"],
    meta["body"],
    meta["subject"],
    meta["preview"],
    meta["url"],
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c.length > 0) {
      return c.length > 240 ? `${c.slice(0, 237)}…` : c;
    }
  }
  return null;
}
