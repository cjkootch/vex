/**
 * Narrow ambient declaration for the surface of `@twilio/voice-sdk`
 * the operator-join panel uses. The real SDK ships its own types,
 * but we vendor a small slice here so the web tsconfig compiles
 * cleanly in environments where the optional runtime dependency
 * hasn't been fetched (the module is dynamically imported and
 * falls back gracefully when missing).
 */
declare module "@twilio/voice-sdk" {
  export interface DeviceOptions {
    logLevel?: string | number;
    edge?: string;
    tokenRefreshMs?: number;
  }

  export interface Call {
    on(event: "disconnect" | "cancel" | "reject" | "error", cb: (...args: unknown[]) => void): void;
    on(event: "accept", cb: () => void): void;
    disconnect(): void;
    mute(shouldMute: boolean): void;
    isMuted(): boolean;
    status(): string;
  }

  export class Device {
    constructor(token: string, options?: DeviceOptions);
    register(): Promise<void>;
    destroy(): void;
    updateToken(token: string): void;
    connect(params: { params?: Record<string, string> }): Promise<Call>;
    on(event: "registered" | "unregistered" | "tokenWillExpire", cb: () => void): void;
    on(event: "error", cb: (error: { code?: number; message?: string }) => void): void;
  }
}
