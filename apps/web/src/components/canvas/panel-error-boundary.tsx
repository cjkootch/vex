"use client";

import { Component, type ErrorInfo, type ReactNode } from "react";
import { FallbackPanel } from "./panels/fallback-panel";

interface Props {
  children: ReactNode;
  panelType: string;
}

interface State {
  hasError: boolean;
  message?: string;
}

/**
 * Per-panel error boundary. One broken panel must not crash the page —
 * the renderer wraps every panel in this so a malformed manifest fragment
 * shows a `FallbackPanel` while siblings keep rendering.
 */
export class PanelErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, message: error.message };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // eslint-disable-next-line no-console
    console.warn(
      "[ManifestCanvas] panel render failed",
      this.props.panelType,
      error.message,
      info.componentStack,
    );
  }

  override render(): ReactNode {
    if (this.state.hasError) {
      return (
        <FallbackPanel
          type={this.props.panelType}
          error={this.state.message ?? "unknown error"}
        />
      );
    }
    return this.props.children;
  }
}
