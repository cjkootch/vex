# Kill all agents

Stops all T1+ agent runs on a workspace. T0 (read-only) agents keep
running; this is a risk-containment switch, not a full stop.

## When to use

- A prompt or data regression is producing bad outputs
- Cost runaway the gate hasn't caught (see `cost-runaway.md` first)
- A downstream provider (Anthropic, Resend) is in a bad state and the
  retries are amplifying the problem

## How it works

`AgentRunner.run()` short-circuits when `workspace.settings.kill_all_agents`
is `true` and the agent's tier is not `T0`. It returns
`{ status: "skipped_kill_switch" }` and increments
`vex.agent.skipped{reason="kill_switch"}`.

## Turning the switch on

### Fast path — via DB (single tenant)

```bash
psql "$APPLICATION_DATABASE_URL" <<'SQL'
UPDATE workspaces
SET settings = jsonb_set(settings, '{kill_all_agents}', 'true'::jsonb)
WHERE id = '<workspace_id>';
SQL
```

### Fast path — every tenant

```bash
psql "$APPLICATION_DATABASE_URL" <<'SQL'
UPDATE workspaces
SET settings = jsonb_set(settings, '{kill_all_agents}', 'true'::jsonb);
SQL
```

Agents in flight complete normally; new jobs are skipped on the next
dequeue. BullMQ queue depth will rise while the flag is on — that's
expected, the backpressure alert will fire at 1000.

## Verifying

```bash
# The metric flips to a steady "skip" stream per agent kind.
# In Grafana → `agent-health.json` → panel "Skipped".
```

You should see `vex.agent.skipped{reason="kill_switch"}` accumulating
and `vex.agent.run.count{status="completed"}` flatten for T1+ agents.

## Turning it back on

```bash
psql "$APPLICATION_DATABASE_URL" <<'SQL'
UPDATE workspaces
SET settings = jsonb_set(settings, '{kill_all_agents}', 'false'::jsonb)
WHERE id = '<workspace_id>';
SQL
```

If the queue is deep, drain it by pausing enqueues temporarily:

```bash
pnpm --filter @vex/worker run replay --help
# …then re-enqueue carefully from the DLQ if needed.
```

## Next steps to prevent recurrence

File a ticket with: the verb of events that caused the bad behaviour,
a transcript / manifest showing the failure, and — if the cost gate
should have caught it — what threshold would have stopped it earlier.
