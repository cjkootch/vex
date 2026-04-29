"use client";

import Link from "next/link";
import type { ManifestPanel } from "@vex/ui";

type ProfileProps = Extract<ManifestPanel, { type: "profile" }>;

/**
 * Map the prompt-canonical objectType to the actual web route segment.
 * Profile panels reference entities by their domain-model name
 * ("organization", "contact"), but the routes live under their plural
 * page-folder names ("companies", "contacts"). Without this mapping
 * the linkified profile-panel header 404s for orgs.
 *
 * Add to this map whenever a new entity type is added to the manifest.
 */
const ROUTE_SEGMENT_BY_OBJECT_TYPE: Record<string, string> = {
  organization: "companies",
  organizations: "companies",
  contact: "contacts",
  contacts: "contacts",
  deal: "deals",
  fuel_deal: "deals",
  campaign: "marketing",
};

export function ProfilePanel({ objectType, objectId, fields }: ProfileProps) {
  const segment = ROUTE_SEGMENT_BY_OBJECT_TYPE[objectType] ?? objectType;
  return (
    <section
      data-panel="profile"
      className="rounded-lg border border-line bg-muted/40 p-4"
    >
      <div className="mb-3 flex items-start justify-between">
        <Link
          href={`/app/${encodeURIComponent(segment)}/${encodeURIComponent(objectId)}`}
          className="text-sm font-semibold text-white hover:underline"
        >
          {fields["Name"] ?? fields["name"] ?? objectId}
        </Link>
        <span className="rounded-full border border-line px-2 py-0.5 text-xs uppercase text-white/60">
          {objectType}
        </span>
      </div>
      <dl className="grid grid-cols-1 gap-y-2 text-sm sm:grid-cols-2">
        {Object.entries(fields).map(([k, v]) => (
          <div key={k} className="flex flex-col">
            <dt className="text-xs uppercase tracking-wider text-white/40">{k}</dt>
            <dd className="text-white/90">{v}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
