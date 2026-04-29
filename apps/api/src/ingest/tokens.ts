/**
 * Per-module DI tokens for the ingest surface (procur → vex push). Keep
 * one symbol per dependency so tests can swap individual repos without
 * dragging in a full app module.
 */
export const INGEST_DB_CLIENT = Symbol("INGEST_DB_CLIENT");
export const INGEST_ORGANIZATIONS_REPO = Symbol("INGEST_ORGANIZATIONS_REPO");
export const INGEST_CONTACTS_REPO = Symbol("INGEST_CONTACTS_REPO");
export const INGEST_LEADS_REPO = Symbol("INGEST_LEADS_REPO");
export const INGEST_EVENTS_REPO = Symbol("INGEST_EVENTS_REPO");
export const INGEST_AGENTS_QUEUE = Symbol("INGEST_AGENTS_QUEUE");
/** Workspace id every procur-ingest write attributes to. */
export const INGEST_DEFAULT_TENANT_ID = Symbol("INGEST_DEFAULT_TENANT_ID");
/** Web-app base URL used to build the deep-link in the response. */
export const INGEST_WEB_APP_BASE_URL = Symbol("INGEST_WEB_APP_BASE_URL");
