-- Vex canonical schema — Sprint 1
-- Hand-authored because drizzle-kit cannot express:
--   - the pgvector extension
--   - RANGE partitioning (raw_events, events)
--   - HNSW indexes over vector columns
--   - STORED GENERATED tsvector columns
--   - RLS policies
-- The Drizzle schema under packages/db/src/schema/ describes the same tables
-- for type-safe querying. Keep the two in sync.

-- ============================================================================
-- Extensions
-- ============================================================================
CREATE EXTENSION IF NOT EXISTS vector;

-- ============================================================================
-- Enums
-- ============================================================================
CREATE TYPE workspace_plan AS ENUM ('free', 'essentials', 'pro');
CREATE TYPE user_role AS ENUM ('owner', 'admin', 'member', 'viewer');
CREATE TYPE record_status AS ENUM ('active', 'inactive', 'archived');
CREATE TYPE lead_status AS ENUM ('new', 'qualified', 'disqualified', 'won', 'lost');
CREATE TYPE campaign_status AS ENUM ('active', 'paused', 'completed', 'archived');
CREATE TYPE message_direction AS ENUM ('inbound', 'outbound');
CREATE TYPE raw_event_status AS ENUM ('pending', 'processed', 'failed');
CREATE TYPE agent_run_status AS ENUM ('pending', 'running', 'completed', 'failed');
CREATE TYPE approval_decision AS ENUM ('pending', 'approved', 'rejected', 'auto_approved');

-- ============================================================================
-- Non-partitioned tables
-- ============================================================================

