import { VoicePanel } from "@/components/voice/voice-panel";

/**
 * Sprint 9 browser-voice surface. Renders the VoicePanel client component
 * which handles the WebRTC handshake against the OpenAI Realtime API
 * using an ephemeral token minted by apps/api.
 *
 * Middleware has already redirected unauthenticated users to /login, so
 * this page can assume a signed-in session.
 */
export default function VoicePage() {
  return (
    <main className="min-h-screen bg-canvas text-white">
      <VoicePanel />
    </main>
  );
}
