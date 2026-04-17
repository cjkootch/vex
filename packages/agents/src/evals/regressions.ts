/**
 * Regression detection — pure function, extracted for unit testing.
 *
 * A regression is a fixture that **passed** on the previous run but
 * **fails** on the current run. New fixtures (not present on the
 * previous run) are not regressions. Fixtures removed on the current
 * run are ignored — we don't carry stale ids forward.
 *
 * The runner calls this after every eval run and writes the list to
 * `evals/results/latest.json`. The admin console's Evals tab (Sprint
 * 13) renders a red banner when the list is non-empty.
 */

export interface FixtureSnapshot {
  id: string;
  passed: boolean;
}

export function computeRegressions(
  previous: FixtureSnapshot[] | null,
  current: FixtureSnapshot[],
): string[] {
  if (!previous || previous.length === 0) return [];
  const prevPass = new Map<string, boolean>();
  for (const f of previous) prevPass.set(f.id, f.passed);
  const regressions: string[] = [];
  for (const f of current) {
    if (!f.passed && prevPass.get(f.id) === true) {
      regressions.push(f.id);
    }
  }
  return regressions.sort();
}