CREATE TABLE workspaces (
    id           text PRIMARY KEY,
    name         text NOT NULL,
    plan         workspace_plan NOT NULL DEFAULT 'free',
    settings     jsonb NOT NULL,
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
    id            text PRIMARY KEY,
    tenant_id     text NOT NULL,
    workspace_id  text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    email         text NOT NULL,
    name          text,
    role          user_role NOT NULL DEFAULT 'member',
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX users_tenant_idx     ON users (tenant_id);
CREATE INDEX users_workspace_idx  ON users (workspace_id);

CREATE TABLE organizations (
    id                text PRIMARY KEY,
    tenant_id         text NOT NULL,
    legal_name        text NOT NULL,
    domain            text,
    industry          text,
    geo               jsonb,
    fit_score         double precision,
    source_of_truth   text,
    external_keys     jsonb NOT NULL DEFAULT '{}'::jsonb,
    field_confidence  jsonb NOT NULL DEFAULT '{}'::jsonb,
    status            record_status NOT NULL DEFAULT 'active',
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX organizations_tenant_idx  ON organizations (tenant_id);
CREATE INDEX organizations_status_idx  ON organizations (status);
CREATE INDEX organizations_domain_idx  ON organizations (domain);

CREATE TABLE contacts (
    id                text PRIMARY KEY,
    tenant_id         text NOT NULL,
    org_id            text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    full_name         text NOT NULL,
    title             text,
    emails            jsonb NOT NULL DEFAULT '[]'::jsonb,
    phones            jsonb NOT NULL DEFAULT '[]'::jsonb,
    role_score        double precision,
    external_keys     jsonb NOT NULL DEFAULT '{}'::jsonb,
    field_confidence  jsonb NOT NULL DEFAULT '{}'::jsonb,
    status            record_status NOT NULL DEFAULT 'active',
    timezone          text,
    opt_out_at        timestamptz,
    opt_out_reason    text,
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX contacts_tenant_idx  ON contacts (tenant_id);
CREATE INDEX contacts_org_idx     ON contacts (org_id);
CREATE INDEX contacts_status_idx  ON contacts (status);

CREATE TABLE leads (
    id                    text PRIMARY KEY,
    tenant_id             text NOT NULL,
    org_id                text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    contact_id            text REFERENCES contacts(id) ON DELETE SET NULL,
    owner_id              text REFERENCES users(id) ON DELETE SET NULL,
    status                lead_status NOT NULL DEFAULT 'new',
    stage                 text,
    qualification_summary text,
    external_keys         jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at            timestamptz NOT NULL DEFAULT now(),
    updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX leads_tenant_idx   ON leads (tenant_id);
CREATE INDEX leads_org_idx      ON leads (org_id);
CREATE INDEX leads_contact_idx  ON leads (contact_id);
CREATE INDEX leads_status_idx   ON leads (status);

CREATE TABLE campaigns (
    id             text PRIMARY KEY,
    tenant_id      text NOT NULL,
    channel        text NOT NULL,
    source         text,
    medium         text,
    account_ref    text,
    spend          double precision,
    objective      text,
    external_keys  jsonb NOT NULL DEFAULT '{}'::jsonb,
    status         campaign_status NOT NULL DEFAULT 'active',
    created_at     timestamptz NOT NULL DEFAULT now(),
    updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX campaigns_tenant_idx  ON campaigns (tenant_id);
CREATE INDEX campaigns_status_idx  ON campaigns (status);

CREATE TABLE touchpoints (
    id            text PRIMARY KEY,
    tenant_id     text NOT NULL,
    channel       text NOT NULL,
    actor         text,
    occurred_at   timestamptz NOT NULL,
    campaign_id   text REFERENCES campaigns(id) ON DELETE SET NULL,
    lead_id       text REFERENCES leads(id) ON DELETE SET NULL,
    contact_id    text REFERENCES contacts(id) ON DELETE SET NULL,
    org_id        text REFERENCES organizations(id) ON DELETE SET NULL,
    metadata      jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX touchpoints_tenant_idx       ON touchpoints (tenant_id);
CREATE INDEX touchpoints_occurred_at_idx  ON touchpoints (occurred_at);
CREATE INDEX touchpoints_campaign_idx     ON touchpoints (campaign_id);
CREATE INDEX touchpoints_lead_idx         ON touchpoints (lead_id);
CREATE INDEX touchpoints_contact_idx      ON touchpoints (contact_id);
CREATE INDEX touchpoints_org_idx          ON touchpoints (org_id);

CREATE TABLE threads (
    id               text PRIMARY KEY,
    tenant_id        text NOT NULL,
    channel          text NOT NULL,
    subject          text,
    participant_ids  jsonb NOT NULL DEFAULT '[]'::jsonb,
    last_message_at  timestamptz,
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX threads_tenant_idx ON threads (tenant_id);

CREATE TABLE messages (
    id           text PRIMARY KEY,
    tenant_id    text NOT NULL,
    thread_id    text NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
    direction    message_direction NOT NULL,
    content_ref  text,
    sentiment    text,
    outcome      text,
    metadata     jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX messages_tenant_idx  ON messages (tenant_id);
CREATE INDEX messages_thread_idx  ON messages (thread_id);

CREATE TABLE activities (
    id                  text PRIMARY KEY,
    tenant_id           text NOT NULL,
    type                text NOT NULL,
    related_object_ids  jsonb NOT NULL DEFAULT '{}'::jsonb,
    occurred_at         timestamptz NOT NULL,
    result              text,
    transcript_ref      text,
    duration_seconds    integer,
    metadata            jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX activities_tenant_idx       ON activities (tenant_id);
CREATE INDEX activities_occurred_at_idx  ON activities (occurred_at);

CREATE TABLE documents (
    id                   text PRIMARY KEY,
    tenant_id            text NOT NULL,
    org_id               text REFERENCES organizations(id) ON DELETE SET NULL,
    title                text NOT NULL,
    mime_type            text NOT NULL,
    storage_key          text NOT NULL,
    extracted_text_ref   text,
    created_at           timestamptz NOT NULL DEFAULT now(),
    updated_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX documents_tenant_idx  ON documents (tenant_id);
CREATE INDEX documents_org_idx     ON documents (org_id);

CREATE TABLE summaries (
    id                     text PRIMARY KEY,
    tenant_id              text NOT NULL,
    subject_type           text NOT NULL,
    subject_id             text NOT NULL,
    summary_type           text NOT NULL,
    version                integer NOT NULL DEFAULT 1,
    content                text NOT NULL,
    validity_window_start  timestamptz,
    validity_window_end    timestamptz,
    created_at             timestamptz NOT NULL DEFAULT now(),
    updated_at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX summaries_tenant_idx   ON summaries (tenant_id);
CREATE INDEX summaries_subject_idx  ON summaries (tenant_id, subject_type, subject_id);
CREATE UNIQUE INDEX summaries_unique_per_version
    ON summaries (tenant_id, subject_type, subject_id, summary_type, version);

-- ============================================================================
-- Partitioned tables
-- ============================================================================

CREATE TABLE raw_events (
    id                  text NOT NULL,
    tenant_id           text NOT NULL,
    provider            text NOT NULL,
    provider_event_id   text NOT NULL,
    headers             jsonb NOT NULL DEFAULT '{}'::jsonb,
    payload             jsonb NOT NULL,
    received_at         timestamptz NOT NULL,
    checksum            text,
    status              raw_event_status NOT NULL DEFAULT 'pending'
) PARTITION BY RANGE (received_at);
CREATE INDEX raw_events_tenant_idx       ON raw_events (tenant_id);
CREATE INDEX raw_events_received_at_idx  ON raw_events (received_at);
CREATE UNIQUE INDEX raw_events_provider_event_uniq
    ON raw_events (received_at, tenant_id, provider, provider_event_id);

CREATE TABLE raw_events_2026_04 PARTITION OF raw_events
    FOR VALUES FROM ('2026-04-01') TO ('2026-05-01');

CREATE TABLE events (
    id                text NOT NULL,
    tenant_id         text NOT NULL,
    verb              text NOT NULL,
    subject_type      text NOT NULL,
    subject_id        text NOT NULL,
    actor_type        text,
    actor_id          text,
    object_type       text,
    object_id         text,
    occurred_at       timestamptz NOT NULL,
    idempotency_key   text NOT NULL,
    metadata          jsonb NOT NULL DEFAULT '{}'::jsonb
) PARTITION BY RANGE (occurred_at);
CREATE INDEX events_tenant_idx       ON events (tenant_id);
CREATE INDEX events_occurred_at_idx  ON events (occurred_at);
CREATE UNIQUE INDEX events_idempotency_uniq
    ON events (occurred_at, tenant_id, idempotency_key);

CREATE TABLE events_2026_04 PARTITION OF events
    FOR VALUES FROM ('2026-04-01') TO ('2026-05-01');

-- ============================================================================
-- Embedding chunks (vector + fulltext)
-- ============================================================================

CREATE TABLE embedding_chunks (
    id                  text PRIMARY KEY,
    tenant_id           text NOT NULL,
    owner_object_type   text NOT NULL,
    owner_object_id     text NOT NULL,
    chunk_text          text NOT NULL,
    search_vector       tsvector GENERATED ALWAYS AS (to_tsvector('english', chunk_text)) STORED,
    embedding           vector(1536) NOT NULL,
    permission_scope    text NOT NULL DEFAULT 'workspace',
    metadata            jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX embedding_chunks_tenant_idx
    ON embedding_chunks (tenant_id);
CREATE INDEX embedding_chunks_owner_idx
    ON embedding_chunks (owner_object_type, owner_object_id);
CREATE INDEX embedding_chunks_search_vector_idx
    ON embedding_chunks USING gin (search_vector);
CREATE INDEX embedding_chunks_embedding_hnsw
    ON embedding_chunks USING hnsw (embedding vector_cosine_ops);

-- ============================================================================
-- Agent runs + approvals
-- ============================================================================

CREATE TABLE agent_runs (
    id            text PRIMARY KEY,
    tenant_id     text NOT NULL,
    agent_name    text NOT NULL,
    status        agent_run_status NOT NULL DEFAULT 'pending',
    input_refs    jsonb NOT NULL DEFAULT '{}'::jsonb,
    output_refs   jsonb NOT NULL DEFAULT '{}'::jsonb,
    cost_usd      double precision NOT NULL DEFAULT 0,
    error         text,
    started_at    timestamptz,
    finished_at   timestamptz,
    created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX agent_runs_tenant_idx ON agent_runs (tenant_id);

CREATE TABLE approvals (
    id                 text PRIMARY KEY,
    tenant_id          text NOT NULL,
    agent_run_id       text REFERENCES agent_runs(id) ON DELETE SET NULL,
    action_type        text NOT NULL,
    proposed_payload   jsonb NOT NULL,
    reviewer_id        text REFERENCES users(id) ON DELETE SET NULL,
    decision           approval_decision NOT NULL DEFAULT 'pending',
    decided_at         timestamptz,
    created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX approvals_tenant_idx    ON approvals (tenant_id);
CREATE INDEX approvals_decision_idx  ON approvals (decision);

-- ============================================================================
-- RLS policies (CREATED but NOT ENABLED — enable in Sprint 3)
-- ============================================================================
--
-- Uses `current_setting('app.tenant_id', true)` with lenient=true so the call
-- returns NULL (not an error) if the session variable is not set. Until RLS
-- is enabled, these policies are inert — they exist so the enable migration
-- in Sprint 3 is a single `ALTER TABLE ... ENABLE ROW LEVEL SECURITY`.

CREATE POLICY tenant_isolation ON users
    USING (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY tenant_isolation ON organizations
    USING (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY tenant_isolation ON contacts
    USING (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY tenant_isolation ON leads
    USING (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY tenant_isolation ON campaigns
    USING (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY tenant_isolation ON touchpoints
    USING (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY tenant_isolation ON threads
    USING (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY tenant_isolation ON messages
    USING (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY tenant_isolation ON activities
    USING (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY tenant_isolation ON documents
    USING (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY tenant_isolation ON summaries
    USING (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY tenant_isolation ON raw_events
    USING (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY tenant_isolation ON events
    USING (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY tenant_isolation ON embedding_chunks
    USING (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY tenant_isolation ON agent_runs
    USING (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY tenant_isolation ON approvals
    USING (tenant_id = current_setting('app.tenant_id', true));
