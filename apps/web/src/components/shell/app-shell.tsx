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
import { FloatingVexWidget } from "./floating-vex-widget";
import { NotificationsBell } from "./notifications-bell";
import { StalledApprovalsBanner } from "./stalled-approvals-banner";
import {
  AutonomyFeed,
  type AutonomyScope,
} from "./autonomy-feed";
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

interface NavGroup {
  /** null = render the items at the top level (no header). */
  id: string | null;
  label: string | null;
  items: NavItem[];
}

// Heroicons-outline inspired paths, 24×24 viewBox, single stroke.
const ITEM_BRIEF: NavItem = {
  href: "/app",
  label: "Brief",
  matchKey: "/app",
  iconPath: "M3 12l9-9 9 9M5 10v10a1 1 0 001 1h3v-6h6v6h3a1 1 0 001-1V10",
};
const ITEM_CHAT: NavItem = {
  href: "/app/chat",
  label: "Chat",
  matchKey: "/app/chat",
  iconPath:
    "M8 10h8M8 14h5M21 12c0 4.418-4.03 8-9 8-1.26 0-2.46-.23-3.55-.65L3 21l1.67-4.5C3.6 15.2 3 13.66 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z",
};
const ITEM_INBOX: NavItem = {
  href: "/app/inbox",
  label: "Inbox",
  matchKey: "/app/inbox",
  iconPath:
    "M4 13h3l2 3h6l2-3h3M4 7h16l-2 13a1 1 0 01-1 1H7a1 1 0 01-1-1L4 7zM8 7V4a1 1 0 011-1h6a1 1 0 011 1v3",
};
const ITEM_DEALS: NavItem = {
  href: "/app/deals",
  label: "Deals",
  matchKey: "/app/deals",
  iconPath: "M4 7h16M4 12h16M4 17h16",
};
const ITEM_COMPANIES: NavItem = {
  href: "/app/companies",
  label: "Companies",
  matchKey: "/app/companies",
  iconPath:
    "M3 21h18M5 21V7l7-4 7 4v14M9 9h1M9 13h1M9 17h1M14 9h1M14 13h1M14 17h1",
};
const ITEM_CONTACTS: NavItem = {
  href: "/app/contacts",
  label: "Contacts",
  matchKey: "/app/contacts",
  iconPath:
    "M16 11c1.657 0 3-1.79 3-4s-1.343-4-3-4-3 1.79-3 4 1.343 4 3 4zM8 11c1.657 0 3-1.79 3-4S9.657 3 8 3 5 4.79 5 7s1.343 4 3 4zM2 20c0-3.314 2.686-6 6-6s6 2.686 6 6M14 14c3.314 0 6 2.686 6 6",
};
const ITEM_MARKETING: NavItem = {
  href: "/app/marketing",
  label: "Marketing",
  matchKey: "/app/marketing",
  iconPath:
    "M11 5.882V19.24a1.76 1.76 0 01-3.417.592l-2.147-6.15M18 13a3 3 0 100-6M5.436 13.683A4.001 4.001 0 017 6h1.832c4.1 0 7.625-1.234 9.168-3v14c-1.543-1.766-5.067-3-9.168-3H7a3.988 3.988 0 01-1.564-.317z",
};
const ITEM_CALLS: NavItem = {
  // Live-listen + take-over for in-flight AI outbound calls. Detail
  // page renders the LiveListenPanel; index lists active calls so
  // the operator can join one mid-flight without an approval ping.
  href: "/app/calls",
  label: "Calls",
  matchKey: "/app/calls",
  iconPath:
    "M5 4h3l2 5-2.5 1.5a11 11 0 005 5L14 13l5 2v3a2 2 0 01-2 2A16 16 0 013 6a2 2 0 012-2z",
};
const ITEM_VOICE: NavItem = {
  // Voice-note inbox / processed sessions index.
  href: "/app/voice",
  label: "Voice",
  matchKey: "/app/voice",
  iconPath:
    "M12 14a3 3 0 003-3V6a3 3 0 10-6 0v5a3 3 0 003 3zM5 11a7 7 0 0014 0M12 18v3m-3 0h6",
};
const ITEM_APPROVALS: NavItem = {
  href: "/app/approvals",
  label: "Approvals",
  matchKey: "/app/approvals",
  iconPath: "M9 12l2 2 4-4M21 12a9 9 0 11-18 0 9 9 0 0118 0z",
};
const ITEM_FOLLOW_UPS: NavItem = {
  href: "/app/follow-ups",
  label: "Follow-ups",
  matchKey: "/app/follow-ups",
  iconPath: "M12 8v4l3 3M21 12a9 9 0 11-18 0 9 9 0 0118 0z",
};
const ITEM_SIGNALS: NavItem = {
  href: "/app/signals",
  label: "Signals",
  matchKey: "/app/signals",
  iconPath: "M13 10V3L4 14h7v7l9-11h-7z",
};
const ITEM_IMPORT: NavItem = {
  href: "/app/import",
  label: "Import",
  matchKey: "/app/import",
  iconPath: "M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2M7 10l5 5m0 0l5-5m-5 5V4",
};
const ITEM_STRATEGY: NavItem = {
  // Sprint-S strategy. Owner-only server-side. The prompt layer
  // prepends this on every chat call so every response is conditioned
  // on the operator-authored company context.
  href: "/app/strategy",
  label: "Strategy",
  matchKey: "/app/strategy",
  iconPath: "M12 2l4 4-4 4M12 22l-4-4 4-4M2 12l4-4 4 4M22 12l-4 4-4-4",
};
const ITEM_ADMIN: NavItem = {
  // Sprint-13 admin console. Non-owners get a 403-style denied page
  // server-side, so exposing the link unconditionally is safe and
  // avoids coupling the shell to role state.
  href: "/app/admin",
  label: "Admin",
  matchKey: "/app/admin",
  iconPath: "M12 2l8 4v6c0 5-3.5 9.5-8 10-4.5-.5-8-5-8-10V6l8-4z",
};

