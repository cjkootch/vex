"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

export interface PinnedPanel {
  /** Content-hash id so the same panel shape deduplicates on re-pin. */
  id: string;
  /** Raw panel object from a manifest. Rendered through the same registry. */
  panel: unknown;
  /** ISO timestamp — newest pins render first. */
  pinnedAt: string;
  /** Short label for the pinned-pane header (e.g. deal ref or panel title). */
  label: string;
}

interface PinContextValue {
  pins: PinnedPanel[];
  isPinned: (id: string) => boolean;
  pin: (panel: PinnedPanel) => void;
  unpin: (id: string) => void;
  clear: () => void;
}

const PinContext = createContext<PinContextValue | null>(null);

const STORAGE_KEY = "vex.pinned-panels.v1";
const MAX_PINS = 12;

/**
 * Pinned-panels store. Persists to localStorage so a reload keeps the
 * user's dashboard. Scope is the whole app — one store per browser
 * tab. The ChatPage subscribes to render the right-side pinned pane;
 * ManifestCanvas subscribes to flip the pin button state on each
 * panel.
 *
 * Pin id is computed upstream as a stable content hash of the panel
 * JSON, so re-emitting the same panel from a repeated chat turn
 * doesn't stack duplicates.
 */
export function PinnedPanelsProvider({ children }: { children: ReactNode }) {
  const [pins, setPins] = useState<PinnedPanel[]>([]);

  // Load from localStorage on mount.
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) {
        setPins(parsed as PinnedPanel[]);
      }
    } catch {
      /* corrupt entry — start fresh */
    }
  }, []);

  // Persist on change.
  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(pins));
    } catch {
      /* quota exceeded or private mode — ok, in-memory still works */
    }
  }, [pins]);

  const pin = useCallback((next: PinnedPanel) => {
    setPins((prev) => {
      if (prev.some((p) => p.id === next.id)) return prev;
      return [next, ...prev].slice(0, MAX_PINS);
    });
  }, []);

  const unpin = useCallback((id: string) => {
    setPins((prev) => prev.filter((p) => p.id !== id));
  }, []);

  const clear = useCallback(() => setPins([]), []);

  const isPinned = useCallback(
    (id: string) => pins.some((p) => p.id === id),
    [pins],
  );

  const value = useMemo<PinContextValue>(
    () => ({ pins, isPinned, pin, unpin, clear }),
    [pins, isPinned, pin, unpin, clear],
  );

  return <PinContext.Provider value={value}>{children}</PinContext.Provider>;
}

export function usePinnedPanels(): PinContextValue {
  const ctx = useContext(PinContext);
  if (!ctx) {
    // Safe fallback so components rendered outside the provider don't
    // crash — they just see an empty store and no-op mutations.
    return {
      pins: [],
      isPinned: () => false,
      pin: () => {},
      unpin: () => {},
      clear: () => {},
    };
  }
  return ctx;
}

/**
 * Stable content-hash id for a panel. JSON-stringify + FNV-1a 32-bit
 * hash is fast, deterministic, and avoids bringing in a crypto dep.
 */
export function panelPinId(panel: unknown): string {
  const str = JSON.stringify(panel);
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `pin_${(h >>> 0).toString(36)}`;
}

/** Best-effort human label for the pinned-pane header. */
export function panelLabel(panel: unknown): string {
  if (typeof panel !== "object" || panel === null) return "Panel";
  const p = panel as Record<string, unknown>;
  const t = typeof p["type"] === "string" ? (p["type"] as string) : "panel";
  const title =
    typeof p["title"] === "string"
      ? (p["title"] as string)
      : typeof p["objectId"] === "string"
        ? (p["objectId"] as string).slice(-6)
        : null;
  return title ? `${t} · ${title}` : t;
}
