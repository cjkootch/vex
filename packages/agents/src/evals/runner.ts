import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { loadEnv } from "@vex/config";
import { createDb, RetrievalService, withTenant } from "@vex/db";
import { AnthropicAdapter, OpenAIAdapter } from "@vex/integrations";
import { InMemoryCostLedger } from "@vex/telemetry";
import { TenantId, type EvidencePack } from "@vex/domain";
import { validateManifest } from "@vex/ui";
import { loadFixture, type EvalEntryT } from "./fixture.js";
import { QUERY_SYSTEM_PROMPT } from "../prompts/query.js";

/** Pass threshold — CI eval gate fails below this. */
const PASS_THRESHOLD = 0.8;

/** Default seed tenant + user from packages/db seed-ids. */
const DEFAULT_TENANT_ID = "01HSEEDWRK0000000000000001";

interface CaseResult {
  id: string;
  passed: boolean;
  evidenceHits: string[];
  evidenceMisses: string[];
  answerMatches: string[];
  answerMisses: string[];
  costUsd: number;
  cacheReadTokens: number;
  reason?: string;
}

interface RunSummary {
  fixture: string;
  passRate: number;
  passed: number;
  failed: number;
  totalCostUsd: number;
  cases: CaseResult[];
}

async function main(): Promise<void> {
  const fixtureName = process.argv[2] ?? "sprint1";
  const env = loadEnv();

  if (!env.OPENAI_API_KEY || !env.ANTHROPIC_API_KEY) {
    fail("eval: OPENAI_API_KEY + ANTHROPIC_API_KEY are required");
  }

  const fixtures = loadFixture(fixtureName);
  const ledger = new InMemoryCostLedger();
  const openai = new OpenAIAdapter({ apiKey: env.OPENAI_API_KEY, costLedger: ledger });
  const anthropic = new AnthropicAdapter({
    apiKey: env.ANTHROPIC_API_KEY,
    costLedger: ledger,
  });
  const db = createDb(env.APPLICATION_DATABASE_URL);
  const retrieval = new RetrievalService();
  const tenantId = TenantId(DEFAULT_TENANT_ID);

  const cases: CaseResult[] = [];
  for (const entry of fixtures) {
    cases.push(
      await runCase(entry, tenantId, db, retrieval, openai, anthropic).catch((err) => ({
        id: entry.id,
        passed: false,
        evidenceHits: [],
        evidenceMisses: entry.expected_evidence_object_ids,
        answerMatches: [],
        answerMisses: entry.expected_answer_contains,
        costUsd: 0,
        cacheReadTokens: 0,
        reason: (err as Error).message,
      })),
    );
  }

  const summary: RunSummary = {
    fixture: fixtureName,
    passRate: cases.filter((c) => c.passed).length / cases.length,
    passed: cases.filter((c) => c.passed).length,
    failed: cases.filter((c) => !c.passed).length,
    totalCostUsd: cases.reduce((s, c) => s + c.costUsd, 0),
    cases,
  };

  printSummary(summary);
  writeResults(summary);

  if (summary.passRate < PASS_THRESHOLD) {
    fail(
      `eval gate failed: ${(summary.passRate * 100).toFixed(0)}% < ${PASS_THRESHOLD * 100}% required`,
    );
  }
}

async function runCase(
  entry: EvalEntryT,
  tenantId: ReturnType<typeof TenantId>,
  db: ReturnType<typeof createDb>,
  retrieval: RetrievalService,
  openai: OpenAIAdapter,
  anthropic: AnthropicAdapter,
): Promise<CaseResult> {
  const idempotency = `eval:${entry.id}`;
  const embedding = await openai.embed(tenantId, `${idempotency}:embed`, entry.question);

  const pack: EvidencePack = await withTenant(db, tenantId, async (tx) =>
    retrieval.buildEvidencePack(tx, entry.question, embedding),
  );

  const queryResult = await anthropic.query({
    tenantId,
    idempotencyKey: idempotency,
    systemPrompt: QUERY_SYSTEM_PROMPT,
    evidencePack: pack,
    userMessage: entry.question,
  });

  const validated = validateManifest(queryResult.viewManifest);
  // Validation failure is allowed (we have a fallback) but counts against the
  // case if the answer text also doesn't satisfy expectations.

  const evidenceObjectIds = new Set(
    [...pack.summaries, ...pack.items].map((item) => item.object_id),
  );
  const evidenceHits = entry.expected_evidence_object_ids.filter((id) =>
    evidenceObjectIds.has(id),
  );
  const evidenceMisses = entry.expected_evidence_object_ids.filter(
    (id) => !evidenceObjectIds.has(id),
  );

  const answerLower = queryResult.answer.toLowerCase();
  const answerMatches = entry.expected_answer_contains.filter((term) =>
    answerLower.includes(term.toLowerCase()),
  );
  const answerMisses = entry.expected_answer_contains.filter(
    (term) => !answerLower.includes(term.toLowerCase()),
  );

  const evidenceOk = evidenceHits.length > 0;
  const answerOk = answerMatches.length >= Math.ceil(entry.expected_answer_contains.length / 2);
  const validationOk = validated.success;

  return {
    id: entry.id,
    passed: evidenceOk && answerOk && validationOk,
    evidenceHits,
    evidenceMisses,
    answerMatches,
    answerMisses,
    costUsd: queryResult.costUsd,
    cacheReadTokens: queryResult.cacheReadTokens,
    ...(validated.success ? {} : { reason: `manifest_invalid:${validated.error.slice(0, 80)}` }),
  };
}

function printSummary(summary: RunSummary): void {
  const lines: string[] = [];
  lines.push(`eval/${summary.fixture}: ${summary.passed}/${summary.cases.length} passed`);
  lines.push(`  pass_rate=${(summary.passRate * 100).toFixed(0)}%`);
  lines.push(`  total_cost_usd=${summary.totalCostUsd.toFixed(4)}`);
  for (const c of summary.cases) {
    const flag = c.passed ? "PASS" : "FAIL";
    lines.push(
      `  [${flag}] ${c.id}: evidence ${c.evidenceHits.length}/${c.evidenceHits.length + c.evidenceMisses.length}` +
        ` | answer ${c.answerMatches.length}/${c.answerMatches.length + c.answerMisses.length}` +
        ` | cache_read=${c.cacheReadTokens}` +
        (c.reason ? ` | ${c.reason}` : ""),
    );
  }
  // eslint-disable-next-line no-console
  console.log(lines.join("\n"));
}

function writeResults(summary: RunSummary): void {
  const path = resolve(process.cwd(), "evals/results/latest.json");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(summary, null, 2), "utf8");
}

function fail(msg: string): never {
  // eslint-disable-next-line no-console
  console.error(msg);
  process.exit(1);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