// Grouped nav for a trading-desk operator. Brief + Chat sit at the
// top with no header (daily-drivers). Everything else clusters by
// mental model, not by module type:
//
//   Now          — things that demand attention today
//   Pipeline     — what you're moving (deals, the atoms)
//   Counterparties — who you're moving them with (orgs + people)
//   Outreach     — how you reach counterparties
//   Intelligence — what you know (signals, strategy)
//   Workspace    — admin plumbing
//
// "Now" separates time-sensitive surfaces (approvals waiting, inbox
// replies, live signals) from the pipeline browse. "Counterparties"
// is a dedicated section so Companies + Contacts read as one
// relationship surface instead of two parallel CRUD tables.
const NAV_GROUPS: NavGroup[] = [
  { id: null, label: null, items: [ITEM_BRIEF, ITEM_CHAT] },
  {
    id: "now",
    label: "Now",
    items: [ITEM_INBOX, ITEM_APPROVALS, ITEM_SIGNALS, ITEM_FOLLOW_UPS],
  },
  {
    id: "pipeline",
    label: "Pipeline",
    items: [ITEM_DEALS],
  },
  {
    id: "counterparties",
    label: "Counterparties",
    items: [ITEM_COMPANIES, ITEM_CONTACTS],
  },
  {
    id: "outreach",
    label: "Outreach",
    items: [ITEM_CALLS, ITEM_VOICE, ITEM_MARKETING],
  },
  {
    id: "intelligence",
    label: "Intelligence",
    items: [ITEM_STRATEGY],
  },
  {
    id: "workspace",
    label: "Workspace",
    items: [ITEM_IMPORT, ITEM_ADMIN],
  },
];

const NAV_GROUP_STORAGE_KEY = "vex.nav.collapsedGroups.v1";

function loadCollapsedGroups(): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = window.localStorage.getItem(NAV_GROUP_STORAGE_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      return new Set(parsed.filter((s): s is string => typeof s === "string"));
    }
    return new Set();
  } catch {
    return new Set();
  }
}

function saveCollapsedGroups(set: Set<string>): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      NAV_GROUP_STORAGE_KEY,
      JSON.stringify([...set]),
    );
  } catch {
    /* quota / private mode — in-memory still works */
  }
}

function isItemActive(item: NavItem, pathname: string): boolean {
  return item.matchKey === "/app"
    ? pathname === "/app"
    : pathname === item.matchKey || pathname.startsWith(`${item.matchKey}/`);
}

