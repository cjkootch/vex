# Cost runaway

A single agent (or agent × tenant) is burning budget faster than
expected. The `AgentRunner.checkCostGate` fires when today's spend on
a workspace hits `workspace.settings.daily_cost_limit` (default $5).
If the alert fired anyway, the gate missed.

## When to use

- Grafana alert `vex-cost-spike` (if configured) — or cost-ledger
  panel climbing outside the usual trend band
- Anthropic / OpenAI billing dashboard reports an unexpected spike
- A customer support ticket about "agent is stuck in a loop"

## 1. Identify the culprit

```sql
-- Top spenders in the last hour
SELECT tenant_id, agent_run_id, sum(cost_usd_micros)/1e6 AS usd
FROM cost_ledger
WHERE occurred_at > now() - interval '1 hour'
GROUP BY 1, 2
ORDER BY 3 DESC
LIMIT 10;
```

```sql
-- Top agent kinds today
SELECT operation, provider, model, sum(cost_usd_micros)/1e6 AS usd
FROM cost_ledger
WHERE occurred_at > date_trunc('day', now())
GROUP BY 1, 2, 3
ORDER BY 4 DESC;
```

## 2. Stop the bleeding

### Tenant-scoped (preferred)

Lower the daily cap so the gate fires on the next run:

```sql
UPDATE workspaces
SET settings = jsonb_set(settings, '{daily_cost_limit}', to_jsonb(1.0))
WHERE id = '<workspace_id>';
```

Or flip the kill switch — see `kill-all-agents.md`.

### Global

Lower the BullMQ agent rate limit by restarting the worker with a
smaller `QueueRateLimits.agents` (see `packages/agents/src/queues.ts`),
or pause the agents queue:

```bash
redis-cli -u "$REDIS_URL" DEL "bull:agents:meta"
```

(BullMQ recreates the meta key with the updated config on the next
`waitUntilReady()`.)

## 3. Root-cause

- Look for runaway retries: `agent_runs.status = 'failed'` with the
  same `agent_name` and `tenant_id` in a tight loop.
- Check `proposed_actions` in the run's `output_refs` — did the model
  propose hundreds of T2 approvals? That usually means the prompt
  invited explosion (e.g. "for each lead…").
- Look at prompt-cache hit rate: `vex.agent.cost_usd` ÷ token count.
  A sudden drop means the prompt preamble changed and every call is
  re-caching.

## 4. Recover

- If a specific run is stuck, cancel its job:
  ```bash
  redis-cli -u "$REDIS_URL" XDEL "bull:agents:events" "<job_id>"
  ```
- Reset the tenant's daily limit once you're confident:
  ```sql
  UPDATE workspaces
  SET settings = jsonb_set(settings, '{daily_cost_limit}', to_jsonb(5.0))
  WHERE id = '<workspace_id>';
  ```

## Verifying

- `vex.agent.skipped{reason="cost_limit"}` should stop incrementing
  once the offending tenant is under the cap.
- `cost_ledger` sum for the last 5 minutes stabilises.

## Next steps to prevent recurrence

- Was the cap too high? Default is $5/workspace/day — adjust the
  workspace row; consider a per-agent cap if one agent dominates.
- Did prompt caching silently break? Bump `QUERY_PROMPT_VERSION` (etc.)
  with intent rather than by accident — the version marker is part of
  the cache key.
- Add a dashboard panel for "cost per run" by `agent_name`; alert if
  the p95 doubles over a 7-day baseline.
