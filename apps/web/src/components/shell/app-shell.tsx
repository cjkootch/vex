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
import { CommandPalette } from "./command-palette";
import { VexLogo } from "@/components/brand/vex-logo";

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
    href: "/app/chat",
    label: "Chat",
    matchKey: "/app/chat",
    iconPath:
      "M8 10h8M8 14h5M21 12c0 4.418-4.03 8-9 8-1.26 0-2.46-.23-3.55-.65L3 21l1.67-4.5C3.6 15.2 3 13.66 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z",
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
    href: "/app/contacts",
    label: "Contacts",
    matchKey: "/app/contacts",
    iconPath:
      "M16 11c1.657 0 3-1.79 3-4s-1.343-4-3-4-3 1.79-3 4 1.343 4 3 4zM8 11c1.657 0 3-1.79 3-4S9.657 3 8 3 5 4.79 5 7s1.343 4 3 4zM2 20c0-3.314 2.686-6 6-6s6 2.686 6 6M14 14c3.314 0 6 2.686 6 6",
  },
  {
    href: "/app/approvals",
    label: "Approvals",
    matchKey: "/app/approvals",
    iconPath: "M9 12l2 2 4-4M21 12a9 9 0 11-18 0 9 9 0 0118 0z",
  },
  {
    // Sprint-13 admin console. Non-owners get a 403-style denied page
    // rendered server-side, so exposing the link unconditionally is
    // safe and avoids coupling the shell to role state.
    href: "/app/admin",
    label: "Admin",
    matchKey: "/app/admin",
    iconPath:
      "M12 2l8 4v6c0 5-3.5 9.5-8 10-4.5-.5-8-5-8-10V6l8-4z",
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
      <CommandPalette />
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
        aria-label="Vex home"
        className="flex items-center text-white hover:text-white/80"
      >
        <VexLogo className="h-6 w-9" />
      </Link>
      <div className="flex flex-1 justify-center px-6">
        {/* exactOptionalPropertyTypes: spread onClear only when set. */}
        <ContextChip
          type={chipType}
          label={contextLabel ?? config.label}
          sublabel={contextSublabel ?? config.description}
          status={config.chipStatus}
          {...(onClear ? { onClear } : {})}
        />
      </div>
      <div className="flex items-center gap-3">
        <SearchHint />
        <ApprovalBadge count={pending} />
        <div
          aria-label={vexCopy.navigation.exit_workspace}
          className="h-8 w-8 rounded-full bg-white/10"
        />
      </div>
    </header>
  );
}

function SearchHint() {
  return (
    <button
      type="button"
      onClick={() => {
        // Dispatch a synthetic ⌘K keydown so the CommandPalette's
        // global listener picks it up. Keeps the open-state owned by
        // the palette rather than plumbed through AppShell.
        window.dispatchEvent(
          new KeyboardEvent("keydown", { key: "k", metaKey: true }),
        );
      }}
      className="hidden items-center gap-2 rounded-md border border-line bg-muted/40 px-2 py-1 text-xs text-white/60 hover:border-accent hover:text-white md:flex"
      aria-label="Open search"
    >
      <span>Search</span>
      <kbd className="rounded bg-white/10 px-1 text-[10px] font-mono">⌘K</kbd>
    </button>
  );
}

function ApprovalBadge({ count }: { count: number }) {
  const label =
    count === 1 ? "1 approval pending" : `${count} approvals pending`;
  return (
    <Link
      href="/app/approvals"
      aria-label={label}
      className="relative inline-flex h-8 items-center gap-1.5 rounded-full border border-line bg-muted/40 px-2.5 text-xs text-white/70 transition hover:border-white/30 hover:text-white"
    >
      <Icon path="M9 12l2 2 4-4M21 12a9 9 0 11-18 0 9 9 0 0118 0z" size={4} />
      <span>{count}</span>
      {count > 0 ? (
        <span
          aria-hidden="true"
          className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-amber-400"
        />
      ) : null}
    </Link>
  );
}

interface SideRailProps {
  collapsed: boolean;
  onToggle: () => void;
  pathname: string;
  pending: number;
}

function SideRail({ collapsed, onToggle, pathname, pending }: SideRailProps) {
  return (
    <aside
      className={`${collapsed ? "w-14" : "w-60"} hidden flex-shrink-0 flex-col border-r border-line bg-muted/20 transition-[width] md:flex`}
    >
      <nav className="flex-1 p-2" aria-label="Primary">
        {NAV_ITEMS.map((item) => {
          // Brief matches only exactly; other items match their prefix
          // so nested routes (e.g. /app/deals/:id) keep the parent active.
          const active =
            item.matchKey === "/app"
              ? pathname === "/app"
              : pathname === item.matchKey ||
                pathname.startsWith(`${item.matchKey}/`);
          const badge =
            item.href === "/app/approvals" && pending > 0 ? pending : null;
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={active ? "page" : undefined}
              className={`mb-1 flex items-center gap-3 rounded-md px-2 py-2 text-sm transition ${
                active
                  ? "bg-white/10 text-white"
                  : "text-white/60 hover:bg-white/5 hover:text-white"
              }`}
            >
              <Icon path={item.iconPath} />
              {collapsed ? null : <span>{item.label}</span>}
              {!collapsed && badge !== null ? (
                <span className="ml-auto rounded-full bg-amber-400/20 px-1.5 py-0.5 text-xs text-amber-300">
                  {badge}
                </span>
              ) : null}
            </Link>
          );
        })}
      </nav>
      <button
        type="button"
        onClick={onToggle}
        aria-label={collapsed ? "Expand side rail" : "Collapse side rail"}
        className="border-t border-line py-2 text-center text-xs text-white/40 transition hover:bg-white/5 hover:text-white"
      >
        {collapsed ? "›" : "‹"}
      </button>
    </aside>
  );
}

function AutonomyRail({
  open,
  onToggle,
}: {
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <aside
      className={`${open ? "w-80" : "w-9"} hidden flex-shrink-0 flex-col border-l border-line bg-muted/20 transition-[width] lg:flex`}
    >
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        aria-label={open ? "Close activity rail" : "Open activity rail"}
        className="flex h-9 items-center justify-center gap-1 border-b border-line text-xs text-white/60 transition hover:text-white"
      >
        {open ? "Activity ›" : "‹"}
      </button>
      {open ? (
        <div className="flex-1 overflow-auto p-3 text-sm text-white/60">
          {vexCopy.agents.working}
        </div>
      ) : null}
    </aside>
  );
}

function Icon({ path, size = 5 }: { path: string; size?: 4 | 5 }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`${size === 4 ? "h-4 w-4" : "h-5 w-5"} flex-shrink-0`}
      aria-hidden="true"
    >
      <path d={path} />
    </svg>
  );
}
