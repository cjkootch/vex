"use client";

import Link from "next/link";
import type { ManifestPanel } from "@vex/ui";

type ProfileProps = Extract<ManifestPanel, { type: "profile" }>;

export function ProfilePanel({ objectType, objectId, fields }: ProfileProps) {
  return (
    <section
      data-panel="profile"
      className="rounded-lg border border-line bg-muted/40 p-4"
    >
      <div className="mb-3 flex items-start justify-between">
        <Link
          href={`/app/${encodeURIComponent(objectType)}/${encodeURIComponent(objectId)}`}
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
