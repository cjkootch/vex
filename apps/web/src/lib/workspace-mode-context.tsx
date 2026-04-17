"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  WORKSPACE_MODE_CONFIGS,
  WorkspaceMode,
  type WorkspaceModeConfig,
} from "@vex/ui";

/**
 * React context that tracks the current workspace mode and the entity
 * it's scoped to. The top shell reads from this to render the
 * ContextChip; the chat surface reads it to pick the placeholder text
 * and seed the initial panel set.
 *
 * Intentionally in-memory — mode is session-scoped UI state, not
 * durable. Persisting "last mode" to the server is a separate concern.
 */

const MAX_HISTORY = 5;

export interface WorkspaceModeContextValue {
  mode: WorkspaceMode;
  /** Resolved config from WORKSPACE_MODE_CONFIGS. Never null. */
  config: WorkspaceModeConfig;
  contextId: string | null;
  contextLabel: string | null;
  contextSublabel: string | null;
  setMode: (
    mode: WorkspaceMode,
    contextId?: string,
    contextLabel?: string,
    contextSublabel?: string,
  ) => void;
  /** Drop back to Global, clearing context. */
  resetMode: () => void;
  /** Previous modes, newest first. Caps at MAX_HISTORY entries. */
  modeHistory: WorkspaceMode[];
}

const WorkspaceModeContext = createContext<WorkspaceModeContextValue | undefined>(
  undefined,
);

export function WorkspaceModeProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<WorkspaceMode>(WorkspaceMode.Global);
  const [contextId, setContextId] = useState<string | null>(null);
  const [contextLabel, setContextLabel] = useState<string | null>(null);
  const [contextSublabel, setContextSublabel] = useState<string | null>(null);
  const [modeHistory, setModeHistory] = useState<WorkspaceMode[]>([]);

  // Stash the latest mode in a ref so setMode/resetMode can push the
  // previous value onto modeHistory without re-creating the callback
  // every render. Keeps the component tree stable for memoised children.
  const modeRef = useRef(mode);
  modeRef.current = mode;

  const pushHistory = useCallback((prev: WorkspaceMode) => {
    setModeHistory((h) => [prev, ...h].slice(0, MAX_HISTORY));
  }, []);

  const setMode = useCallback(
    (
      next: WorkspaceMode,
      nextContextId?: string,
      nextContextLabel?: string,
      nextContextSublabel?: string,
    ) => {
      const prev = modeRef.current;
      if (prev !== next) pushHistory(prev);
      setModeState(next);
      setContextId(nextContextId ?? null);
      setContextLabel(nextContextLabel ?? null);
      setContextSublabel(nextContextSublabel ?? null);
    },
    [pushHistory],
  );

  const resetMode = useCallback(() => {
    const prev = modeRef.current;
    if (prev !== WorkspaceMode.Global) pushHistory(prev);
    setModeState(WorkspaceMode.Global);
    setContextId(null);
    setContextLabel(null);
    setContextSublabel(null);
  }, [pushHistory]);

  const config = WORKSPACE_MODE_CONFIGS[mode];

  // Reflect the mode + context in document.title so browser tabs stay
  // meaningful. Guarded for SSR — Next.js renders this on the server
  // during the first pass.
  useEffect(() => {
    if (typeof document === "undefined") return;
    const parts = ["Vex", config.label];
    if (contextLabel) parts.push(contextLabel);
    document.title = parts.join(" · ");
  }, [config.label, contextLabel]);

  const value = useMemo<WorkspaceModeContextValue>(
    () => ({
      mode,
      config,
      contextId,
      contextLabel,
      contextSublabel,
      setMode,
      resetMode,
      modeHistory,
    }),
    [
      mode,
      config,
      contextId,
      contextLabel,
      contextSublabel,
      setMode,
      resetMode,
      modeHistory,
    ],
  );

  return (
    <WorkspaceModeContext.Provider value={value}>
      {children}
    </WorkspaceModeContext.Provider>
  );
}

/**
 * Access the workspace mode context. Throws when rendered outside of a
 * WorkspaceModeProvider rather than silently returning a default, so a
 * mis-wired tree surfaces the bug in development immediately.
 */
export function useWorkspaceMode(): WorkspaceModeContextValue {
  const ctx = useContext(WorkspaceModeContext);
  if (!ctx) {
    throw new Error(
      "useWorkspaceMode must be used inside a WorkspaceModeProvider",
    );
  }
  return ctx;
}
