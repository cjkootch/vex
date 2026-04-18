export const CALLS_DB_CLIENT = Symbol("CALLS_DB_CLIENT");
export const CALLS_WORKSPACES_REPO = Symbol("CALLS_WORKSPACES_REPO");
export const CALLS_CONTACTS_REPO = Symbol("CALLS_CONTACTS_REPO");
export const CALLS_AGENT_RUNS_REPO = Symbol("CALLS_AGENT_RUNS_REPO");
export const CALLS_APPROVALS_REPO = Symbol("CALLS_APPROVALS_REPO");
export const CALLS_ACTIVITIES_REPO = Symbol("CALLS_ACTIVITIES_REPO");
export const CALLS_SUMMARIES_REPO = Symbol("CALLS_SUMMARIES_REPO");
export const CALLS_EVENTS_REPO = Symbol("CALLS_EVENTS_REPO");
export const CALLS_TEMPORAL_CLIENT = Symbol("CALLS_TEMPORAL_CLIENT");
export const CALLS_TWILIO_CLIENT = Symbol("CALLS_TWILIO_CLIENT");
export const CALLS_TWILIO_VERIFIER = Symbol("CALLS_TWILIO_VERIFIER");
export const CALLS_S3_UPLOADER = Symbol("CALLS_S3_UPLOADER");
export const CALLS_TASK_QUEUE = Symbol("CALLS_TASK_QUEUE");
/**
 * Twilio Voice SDK credentials used to mint browser-join Access Tokens
 * (Sprint J). Null when the three env vars aren't set — the join
 * endpoint returns 503 in that case instead of misconfiguring silently.
 */
export const CALLS_VOICE_SDK_CONFIG = Symbol("CALLS_VOICE_SDK_CONFIG");

/**
 * Sprint K — AI voice listener config. `{ enabled, streamUrl }` — the
 * TwiML driver injects `<Start><Stream url={streamUrl}/>` when
 * enabled. The stream URL is derived from APP_BASE_URL + the tenant,
 * so the raw websocket path is constructed once at boot and passed
 * in rather than rebuilt on every webhook.
 */
export const CALLS_VOICE_LISTENER_CONFIG = Symbol("CALLS_VOICE_LISTENER_CONFIG");
