import type { ReactNode } from "react";
import { AppShell } from "@/components/shell/app-shell";

/**
 * Route-group layout for every /app/* page. Mounts the AppShell —
 * TopBar, SideRail, AutonomyFeed rail, and the global ⌘K command
 * palette — around the page content. Without this wrapper those
 * surfaces never render, which is why the home page used to look
 * like floating skeleton rows on a blank canvas.
 */
export default function AppLayout({ children }: { children: ReactNode }) {
  return <AppShell>{children}</AppShell>;
}
