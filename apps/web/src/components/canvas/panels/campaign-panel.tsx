"use client";

import type { ManifestPanel } from "@vex/ui";

type CampaignProps = Extract<ManifestPanel, { type: "campaign" }>;

/** Per invariant — open_rate is image-pixel-tracked and never reliable. The
 *  label is hardcoded; the model can't suppress it. */
const OPEN_RATE_DISCLAIMER = "Open rate (unreliable — image tracking)";

export function CampaignPanel({
  campaignId,
  sent,
  delivered,
  clicked,
  opened,
  bounced,
  click_rate,
  open_rate,
  open_confidence,
}: CampaignProps) {
  return (
    <section
      data-panel="campaign"
      className="rounded-lg border border-line bg-muted/40 p-4"
    >
      <header className="mb-3">
        <h3 className="text-sm font-semibold text-white">Campaign {campaignId}</h3>
      </header>

      <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Metric label="Sent" value={sent} />
        <Metric label="Delivered" value={delivered} />
        <Metric label="Clicked" value={clicked} />
        <Metric label="Bounced" value={bounced} />
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="rounded-md border border-good/40 bg-good/5 p-3">
          <div className="text-xs uppercase tracking-wider text-white/40">
            Click rate (strong signal)
          </div>
          <div className="mt-1 text-2xl font-semibold text-white">
            {(click_rate * 100).toFixed(1)}%
          </div>
        </div>
        <div className="rounded-md border border-warn/40 bg-warn/5 p-3">
          <div className="text-xs uppercase tracking-wider text-warn">
            {OPEN_RATE_DISCLAIMER}
          </div>
          <div className="mt-1 text-2xl font-semibold text-white/80">
            {(open_rate * 100).toFixed(1)}%
          </div>
          <div className="text-xs text-white/40">
            {opened} opens · open_confidence: {open_confidence}
          </div>
        </div>
      </div>
    </section>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md border border-line/60 bg-canvas/40 p-3">
      <div className="text-xs uppercase tracking-wider text-white/40">{label}</div>
      <div className="mt-1 text-xl font-semibold text-white">{value.toLocaleString()}</div>
    </div>
  );
}
