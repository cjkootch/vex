export const DB_CLIENT = Symbol("QUERY_DB_CLIENT");
export const RETRIEVAL_SERVICE = Symbol("QUERY_RETRIEVAL_SERVICE");
export const ANTHROPIC_ADAPTER = Symbol("QUERY_ANTHROPIC_ADAPTER");
export const OPENAI_ADAPTER = Symbol("QUERY_OPENAI_ADAPTER");
export const TAVILY_CLIENT = Symbol("QUERY_TAVILY_CLIENT");
/**
 * ProcurClient for chat tool-calls. Null when the workspace's procur
 * integration isn't configured — `lookup_in_procur` disables itself
 * cleanly in that case.
 */
export const PROCUR_CLIENT = Symbol("QUERY_PROCUR_CLIENT");
export const COST_LEDGER = Symbol("QUERY_COST_LEDGER");
/**
 * BullMQ queue for the approval-executor worker. Used to enqueue
 * T1 actions emitted by the chat agent — they get auto-approved
 * approval rows, then the worker applies them via the same dispatch
 * the operator-approval path uses.
 */
export const APPROVAL_EXECUTOR_QUEUE = Symbol("QUERY_APPROVAL_EXECUTOR_QUEUE");
/** Workspace id default for chat-issued approvals (single tenant for now). */
export const DEFAULT_WORKSPACE_ID = Symbol("QUERY_DEFAULT_WORKSPACE_ID");
