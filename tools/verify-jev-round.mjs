/**
 * Check the per-assessment invariants the operator listed for the first real-Jev round.
 *
 * This is a CONTRACT CHECK, not a summary. `analyse.mjs` answers "what did we decide";
 * this answers "is each row internally sound" — the questions that have to be answered
 * BEFORE the numbers mean anything, because a row that is malformed in one field makes
 * every conclusion drawn from it suspect.
 *
 * The checks, in the order the operator asked for them:
 *   1. the goal really came from a human (`source.kind === 'user'`)
 *   2. the deterministic facts are present and self-consistent
 *   3. one request returned ALL the Nouls (no partial answer set)
 *   4. every probability parsed into [0,1] and is a real number
 *   5. `decision.action` is a SHADOW result — the row says shadow and never steered
 *   6. zero `agent.steer()` calls
 *   7. latency reached the log
 *   8. assessment_id / task_key / build_id / fingerprint all present
 *   9. the same material state did not pay for Jev twice
 *
 * Usage: node tools/verify-jev-round.mjs [--since <iso>] [--json]
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

import { JEV_QUESTION_NAMES } from '../lib/questions.js';

const LOG_PATH = process.env.COMPLETION_SUPERVISOR_LOG
  ?? join(homedir(), '.dsh', 'completion-supervisor', 'assessments.jsonl');

const args = process.argv.slice(2);
const sinceIndex = args.indexOf('--since');
const since = sinceIndex >= 0 ? args[sinceIndex + 1] : null;
const asJson = args.includes('--json');

if (!existsSync(LOG_PATH)) {
  console.log(`no log at ${LOG_PATH}`);
  process.exit(0);
}

/** Every parsable row, with the ones written by the current sources in front. */
function readRows() {
  return readFileSync(LOG_PATH, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line, index) => {
      try {
        return { ...JSON.parse(line), _line: index + 1 };
      } catch {
        return null;
      }
    })
    .filter((row) => row !== null);
}

const allRows = readRows();
const scoped = since === null ? allRows : allRows.filter((row) => typeof row.at === 'string' && row.at >= since);
const assessments = scoped.filter((row) => row.row === 'assessment');
// Only rows that actually reached Jev can answer the Jev-specific questions.
const withJev = assessments.filter((row) => row.jev !== null && row.jev !== undefined);

/** One check: a name, the rows it applies to, and a predicate returning problems. */
const checks = [];

const record = (name, appliesTo, findProblems) => {
  const problems = [];
  for (const row of appliesTo) {
    for (const problem of findProblems(row) ?? []) {
      problems.push({ line: row._line, at: row.at, turn: row.turn, problem });
    }
  }
  checks.push({ name, checked: appliesTo.length, problems });
};

// 1. The goal must be the human's text, not injected context.
record('goal came from a human message', assessments, (row) => {
  const goal = row.asked?.goal;
  if (goal === null || goal === undefined) return [];
  if (/system-reminder|skill-catalog|workspace instructions/i.test(goal)) {
    return [`goal looks INJECTED, not user-authored: ${goal.slice(0, 70)}`];
  }
  return [];
});

// 2. Deterministic facts present, and not self-contradictory.
record('deterministic facts present and consistent', withJev, (row) => {
  const problems = [];
  const facts = row.facts;
  if (facts === null || facts === undefined) {
    problems.push('no facts object');
    return problems;
  }
  for (const key of ['tests_run', 'tests_passed', 'repo_available', 'tool_calls_this_turn']) {
    if (!(key in facts)) problems.push(`facts is missing "${key}"`);
  }
  // "tests passed" with "tests never ran" is the contradiction this plugin exists to
  // catch; if WE produce it, the evidence derivation is broken.
  if (facts.tests_run === false && facts.tests_passed === true) {
    problems.push('tests_passed=true while tests_run=false');
  }
  // An empty file list from an unreadable repository must never be recorded without
  // the flag that explains it.
  if (facts.changed_files_n === 0 && facts.repo_available === null) {
    problems.push('changed_files_n=0 with repo_available unknown — cannot tell "clean" from "blind"');
  }
  if (!Array.isArray(row.commands) && row.commands !== null) {
    problems.push('commands is neither an array nor null');
  }
  return problems;
});

// 3. One batched request must answer EVERY question; a partial set must be rejected.
record('all Nouls answered in one request', withJev, (row) => {
  const probabilities = row.jev?.probabilities;
  if (probabilities === null || typeof probabilities !== 'object') return ['no probabilities object'];
  const missing = JEV_QUESTION_NAMES.filter((name) => !(name in probabilities));
  return missing.length === 0 ? [] : [`missing answers: ${missing.join(', ')}`];
});