function groupHasActive(group: NavGroup, pathname: string): boolean {
  return group.items.some((i) => isItemActive(i, pathname));
}

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
interface NavCounts {
  pendingApprovals: number;
  openSignals: number;
  overdueFollowUps: number;
}

/**
 * Poll three endpoints every 60s to surface unread counts as sidebar
 * badges: pending approvals, open signals, overdue follow-ups. All
 * three requests fire in parallel; failures leave the previous value
 * intact so the badges don't flicker.
 */
function useNavCounts(): NavCounts {
  const [counts, setCounts] = useState<NavCounts>({
    pendingApprovals: 0,
    openSignals: 0,
    overdueFollowUps: 0,
  });
  useEffect(() => {
    let cancelled = false;
    const tick = async (): Promise<void> => {
      const [approvalsRes, signalsRes, followUpsRes] = await Promise.all([
        fetch("/api/approvals?status=pending", {
          credentials: "include",
          cache: "no-store",
        }).catch(() => null),
        fetch("/api/signals", {
          credentials: "include",
          cache: "no-store",
        }).catch(() => null),
        fetch("/api/follow-ups?status=open", {
          credentials: "include",
          cache: "no-store",
        }).catch(() => null),
      ]);
      if (cancelled) return;

      const approvalsCount = await extractCount(approvalsRes, "approvals");
      const signalsCount = await extractCount(signalsRes, "signals");
      const overdueCount = await extractOverdueCount(followUpsRes);

      setCounts({
        pendingApprovals: approvalsCount ?? counts.pendingApprovals,
        openSignals: signalsCount ?? counts.openSignals,
        overdueFollowUps: overdueCount ?? counts.overdueFollowUps,
      });
    };
    void tick();
    const interval = setInterval(() => void tick(), 60_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  // Intentionally empty — we read `counts` via closure on each tick
  // but don't want the interval torn down when counts update.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return counts;
}

async function extractCount(
  res: Response | null,
  arrayKey: string,
): Promise<number | null> {
  if (!res || !res.ok) return null;
  try {
    const body = (await res.json()) as Record<string, unknown>;
    if (typeof body["count"] === "number") return body["count"];
    const arr = body[arrayKey];
    if (Array.isArray(arr)) return arr.length;
    return null;
  } catch {
    return null;
  }
}

async function extractOverdueCount(res: Response | null): Promise<number | null> {
  if (!res || !res.ok) return null;
  try {
    const body = (await res.json()) as {
      followUps?: Array<{ dueAt: string; status?: string }>;
      follow_ups?: Array<{ dueAt: string; status?: string }>;
    };
    const rows = body.followUps ?? body.follow_ups ?? [];
    const now = Date.now();
    return rows.filter((r) => {
      const due = Date.parse(r.dueAt);
      return Number.isFinite(due) && due < now;
    }).length;
  } catch {
    return null;
  }
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
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const navCounts = useNavCounts();
  const pending = navCounts.pendingApprovals;
  const pathname = usePathname() ?? "";
  // Pathname → current entity scope for the autonomy rail. A page
  // about a specific deal / contact / org should narrow the rail to
  // runs that touched it; the home page stays global. We use the id
  // as the scope label for now — detail pages already fetch the
  // human-readable label themselves, so duplicating it here would
  // add a second round-trip just to decorate the rail header.
  const scope = deriveAutonomyScope(pathname);

  // Close the mobile drawer on route change so tapping a link doesn't
  // leave it hovering over the new page.
  useEffect(() => {
    setMobileNavOpen(false);
  }, [pathname]);

  return (
    <div className="fixed inset-0 flex flex-col overflow-hidden bg-canvas text-white [overscroll-behavior:none]">
      <TopBar
        pending={pending}
        onOpenMobileNav={() => setMobileNavOpen(true)}
      />
      <StalledApprovalsBanner />
      <CommandPalette />
      <FloatingVexWidget />
      <MobileNav
        open={mobileNavOpen}
        onClose={() => setMobileNavOpen(false)}
        pathname={pathname}
        pending={pending}
        navCounts={navCounts}
      />
      <div className="flex flex-1 overflow-hidden">
        <SideRail
          collapsed={sideCollapsed}
          onToggle={() => setSideCollapsed((c) => !c)}
          pathname={pathname}
          pending={pending}
          navCounts={navCounts}
        />
        <main className="flex-1 overflow-auto">{children}</main>
        <AutonomyRail
          open={autonomyOpen}
          onToggle={() => setAutonomyOpen((o) => !o)}
          scope={scope}
        />
      </div>
    </div>
  );
}

function TopBar({
  pending,
  onOpenMobileNav,
}: {
  pending: number;
  onOpenMobileNav: () => void;
}) {
  const { mode, config, contextLabel, contextSublabel, resetMode } =
    useWorkspaceMode();
  const chipType = CONTEXT_TYPE_MAP[config.contextType] ?? "none";
  const onClear = mode !== WorkspaceMode.Global ? resetMode : undefined;
  return (
    <header className="relative flex h-12 flex-shrink-0 items-center gap-2 border-b border-line-soft bg-surface-1/80 px-3 backdrop-blur-xl md:px-4">
      {/* 1px top highlight — premium surfaces always have a kiss of
          specular on the top edge. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/[0.08] to-transparent"
      />
      <button
        type="button"
        onClick={onOpenMobileNav}
        aria-label="Open navigation"
        className="-ml-1 inline-flex h-8 w-8 items-center justify-center rounded-md text-text-secondary transition-colors hover:bg-white/5 hover:text-text-primary md:hidden"
      >
        <Icon path="M4 6h16M4 12h16M4 18h16" />
      </button>
      <Link
        href="/app"
        aria-label="Vex home"
        className="flex flex-shrink-0 items-center text-text-primary transition-opacity hover:opacity-80"
      >
        <VexLogo className="h-6 w-9" />
      </Link>
      <div className="flex min-w-0 flex-1 justify-start overflow-hidden px-2 md:justify-center md:px-6">
        {/* exactOptionalPropertyTypes: spread onClear only when set. */}
        <ContextChip
          type={chipType}
          label={contextLabel ?? config.label}
          sublabel={contextSublabel ?? config.description}
          status={config.chipStatus}
          {...(onClear ? { onClear } : {})}
        />
      </div>
      <div className="flex flex-shrink-0 items-center gap-2 md:gap-3">
        <SearchHint />
        <NotificationsBell />
        <ApprovalBadge count={pending} />
        <div
          aria-label={vexCopy.navigation.exit_workspace}
          className="h-8 w-8 flex-shrink-0 rounded-full border border-line-soft bg-surface-2"
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

function badgeCountFor(
  href: string,
  pending: number,
  navCounts: NavCounts,
): number | null {
  if (href === "/app/approvals" && pending > 0) return pending;
  if (href === "/app/signals" && navCounts.openSignals > 0) {
    return navCounts.openSignals;
  }
  if (href === "/app/follow-ups" && navCounts.overdueFollowUps > 0) {
    return navCounts.overdueFollowUps;
  }
  return null;
}

function badgeToneFor(href: string, navCounts: NavCounts): "warn" | "bad" {
  // Overdue follow-ups are a stronger "handle this" signal than
  // pending approvals or open signals, so they render red.
  if (href === "/app/follow-ups" && navCounts.overdueFollowUps > 0) {
    return "bad";
  }
  return "warn";
}

interface SideRailProps {
  collapsed: boolean;
  onToggle: () => void;
  pathname: string;
  pending: number;
  navCounts: NavCounts;
}

function SideRail({
  collapsed,
  onToggle,
  pathname,
  pending,
  navCounts,
}: SideRailProps) {
  // Per-group open/closed state. Hydrate from localStorage on mount;
  // any group containing the active route is force-opened so the
  // current page is always reachable in the rail.
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(
    () => new Set(),
  );
  useEffect(() => {
    setCollapsedGroups(loadCollapsedGroups());
  }, []);
  const toggleGroup = (id: string): void => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      saveCollapsedGroups(next);
      return next;
    });
  };

  return (
    <aside
      className={`${collapsed ? "w-14" : "w-60"} hidden flex-shrink-0 flex-col border-r border-line-soft bg-surface-1/70 backdrop-blur-xl transition-[width] duration-200 ease-out-quart md:flex`}
    >
      <nav className="flex-1 overflow-y-auto px-2 pt-3" aria-label="Primary">
        {NAV_GROUPS.map((group, i) => {
          // A group with no id renders its items at the top level
          // without a header (Brief + Chat — the daily-driver pair).
          if (group.id === null) {
            return (
              <div key="__top" className="mb-4">
                {group.items.map((item) => (
                  <NavLink
                    key={item.href}
                    item={item}
                    pathname={pathname}
                    collapsed={collapsed}
                    pending={pending}
                    navCounts={navCounts}
                  />
                ))}
              </div>
            );
          }
          const hasActive = groupHasActive(group, pathname);
          // Active route always reveals its group, regardless of the
          // operator's persisted preference. Otherwise the persisted
          // collapsed flag wins.
          const open = hasActive || !collapsedGroups.has(group.id);
          return (
            <div
              key={group.id}
              className={`mb-3 ${i > 0 ? "" : ""}`}
            >
              {!collapsed && (
                <button
                  type="button"
                  onClick={() => toggleGroup(group.id!)}
                  aria-expanded={open}
                  className="flex w-full items-center justify-between rounded-md px-2 py-1.5 text-eyebrow text-text-muted transition-colors hover:text-text-secondary"
                >
                  <span>{group.label}</span>
                  <span
                    aria-hidden="true"
                    className={`text-[9px] text-text-muted transition-transform duration-150 ${open ? "" : "-rotate-90"}`}
                  >
                    ▾
                  </span>
                </button>
              )}
              {(collapsed || open) &&
                group.items.map((item) => (
                  <NavLink
                    key={item.href}
                    item={item}
                    pathname={pathname}
                    collapsed={collapsed}
                    pending={pending}
                    navCounts={navCounts}
                  />
                ))}
            </div>
          );
        })}
      </nav>
      <button
        type="button"
        onClick={onToggle}
        aria-label={collapsed ? "Expand side rail" : "Collapse side rail"}
        className="border-t border-line-soft py-2 text-center text-xs text-text-muted transition-colors hover:bg-white/[0.03] hover:text-text-primary"
      >
        {collapsed ? "›" : "‹"}
      </button>
    </aside>
  );
}

/**
 * Single nav row — used by SideRail + MobileNav so the active state,
 * badge, and icon stay identical between the two surfaces.
 */
function NavLink({
  item,
  pathname,
  collapsed,
  pending,
  navCounts,
  onClick,
}: {
  item: NavItem;
  pathname: string;
  collapsed: boolean;
  pending: number;
  navCounts: NavCounts;
  onClick?: () => void;
}) {
  const active = isItemActive(item, pathname);
  const badge = badgeCountFor(item.href, pending, navCounts);
  const badgeTone = badgeToneFor(item.href, navCounts);
  return (
    <Link
      href={item.href}
      aria-current={active ? "page" : undefined}
      {...(onClick ? { onClick } : {})}
      className={`group relative mb-0.5 flex items-center gap-3 rounded-md px-2 py-1.5 text-sm transition-colors duration-150 ${
        active
          ? "bg-surface-2 text-text-primary"
          : "text-text-secondary hover:bg-white/[0.04] hover:text-text-primary"
      }`}
    >
      {/* Accent left bar on active — quiet, legible, premium. */}
      <span
        aria-hidden="true"
        className={`absolute left-0 top-1.5 bottom-1.5 w-0.5 rounded-full bg-accent transition-opacity duration-150 ${
          active ? "opacity-100" : "opacity-0"
        }`}
      />
      <Icon path={item.iconPath} />
      {collapsed ? null : <span className="truncate">{item.label}</span>}
      {!collapsed && badge !== null ? (
        <span
          className={`num ml-auto rounded-full px-1.5 py-0.5 text-[11px] font-medium ${
            badgeTone === "bad"
              ? "bg-red-500/15 text-red-300"
              : "bg-amber-400/15 text-amber-300"
          }`}
        >
          {badge}
        </span>
      ) : null}
    </Link>
  );
}

/**
 * Mobile pop-over navigation. Slides in from the left with a
 * backdrop; tap a link or the backdrop to close. Only rendered on
 * sub-`md` viewports (the SideRail takes over above that). Escape
 * key also closes, so the keyboard-only path stays sane.
 */
function MobileNav({
  open,
  onClose,
  pathname,
  pending,
  navCounts,
}: {
  open: boolean;
  onClose: () => void;
  pathname: string;
  pending: number;
  navCounts: NavCounts;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    // Lock body scroll while the drawer is open so the page behind
    // doesn't bounce around on iOS when the user drags the drawer.
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);

  return (
    <div
      className={`fixed inset-0 z-40 md:hidden ${
        open ? "pointer-events-auto" : "pointer-events-none"
      }`}
      aria-hidden={!open}
    >
      <button
        type="button"
        aria-label="Close navigation"
        onClick={onClose}
        tabIndex={open ? 0 : -1}
        className={`absolute inset-0 bg-black/60 backdrop-blur-sm transition-opacity duration-200 ${
          open ? "opacity-100" : "opacity-0"
        }`}
      />
      <nav
        aria-label="Mobile navigation"
        className={`absolute inset-y-0 left-0 flex w-64 flex-col border-r border-line bg-canvas shadow-2xl transition-transform duration-200 ease-out ${
          open ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <div className="flex h-12 items-center border-b border-line px-4">
          <VexLogo className="h-6 w-9 text-white" />
        </div>
        <div className="flex-1 overflow-auto p-2">
          {NAV_GROUPS.map((group) =>
            group.id === null ? (
              <div key="__mtop" className="mb-2">
                {group.items.map((item) => (
                  <NavLink
                    key={item.href}
                    item={item}
                    pathname={pathname}
                    collapsed={false}
                    pending={pending}
                    navCounts={navCounts}
                    onClick={onClose}
                  />
                ))}
              </div>
            ) : (
              <div key={group.id} className="mb-3">
                <div className="px-2 py-1 text-[10px] uppercase tracking-wider text-white/40">
                  {group.label}
                </div>
                {group.items.map((item) => (
                  <NavLink
                    key={item.href}
                    item={item}
                    pathname={pathname}
                    collapsed={false}
                    pending={pending}
                    navCounts={navCounts}
                    onClick={onClose}
                  />
                ))}
              </div>
            ),
          )}
        </div>
      </nav>
    </div>
  );
}

function AutonomyRail({
  open,
  onToggle,
  scope,
}: {
  open: boolean;
  onToggle: () => void;
  scope: AutonomyScope | null;
}) {
  return (
    <aside
      className={`${open ? "w-80" : "w-9"} hidden flex-shrink-0 flex-col border-l border-line-soft bg-surface-1/70 backdrop-blur-xl transition-[width] duration-200 ease-out-quart lg:flex`}
    >
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        aria-label={open ? "Close activity rail" : "Open activity rail"}
        className="flex h-9 items-center justify-center gap-2 border-b border-line-soft text-eyebrow text-text-secondary transition-colors hover:text-text-primary"
      >
        {open ? (
          <span className="inline-flex items-center gap-2">
            <span
              aria-hidden="true"
              className="h-1.5 w-1.5 rounded-full bg-accent shadow-[0_0_8px_rgba(124,92,255,0.8)]"
            />
            {scope ? `Activity · ${scope.type}` : "Activity"}
          </span>
        ) : (
          <span>‹</span>
        )}
      </button>
      {open ? (
        <div className="flex-1 overflow-hidden">
          <AutonomyFeed scope={scope} />
        </div>
      ) : null}
    </aside>
  );
}

/**
 * Pattern-match the current URL to the entity currently in view.
 * Powers the AutonomyRail scope filter + the "Vex suggests" section.
 * Returns null for list / home / chat routes — the rail falls back
 * to the global feed.
 */
function deriveAutonomyScope(pathname: string): AutonomyScope | null {
  const patterns: Array<{
    regex: RegExp;
    type: AutonomyScope["type"];
  }> = [
    { regex: /^\/app\/deals\/([^/?#]+)/, type: "deal" },
    { regex: /^\/app\/companies\/([^/?#]+)/, type: "organization" },
    { regex: /^\/app\/contacts\/([^/?#]+)/, type: "contact" },
    { regex: /^\/app\/marketing\/([^/?#]+)/, type: "campaign" },
  ];
  for (const { regex, type } of patterns) {
    const match = regex.exec(pathname);
    const id = match?.[1];
    if (id && id.length > 0) {
      // The page itself carries the human label; the rail shows the
      // type + truncated id until the page hydrates its own header.
      return { type, id, label: `${id.slice(0, 8)}…` };
    }
  }
  return null;
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
