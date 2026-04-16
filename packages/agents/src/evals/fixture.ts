import { z } from "zod";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { isUlid } from "@vex/domain";

/**
 * Each fixture entry describes a natural-language question, the domain
 * subject types the model should surface, ground-truth object IDs that must
 * appear in the evidence set, and keywords the answer text must contain.
 */
export const EvalEntry = z.object({
  id: z.string().min(1),
  question: z.string().min(1),
  expected_subject_types: z.array(z.string().min(1)).min(1),
  expected_evidence_object_ids: z
    .array(z.string().refine(isUlid, { message: "expected ULID" }))
    .min(1),
  expected_answer_contains: z.array(z.string().min(1)).min(1),
  retrieval_mode: z.enum(["hybrid", "vector", "fulltext"]),
});
export type EvalEntryT = z.infer<typeof EvalEntry>;

export const EvalFixture = z.array(EvalEntry);
export type EvalFixtureT = z.infer<typeof EvalFixture>;

/**
 * Load and validate an eval fixture JSON file from `fixtures/`.
 */
export function loadFixture(name: string): EvalFixtureT {
  const here = dirname(fileURLToPath(import.meta.url));
  const path = resolve(here, "fixtures", `${name}.json`);
  const raw = readFileSync(path, "utf8");
  return EvalFixture.parse(JSON.parse(raw));
}
