"use client";

import { useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { WorkspaceMode, vexCopy } from "@vex/ui";
import {
  WorkspaceModeProvider,
  useWorkspaceMode,
} from "@/lib/workspace-mode-context";
import { ContextChip, type ContextChipType } from "./context-chip";

/**
 * Persistent shell wrapping all /app/* pages: 48px TopBar, 240px
 * SideRail (collapsible), flex MainContent, 320px AutonomyRail
 * (collapsible, closed by default). Reads workspace mode via
 * useWorkspaceMode — WorkspaceModeProvider is mounted at this level.
 *
 * This file is split across two turns due to the 150-line cap. Part 2
 * adds SideRail, AutonomyRail, and the Icon helper — the file won't
 * typecheck until the continuation lands.
 */

interface NavItem {
  href: string;
  label: string;
  iconPath: string;
  matchKey: string;
}

// Heroicons-outline inspired paths, 24×24 viewBox, single stroke.
const NAV_ITEMS: NavItem[] = [
  {
    href: "/app",
    label: "Brief",
    matchKey: "/app",
    iconPath:
      "M3 12l9-9 9 9M5 10v10a1 1 0 001 1h3v-6h6v6h3a1 1 0 001-1V10",
  },
  {
    href: "/app/deals",
    label: "Deals",
    matchKey: "/app/deals",
    iconPath: "M4 7h16M4 12h16M4 17h16",
  },
  {
    href: "/app/companies",
    label: "Companies",
    matchKey: "/app/companies",
    iconPath:
      "M3 21h18M5 21V7l7-4 7 4v14M9 9h1M9 13h1M9 17h1M14 9h1M14 13h1M14 17h1",
  },
  {
    href: "/app/approvals",
    label: "Approvals",
    matchKey: "/app/approvals",
    iconPath: "M9 12l2 2 4-4M21 12a9 9 0 11-18 0 9 9 0 0118 0z",
  },
  {
    href: "/app/activity",
    label: "Activity",
    matchKey: "/app/activity",
    iconPath: "M3 12h4l3-9 4 18 3-9h4",
  },
];

// WorkspaceContextType from @vex/ui is "deal" | "organization" |
// "global" | "queue"; ContextChip's type is "deal" | "organization" |
// "contact" | "mode" | "none". Map queue→mode and global→none so the
// chip renders a sensible dot colour.
const CONTEXT_TYPE_MAP: Record<string, ContextChipType> = {
  deal: "deal",
  organization: "organization",
  queue: "mode",
  global: "none",
};

/**
 * Poll GET /api/approvals?status=pending every 60s and return the
 * count. Response shape is tolerant — the server may return either a
 * `{ count }` scalar or a `{ approvals: [...] }` array. Network errors
 * are swallowed silently; the badge just stops updating until the
 * next tick succeeds.
 */
function usePendingApprovalCount(): number {
  const [count, setCount] = useState(0);
  useEffect(() => {
    let cancelled = false;
    const tick = async (): Promise<void> => {
      try {
        const res = await fetch("/api/approvals?status=pending", {
          credentials: "include",
          cache: "no-store",
        });
        if (!res.ok) return;
        const data = (await res.json()) as {
          count?: number;
          approvals?: unknown[];
        };
        if (cancelled) return;
        const n =
          typeof data.count === "number"
            ? data.count
            : Array.isArray(data.approvals)
              ? data.approvals.length
              : 0;
        setCount(n);
      } catch {
        // Keep the previous value on network hiccups.
      }
    };
    void tick();
    const interval = setInterval(() => void tick(), 60_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);
  return count;
}

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <WorkspaceModeProvider>
      <ShellLayout>{children}</ShellLayout>
    </WorkspaceModeProvider>
  );
}

function ShellLayout({ children }: { children: ReactNode }) {
  const [sideCollapsed, setSideCollapsed] = useState(false);
  const [autonomyOpen, setAutonomyOpen] = useState(false);
  const pending = usePendingApprovalCount();
  const pathname = usePathname() ?? "";

  return (
    <div className="flex h-screen flex-col bg-canvas text-white">
      <TopBar pending={pending} />
      <div className="flex flex-1 overflow-hidden">
        <SideRail
          collapsed={sideCollapsed}
          onToggle={() => setSideCollapsed((c) => !c)}
          pathname={pathname}
          pending={pending}
        />
        <main className="flex-1 overflow-auto">{children}</main>
        <AutonomyRail
          open={autonomyOpen}
          onToggle={() => setAutonomyOpen((o) => !o)}
        />
      </div>
    </div>
  );
}

function TopBar({ pending }: { pending: number }) {
  const { mode, config, contextLabel, contextSublabel, resetMode } =
    useWorkspaceMode();
  const chipType = CONTEXT_TYPE_MAP[config.contextType] ?? "none";
  const onClear = mode !== WorkspaceMode.Global ? resetMode : undefined;
  return (
    <header className="flex h-12 flex-shrink-0 items-center border-b border-line bg-muted/40 px-4">
      <Link
        href="/app"
        className="font-mono text-sm font-semibold tracking-wider"
      >
        VEX
      </Link>
