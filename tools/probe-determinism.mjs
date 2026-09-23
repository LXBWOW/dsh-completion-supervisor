/**
 * PROBE whether Jev is deterministic for an identical state.
 *
 * WHY THIS DECIDES SOMETHING IMPORTANT
 * ----------------------------------
 * The policy compares probabilities against thresholds that sit close to the observed values:
 * `requirementsUnsatisfiedBelow` is 0.40, and the real measurements land at 0.26-0.54. If Jev
 * returns a slightly different number for the SAME state, then a threshold in that range is
 * deciding on noise, and an "improvement" of 0.06 between two runs may be nothing at all.
 *
 * That question came up for a concrete reason, not as a precaution. Task A ("run npm test and
 * report") had an IDENTICAL `goal` under task_v=2 and task_v=3, and scored 0.39 then 0.33 —
 * while `ready_to_finish` was 0.40 both times and `blocking_issue_remaining` moved 0.66 -> 0.68.
 * The two states differ only in fields that carry no meaning for the question: `task_v`, an empty
 * artifact block, `session_id`, and a timestamp.
 *
 * Two hypotheses, and they call for different responses:
 *
 *   1. JEV IS STOCHASTIC. Then a threshold at 0.40 is unstable, and any calibration must be
 *      quoted with a tolerance rather than a point value.
 *   2. JEV IS DETERMINISTIC AND SENSITIVE TO IRRELEVANT TOKENS. Then the low scores are
 *      reproducible, thresholds are meaningful, and the fix is to remove the noise from the
 *      state instead.
 *
 * This sends the SAME state N times and reports the spread. It writes nothing and reads no log.
 *
 * Usage: node tools/probe-determinism.mjs [--repeat 5]
 */

import { resolveApiKey, assess, DEFAULT_MODEL, DEFAULT_TIMEOUT_MS } from '../lib/jev.js';
import { JEV_QUESTION_NAMES } from '../lib/questions.js';

/**
 * The state sent every time.
 *
 * Deliberately moderate rather than extreme: a state that is obviously complete or obviously
 * broken might be answered at 0.99 / 0.01 where any model is stable, and the interesting region
 * is the middle — which is exactly where the real measurements sit and where the thresholds are.
 */
const FIXED_STATE = {
  task_v: 3,
  session_id: 'determinism-probe',
  turn: 1,
  at: '2026-01-01T00:00:00.000Z',
  goal: 'Run the test suite in the working directory and report the pass and fail counts.',
  claim: 'Done: the suite ran and all tests passed (133 pass, 0 fail).',
  repo: { available: false, changed_files: [], untracked: [], insertions: null, deletions: null },
  commands: [{ kind: 'test', cmd: 'npm test', exit: 0, exit_attributable: true }],
  evidence: {
    tests_run: true,
    tests_passed: true,
    build_ok: null,
    lint_ok: null,
    error_results: [],
    unverified_claims: [],
  },
  activity: {
    tool_calls_this_turn: 1,
    tools_used: ['pwsh'],
    material: 1,
    message_only: 0,
    touched_paths: [],
    created_or_written_paths: [],
    material_actions: [],
    verified_artifacts: [],
  },
  prior: null,
};

const args = process.argv.slice(2);
const repeatIndex = args.indexOf('--repeat');
const repeat = repeatIndex >= 0 ? Math.max(1, Number(args[repeatIndex + 1] ?? 3) || 3) : 3;

const { key, source } = resolveApiKey();
if (key.length === 0) {
  console.log('no TYPESAFE_API_KEY resolved — nothing to probe');
  process.exit(1);
}

console.log(`key: resolved from ${source} (value not shown)`);
console.log(`model requested: ${DEFAULT_MODEL}`);
console.log(`identical state sent ${repeat} time(s), timeout ${DEFAULT_TIMEOUT_MS}ms`);
console.log('');

/** @type {Array<Record<string, number>>} */
const runs = [];
const latencies = [];
let model = null;

for (let index = 0; index < repeat; index += 1) {
  try {
    const result = await assess({ apiKey: key, state: FIXED_STATE, timeoutMs: DEFAULT_TIMEOUT_MS });
    runs.push(result.probabilities);
    latencies.push(result.latencyMs);
    model = result.model;
  } catch (error) {
    console.log(`run ${index + 1} failed: ${String(error?.message ?? error)}`);
  }
}

if (runs.length === 0) {
  console.log('no successful runs');
  process.exit(1);
}

console.log(`answered model: ${model ?? '(the response named none)'}`);
console.log(`runs: ${runs.length}/${repeat} succeeded   latency ${latencies.join('ms, ')}ms`);
console.log('');
console.log('question'.padEnd(26) + 'values'.padStart(0) + '   spread   identical');
console.log('-'.repeat(84));

let anyVariation = false;
let maxSpread = 0;

for (const name of JEV_QUESTION_NAMES) {
  const values = runs.map((run) => run[name]).filter((value) => typeof value === 'number');
  if (values.length === 0) continue;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const spread = max - min;
  const identical = spread === 0;
  if (!identical) anyVariation = true;
  maxSpread = Math.max(maxSpread, spread);
  console.log(
    name.padEnd(26) +
      values.map((value) => value.toFixed(3)).join(' ').padEnd(30) +
      `   ${spread.toFixed(3)}`.padStart(10) +
      `   ${identical ? 'yes' : 'NO'}`,
  );
}

console.log('');
if (!anyVariation) {
  console.log(`VERDICT: deterministic on this state (${runs.length} identical answers).`);
  console.log('  A probability difference between two runs is therefore caused by the state, not');
  console.log('  by the model. Thresholds are meaningful, and an unexplained difference points at');
  console.log('  noise IN THE STATE — including fields that carry no meaning for the question,');
  console.log('  such as session ids and timestamps.');
} else {
  console.log(`VERDICT: NOT deterministic. Largest spread across ${runs.length} identical states: ${maxSpread.toFixed(3)}.`);
  console.log('  A threshold placed near the observed values is then deciding partly on noise. Two');
  console.log('  consequences:');
  console.log('    1. Thresholds must be quoted with a tolerance, not as point values.');
  console.log(`    2. Any before/after difference smaller than ~${maxSpread.toFixed(2)} is not evidence.`);
  console.log('  Repeat with a larger --repeat to bound the spread properly before setting any');
  console.log('  threshold that people will rely on.');
}
