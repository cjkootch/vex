"use client";

import { useEffect, useState } from "react";

/**
 * Fetch a JSON endpoint on mount and then every `intervalMs`
 * afterwards. Returns the latest response or null. Errors are
 * swallowed — the caller typically wants the last-known-good value
 * to stay on screen rather than a flash-of-error.
 *
 * Designed for pulse/cockpit surfaces that should stay roughly in
 * sync with DB state without reloading the page: an operator who
 * approves a bundle or flips a deal status sees the cockpit update
 * within one poll cycle. 30s default matches AutonomyFeed's cadence
 * so every polling surface breathes on the same rhythm.
 *
 * Optional `deps` array re-triggers an immediate fetch when any
 * dep changes — useful when the URL depends on a prop that can
 * change (scope id, route param).
 */
export function usePulsingFetch<T>(
  url: string,
  options: {
    intervalMs?: number;
    /** Extra deps that force an immediate refetch when changed. */
    deps?: ReadonlyArray<unknown>;
  } = {},
): T | null {
  const intervalMs = options.intervalMs ?? 30_000;
  const depsKey = JSON.stringify(options.deps ?? []);
  const [data, setData] = useState<T | null>(null);

  useEffect(() => {
    let cancelled = false;
    const tick = async (): Promise<void> => {
      try {
        const res = await fetch(url, { cache: "no-store" });
        if (!res.ok) return;
        const body = (await res.json()) as T;
        if (!cancelled) setData(body);
      } catch {
        /* last-known-good stays on screen */
      }
    };
    void tick();
    const handle = setInterval(() => void tick(), intervalMs);
    return () => {
      cancelled = true;
      clearInterval(handle);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, intervalMs, depsKey]);

  return data;
}
