/**
 * Canonical icon vocabulary for procur + vex shells. Heroicons-outline
 * style: 24×24 viewBox, stroke-current, stroke-width-1.5, fill-none.
 *
 * The same names + paths exist in procur's nav-icons.tsx. If you change
 * one here, change the other.
 */

export type NavIconName =
  | "home"
  | "compass" // Discover, Find
  | "search" // Reverse search
  | "address-book" // Rolodex
  | "lightning" // Match queue, Signals
  | "globe" // Market intelligence
  | "building-bank" // Competitors
  | "anchor" // Vessels
  | "kanban" // Pipeline (capture)
  | "document-text" // Contracts, Proposal
  | "calculator" // Pricer
  | "chat-bubble" // Assistant, Chat
  | "bell" // Alerts, Notifications
  | "settings" // Company profile, Settings
  | "credit-card" // Billing
  | "inbox" // Inbox
  | "check-shield" // Approvals
  | "clock" // Follow-ups
  | "phone" // Calls
  | "microphone" // Voice
  | "megaphone" // Marketing, Outreach
  | "people" // Counterparties, Contacts, Companies
  | "map" // Strategy
  | "shield-check" // Admin
  | "arrow-down-tray" // Import
  | "sparkles"; // Brief, daily driver

const PATHS: Record<NavIconName, string> = {
  home:
    "M3 12l9-9 9 9M5 10v10a1 1 0 001 1h3v-6h6v6h3a1 1 0 001-1V10",
  compass:
    "M21 12a9 9 0 11-18 0 9 9 0 0118 0zM14.5 9.5l-2 5-5 2 2-5 5-2z",
  search: "M21 21l-4.35-4.35M10 18a8 8 0 100-16 8 8 0 000 16z",
  "address-book":
    "M5 3h11a2 2 0 012 2v14a2 2 0 01-2 2H5V3zM2 7h3M2 12h3M2 17h3M10.5 11a2.5 2.5 0 100-5 2.5 2.5 0 000 5zM7 16c.5-2 2-3 3.5-3s3 1 3.5 3",
  lightning: "M13 10V3L4 14h7v7l9-11h-7z",
  globe:
    "M21 12a9 9 0 11-18 0 9 9 0 0118 0zM3 12h18M12 3a14 14 0 010 18M12 3a14 14 0 000 18",
  "building-bank":
    "M3 21h18M5 21V10l7-5 7 5v11M9 21v-6h6v6M3 10h18",
  anchor:
    "M12 3a3 3 0 100 6 3 3 0 000-6zM12 9v12M5 16a7 7 0 0014 0M3 16h4M17 16h4",
  kanban: "M4 5h4v14H4zM10 5h4v9h-4zM16 5h4v6h-4z",
  "document-text":
    "M9 12h6M9 16h6M9 8h6M6 3h9l5 5v13a1 1 0 01-1 1H6a1 1 0 01-1-1V4a1 1 0 011-1z",
  calculator:
    "M5 3h14a1 1 0 011 1v16a1 1 0 01-1 1H5a1 1 0 01-1-1V4a1 1 0 011-1zM8 7h8M8 11h2M12 11h2M16 11h0M8 15h2M12 15h2M16 15h0M8 19h2M12 19h2M16 19h0",
  "chat-bubble":
    "M8 10h8M8 14h5M21 12c0 4.418-4.03 8-9 8-1.26 0-2.46-.23-3.55-.65L3 21l1.67-4.5C3.6 15.2 3 13.66 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z",
  bell:
    "M15 17h5l-1.4-1.4A2 2 0 0118 14.2V11a6 6 0 00-12 0v3.2c0 .53-.21 1.04-.59 1.41L4 17h5m6 0a3 3 0 11-6 0",
  settings:
    "M10.3 3.7a1 1 0 011.4 0l.7.7c.3.3.7.4 1 .3l1-.3a1 1 0 011.2.6l.4 1c.1.4.4.7.7.7l1 .4a1 1 0 01.6 1.2l-.3 1c-.1.3 0 .7.3 1l.7.7a1 1 0 010 1.4l-.7.7c-.3.3-.4.7-.3 1l.3 1a1 1 0 01-.6 1.2l-1 .4c-.4.1-.7.4-.7.7l-.4 1a1 1 0 01-1.2.6l-1-.3c-.3-.1-.7 0-1 .3l-.7.7a1 1 0 01-1.4 0l-.7-.7c-.3-.3-.7-.4-1-.3l-1 .3a1 1 0 01-1.2-.6l-.4-1c-.1-.4-.4-.7-.7-.7l-1-.4a1 1 0 01-.6-1.2l.3-1c.1-.3 0-.7-.3-1l-.7-.7a1 1 0 010-1.4l.7-.7c.3-.3.4-.7.3-1l-.3-1a1 1 0 01.6-1.2l1-.4c.4-.1.7-.4.7-.7l.4-1a1 1 0 011.2-.6l1 .3c.3.1.7 0 1-.3l.7-.7zM12 9a3 3 0 100 6 3 3 0 000-6z",
  "credit-card": "M3 7h18v10a1 1 0 01-1 1H4a1 1 0 01-1-1V7zM3 11h18M7 15h2",
  inbox:
    "M4 13h3l2 3h6l2-3h3M4 7h16l-2 13a1 1 0 01-1 1H7a1 1 0 01-1-1L4 7zM8 7V4a1 1 0 011-1h6a1 1 0 011 1v3",
  "check-shield": "M9 12l2 2 4-4M21 12a9 9 0 11-18 0 9 9 0 0118 0z",
  clock: "M12 8v4l3 3M21 12a9 9 0 11-18 0 9 9 0 0118 0z",
  phone:
    "M5 4h3l2 5-2.5 1.5a11 11 0 005 5L14 13l5 2v3a2 2 0 01-2 2A16 16 0 013 6a2 2 0 012-2z",
  microphone:
    "M12 14a3 3 0 003-3V6a3 3 0 10-6 0v5a3 3 0 003 3zM5 11a7 7 0 0014 0M12 18v3m-3 0h6",
  megaphone:
    "M11 5.882V19.24a1.76 1.76 0 01-3.417.592l-2.147-6.15M18 13a3 3 0 100-6M5.436 13.683A4.001 4.001 0 017 6h1.832c4.1 0 7.625-1.234 9.168-3v14c-1.543-1.766-5.067-3-9.168-3H7a3.988 3.988 0 01-1.564-.317z",
  people:
    "M16 11c1.657 0 3-1.79 3-4s-1.343-4-3-4-3 1.79-3 4 1.343 4 3 4zM8 11c1.657 0 3-1.79 3-4S9.657 3 8 3 5 4.79 5 7s1.343 4 3 4zM2 20c0-3.314 2.686-6 6-6s6 2.686 6 6M14 14c3.314 0 6 2.686 6 6",
  map: "M9 6l-6 3v12l6-3 6 3 6-3V6l-6 3-6-3zM9 6v12M15 9v12",
  "shield-check": "M12 2l8 4v6c0 5-3.5 9.5-8 10-4.5-.5-8-5-8-10V6l8-4zM9 12l2 2 4-4",
  "arrow-down-tray": "M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2M7 10l5 5m0 0l5-5m-5 5V4",
  sparkles: "M5 3v4M3 5h4M6 17v4M4 19h4M13 3l2 5 5 2-5 2-2 5-2-5-5-2 5-2 2-5z",
};

interface NavIconProps {
  name: NavIconName;
  className?: string;
}

export function NavIcon({ name, className }: NavIconProps) {
  const path = PATHS[name];
  if (!path) return null;
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className ?? "h-4 w-4 shrink-0"}
      aria-hidden="true"
    >
      <path d={path} />
    </svg>
  );
}