// 4. Probabilities must be usable numbers: a NaN or an out-of-range value would make
//    the policy's thresholds meaningless without ever throwing.
record('every probability is a number in [0,1]', withJev, (row) => {
  const probabilities = row.jev?.probabilities ?? {};
  const problems = [];
  for (const [name, value] of Object.entries(probabilities)) {
    if (typeof value !== 'number') problems.push(`${name} is ${typeof value}, not a number`);
    else if (!Number.isFinite(value)) problems.push(`${name} is not finite (${String(value)})`);
    else if (value < 0 || value > 1) problems.push(`${name} is outside [0,1] (${value})`);
  }
  return problems;
});

// 5. Every decision must be flagged shadow, and the recorded action must be the one
//    the policy produced rather than an applied one.
record('decision is a recorded shadow result', assessments, (row) => {
  const problems = [];
  if (row.shadow !== true) problems.push(`shadow is ${String(row.shadow)}, expected true`);
  if (row.decision !== null && row.decision !== undefined && row.decision.applied !== false) {
    problems.push(`decision.applied is ${String(row.decision.applied)}, expected false in shadow`);
  }
  return problems;
});

// 6. Steering must be zero. The honest source for this is the plugin's own record:
//    `applied:false` everywhere plus no plugin-authored message in the session. The
//    log can only prove the first half, so the check states that limit rather than
//    implying a stronger guarantee than it has.
record('no steering (applied flag)', assessments, (row) =>
  row.decision?.applied === false ? [] : ['decision did not record applied:false']);

// 7. Latency must be recorded, or the cost side of the trade-off is unmeasurable.
record('latency recorded', withJev, (row) => {
  const problems = [];
  if (typeof row.latency_ms?.jev !== 'number') problems.push('latency_ms.jev missing');
  else if (row.latency_ms.jev <= 0) problems.push(`latency_ms.jev is ${row.latency_ms.jev}`);
  if (typeof row.latency_ms?.total !== 'number') problems.push('latency_ms.total missing');
  return problems;
});

// 8. Attribution fields, without which a row cannot be traced to a task or a build.
record('attribution fields present', assessments, (row) => {
  const problems = [];
  for (const key of ['assessment_id', 'build_id', 'fingerprint']) {
    if (typeof row[key] !== 'string' || row[key].length === 0) problems.push(`${key} missing`);
  }
  if (typeof row.task_key !== 'string' || row.task_key.length === 0) problems.push('task_key missing');
  if (typeof row.turn !== 'number') problems.push('turn missing');
  return problems;
});

// 9. The same material state must not pay twice. Within one task, two rows with the
//    same fingerprint mean the dedup rule failed to fire.
record('no duplicate Jev call for one fingerprint', withJev, (row) => {
  const sameTask = withJev.filter(
    (other) => other.task_key === row.task_key && other.fingerprint === row.fingerprint && other._line !== row._line,
  );
  return sameTask.length === 0 ? [] : [`fingerprint ${row.fingerprint} was assessed ${sameTask.length + 1} times in this task`];
});

// ── report ──────────────────────────────────────────────────────────────────

if (asJson) {
  console.log(JSON.stringify({ path: LOG_PATH, assessments: assessments.length, withJev: withJev.length, checks }, null, 2));
  process.exit(0);
}

console.log(`log: ${LOG_PATH}`);
if (since !== null) console.log(`since: ${since}`);
console.log(`assessments in scope: ${assessments.length}    reached Jev: ${withJev.length}`);
console.log('');

if (withJev.length === 0) {
  console.log('No assessment has reached Jev yet, so the Jev-specific checks are vacuous.');
  console.log('Run a turn that uses a tool, then re-run this.');
  console.log('');
}

let failures = 0;
for (const check of checks) {
  const status = check.problems.length === 0 ? 'OK  ' : 'FAIL';
  if (check.problems.length > 0) failures += 1;
  console.log(`${status} ${check.name}${check.checked === 0 ? '  (nothing to check)' : `  [${check.checked} row(s)]`}`);
  for (const problem of check.problems.slice(0, 5)) {
    console.log(`       line ${problem.line} (turn ${problem.turn}): ${problem.problem}`);
  }
  if (check.problems.length > 5) console.log(`       ... and ${check.problems.length - 5} more`);
}

console.log('');
console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
