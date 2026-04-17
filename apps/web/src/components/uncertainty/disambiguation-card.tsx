"use client";

import { useState } from "react";
import { vexCopy } from "@vex/ui";
import type { ManifestPanel } from "@vex/ui";
import { useVexQuery } from "@/lib/use-vex-query";

/**
 * Inline disambiguation + confirmation cards for the conversation
 * thread. Two reusable presentational components plus the thin
 * manifest-panel adapters the ComponentRegistry mounts.
 *
 * Architecture note: the panel adapters instantiate their own
 * useVexQuery() and call send() with the follow-up. The parent thread
 * owns its own useVexQuery for the primary stream, so the follow-up
 * response lands in the adapter's hook state — a proper
 * VexQueryContext is a follow-up change set. For now the panel
 * dismisses itself on click so the stale card doesn't linger.
 */

// ---------------------------------------------------------------------------
// Presentational components — explicit callbacks, no side effects.
// ---------------------------------------------------------------------------

export interface DisambiguationOption {
  id: string;
  label: string;
  sublabel?: string;
  confidence: number;
}

export interface DisambiguationCardProps {
  question: string;
  options: DisambiguationOption[];
  onSelect: (id: string) => void;
  onDismiss: () => void;
}

export function DisambiguationCard({
  question,
  options,
  onSelect,
  onDismiss,
}: DisambiguationCardProps) {
  return (
    <section
      data-card="disambiguation"
      className="rounded-lg border border-line bg-muted/40 p-4"
    >
      <p className="mb-3 text-sm text-white/70">{question}</p>
      <ul className="space-y-2">
        {options.map((o) => (
          <li key={o.id}>
            <button
              type="button"
              onClick={() => onSelect(o.id)}
              className="flex w-full items-center gap-3 rounded-md border border-line bg-canvas/40 px-3 py-2 text-left transition hover:border-white/30 hover:bg-canvas/60"
            >
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm text-white">{o.label}</div>
                {o.sublabel ? (
                  <div className="truncate text-xs text-white/50">
                    {o.sublabel}
                  </div>
                ) : null}
              </div>
              <ConfidenceBar value={o.confidence} />
            </button>
          </li>
        ))}
      </ul>
      <button
        type="button"
        onClick={onDismiss}
        className="mt-3 text-xs text-white/50 underline-offset-2 hover:text-white/80 hover:underline"
      >
        Neither of these
      </button>
    </section>
  );
}

export interface ConfirmEntityCardProps {
  entity: string;
  sublabel?: string;
  onConfirm: () => void;
  onCorrect: () => void;
}

export function ConfirmEntityCard({
  entity,
  sublabel,
  onConfirm,
  onCorrect,
}: ConfirmEntityCardProps) {
  return (
    <section
      data-card="confirm-entity"
      className="rounded-lg border border-line bg-muted/40 p-4"
    >
      <p className="mb-3 text-sm text-white/70">
        I think this is <span className="text-white">{entity}</span>
        {sublabel ? (
          <span className="text-white/50"> — {sublabel}</span>
        ) : null}
        . Correct?
      </p>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={onConfirm}
          className="rounded-md border border-line bg-white/10 px-3 py-1.5 text-sm text-white transition hover:bg-white/20"
        >
          Confirm
        </button>
        <button
          type="button"
          onClick={onCorrect}
          className="rounded-md border border-line bg-transparent px-3 py-1.5 text-sm text-white/70 transition hover:bg-white/5 hover:text-white"
        >
          Not this one
        </button>
      </div>
    </section>
  );
}

function ConfidenceBar({ value }: { value: number }) {
  const pct = Math.round(Math.max(0, Math.min(1, value)) * 100);
  return (
    <div
      className="h-1 w-16 flex-shrink-0 overflow-hidden rounded-full bg-white/10"
      aria-label={`${pct}% confident`}
    >
      <div className="h-full bg-emerald-400/70" style={{ width: `${pct}%` }} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Manifest panel adapters — registered in registry.ts. Wire the cards
// above to useVexQuery and local dismissed state.
// ---------------------------------------------------------------------------

type DisambiguationManifestProps = Extract<
  ManifestPanel,
  { type: "disambiguation" }
>;
type ConfirmEntityManifestProps = Extract<
  ManifestPanel,
  { type: "confirm_entity" }
>;

export function DisambiguationPanel(props: DisambiguationManifestProps) {
  const [dismissed, setDismissed] = useState(false);
  const { send } = useVexQuery();
  if (dismissed) return null;
  return (
    <DisambiguationCard
      question={props.question}
      options={props.options}
      onSelect={(id) => {
        const option = props.options.find((o) => o.id === id);
        if (option) void send(`Use ${option.label}`);
        setDismissed(true);
      }}
      onDismiss={() => {
        void send(vexCopy.uncertainty.disambiguation);
        setDismissed(true);
      }}
    />
  );
}

export function ConfirmEntityPanel(props: ConfirmEntityManifestProps) {
  const [done, setDone] = useState(false);
  const { send } = useVexQuery();
  if (done) return null;
  const confirmProps: ConfirmEntityCardProps = {
    entity: props.entity,
    onConfirm: () => {
      void send(`Confirmed — this is ${props.entity}.`);
      setDone(true);
    },
    onCorrect: () => {
      void send(`Not ${props.entity}. Can you disambiguate?`);
      setDone(true);
    },
  };
  if (props.sublabel !== undefined) confirmProps.sublabel = props.sublabel;
  return <ConfirmEntityCard {...confirmProps} />;
}
