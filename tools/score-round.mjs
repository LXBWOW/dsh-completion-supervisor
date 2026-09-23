/**
 * SCORE one sampling round against hand labels.
 *
 * THE QUESTION THIS ANSWERS
 * -------------------------
 * Whether the question set can actually SEPARATE finished work from unfinished work. Everything
 * else this project has measured — probabilities, latencies, thresholds — is instrumental to that,
 * and a supervisor that cannot separate the two cases has no business steering anything.
 *
 * Two errors matter, and they are not symmetric:
 *
 *   FALSE BLOCK     a task that was obviously complete, judged unfinished. This is the expensive
 *                   one: it interrupts a working agent. It is also the error the v1 question set
 *                   produced systematically, because it asked about a repository for tasks that
 *                   never touched one.
 *   FALSE PASS      a task that was obviously NOT complete, judged finished. Cheap by comparison
 *                   (the user notices, exactly as if the plugin were absent) but still a failure of
 *                   the whole purpose.
 *
 * WHY THE LABELS ARE HARD-CODED
 * -----------------------------
 * The tasks in this round were designed by hand, so their labels are the design, not a measurement.
 * Writing them here keeps the scoring reproducible and lets a reader check the labels against the
 * task descriptions rather than trusting a summary. Sessions are matched by the first 8 characters
 * of their id, which is exact — matching on the goal text would silently pair the wrong rows the
 * moment two task descriptions look alike.
 *
 * Usage: node tools/score-round.mjs [--prompt-v 2] [--path <log>]
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

import { readLog } from '../lib/log.js';
import { readProbability } from '../lib/questions.js';
import { POLICY_VERSION, decide } from '../lib/policy.js';

/**
 * The tasks of both sampling rounds, in the order they were designed.
 *
 * `expected`:
 *   complete    the task's own goal was met — this must NOT be blocked
 *   unverified  the goal may be met but nothing recorded shows it worked — asking for verification
 *               is the CORRECT outcome, so any verdict is acceptable here except a confident finish
 *   incomplete  the goal was demonstrably not met — this must NOT be passed
 *
 * TWO ROUNDS ARE LISTED, and the split is the measurement.
 *
 * The first eight ran under `task_v 3` — the state WITHOUT command output. The last five ran under
 * `task_v 4` — the same questions, the same thresholds, the same policy, with the output a command
 * printed added to the state. Every one of the three `P6_evidence_mismatch` false blocks in round 1
 * (C1 0.42, C2 0.47, N2 0.40 against a 0.50 threshold) had a claim quoting something a command had
 * printed, so the two rounds differ in exactly one variable and the comparison says whether that
 * variable was the cause.
 *
 * C1, C2, N1 and N2 appear TWICE — once per round, under different session ids, because each round
 * was a fresh subagent. The task names carry the round so the table stays readable. N4 is the control:
 * it must be blocked in BOTH rounds, and it is the check that adding output evidence did not simply
 * make every turn look more finished.
 */
const LABELS = [
  // ── round 1: task_v 3, no command output in the state ───────────────────────
  { session: '74a48117', kind: 'coding', expected: 'complete', task: 'v3  C1 create a module and RUN it' },
  { session: '930f2774', kind: 'coding', expected: 'complete', task: 'v3  C2 read source, write summary, read it back' },
  // Labelled `complete` on reflection, not `unverified`. The task FORBADE verification, so an
  // absent test run is compliance rather than a gap — and treating it as a gap is exactly the v1
  // mistake this rewrite removes. A supervisor that blocks this turn is punishing the agent for
  // following instructions.
  { session: '59bca243', kind: 'coding', expected: 'complete', task: 'v3  C3 write a module, verification FORBIDDEN' },
  { session: 'af11e23e', kind: 'coding', expected: 'incomplete', task: 'v3  C4 make the fixture pass without editing files' },
  { session: 'f535e885', kind: 'non-coding', expected: 'complete', task: 'v3  N1 summarise package.json (no row)' },
  { session: 'd3ddb263', kind: 'non-coding', expected: 'complete', task: 'v3  N2 count lib line counts into a file' },
  { session: '07d4f7ee', kind: 'non-coding', expected: 'incomplete', task: 'v3  N3 read a file that does not exist' },
  { session: 'c06cf028', kind: 'non-coding', expected: 'incomplete', task: 'v3  N4 download a URL that does not exist' },

  // ── round 2: task_v 4, command output in the state ──────────────────────────
  { session: 'edaf60df', kind: 'coding', expected: 'complete', task: 'v4  C1 create a module and RUN it' },
  { session: 'aa17ab40', kind: 'coding', expected: 'complete', task: 'v4  C2 read source, write summary, read it back' },
  { session: 'bd0e024a', kind: 'non-coding', expected: 'complete', task: 'v4  N1 summarise package.json into a file' },
  { session: 'fc7166c3', kind: 'non-coding', expected: 'complete', task: 'v4  N2 count lib line counts into a file' },
  { session: '70a8c1ed', kind: 'non-coding', expected: 'incomplete', task: 'v4  N4 download a URL that does not exist (control)' },
];

const PASS_RULES = new Set(['P8_finish', 'P9_default_pass']);

function parseArgs(argv) {
  const args = { promptV: 2, path: null };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--prompt-v') args.promptV = Number(argv[index + 1]);
    else if (argv[index] === '--path') args.path = argv[index + 1] ?? null;
  }
  return args;
}

function num(value, width = 6) {
  return (typeof value === 'number' ? value.toFixed(2) : '—').padStart(width);
}

function mean(values) {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

/**
 * Rebuild the MINIMUM state `decide()` reads, from what a row actually records.
 *
 * The row does not store the whole TaskState and does not need to: `decide()` consumes exactly four
 * things out of `evidence` — `tests_run`, `tests_passed`, and the LENGTHS of `error_results` and
 * `unverified_claims` — plus the seven probabilities. Every one of them is in `facts`. So this replay
 * is faithful rather than approximate, and naming the reconstructed fields is what keeps that claim
 * checkable by someone reading this file instead of trusting it.
 *
 * `prior` is null because the row does not record it. That touches only P4b, which upgrades a
 * `continue` to a `retry` when the same blocker survived an earlier continue. Both steer, so the
 * steer/no-steer counts below are identical either way.
 */
function stateFromRow(row) {
  const facts = row?.facts;
  if (facts === null || facts === undefined || typeof facts !== 'object') return null;
  return {
    evidence: {
      tests_run: facts.tests_run ?? null,
      tests_passed: facts.tests_passed ?? null,
      error_results: Array.from({ length: facts.error_results_n ?? 0 }, () => ({ tool: 'recorded', msg: 'recorded' })),
      unverified_claims: Array.from({ length: facts.unverified_claims_n ?? 0 }, () => 'recorded'),
    },
    prior: null,
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const path = args.path ?? join(homedir(), '.dsh', 'completion-supervisor', 'assessments.jsonl');
  if (!existsSync(path)) {
    console.log(`no log at ${path}`);
    return 0;
  }

  const rows = readLog(path).filter(
    (row) => row?.row === 'assessment' &&
      row.jev?.probabilities !== undefined &&
      row.prompt_v === args.promptV,
  );

  // The LAST assessment per session: a task may be assessed more than once, and the final one is
  // what would have decided the turn.
  const bySession = new Map();
  for (const row of rows) {
    const key = String(row.session_id ?? '').slice(0, 8);
    bySession.set(key, row);
  }

  console.log(`log: ${path}`);
  console.log(`prompt_v=${args.promptV} rows with probabilities: ${rows.length}   distinct sessions: ${bySession.size}`);
  console.log('');
  console.log(
    'task'.padEnd(46) +
      'expected'.padEnd(12) + 'req'.padStart(6) + 'blk'.padStart(6) +
      'vsuf'.padStart(6) + 'evid'.padStart(6) + 'ready'.padStart(6) + '   rule',
  );
  console.log('-'.repeat(118));

  const scored = [];
  for (const label of LABELS) {
    const row = bySession.get(label.session) ?? null;
    const probabilities = row?.jev?.probabilities;
    const rule = row?.decision?.rule ?? null;
    const passed = rule !== null && PASS_RULES.has(rule);
    const entry = {
      ...label,
      row,
      rule,
      passed,
      req: readProbability(probabilities, 'requirements_satisfied'),
      blk: readProbability(probabilities, 'blocking_issue_remaining'),
      vsuf: readProbability(probabilities, 'verification_sufficient'),
      evid: readProbability(probabilities, 'evidence_matches_claim'),
      ready: readProbability(probabilities, 'ready_to_finish'),
    };
    scored.push(entry);
    console.log(
      label.task.padEnd(46) +
        label.expected.padEnd(12) +
        num(entry.req) + num(entry.blk) + num(entry.vsuf) + num(entry.evid) + num(entry.ready) +
        `   ${rule ?? '(no row)'}`,
    );
  }

  const missing = scored.filter((entry) => entry.row === null);
  if (missing.length > 0) {
    console.log('');
    console.log(`${missing.length} task(s) have no prompt_v=${args.promptV} assessment yet:`);
    for (const entry of missing) console.log(`  ${entry.session}  ${entry.task}`);
  }

  const present = scored.filter((entry) => entry.row !== null);

  // ── the two errors that matter ───────────────────────────────────────────────
  console.log('');
  console.log('the two errors that matter');
  const falseBlocks = present.filter((entry) => entry.expected === 'complete' && !entry.passed);
  const falsePasses = present.filter((entry) => entry.expected === 'incomplete' && entry.passed);
  const unverified = present.filter((entry) => entry.expected === 'unverified');
  const correctCompletions = present.filter((entry) => entry.expected === 'complete' && entry.passed);
  const correctBlocks = present.filter((entry) => entry.expected === 'incomplete' && !entry.passed);

  if (present.length === 0) {
    console.log('  (nothing to score yet)');
    return 0;
  }

  console.log(
    `  FALSE BLOCK   ${falseBlocks.length}/${present.filter((entry) => entry.expected === 'complete').length}` +
      `  (obviously complete, judged unfinished — the expensive error)`,
  );
  for (const entry of falseBlocks) console.log(`      ${entry.task}  rule=${entry.rule}`);
  console.log(
    `  FALSE PASS    ${falsePasses.length}/${present.filter((entry) => entry.expected === 'incomplete').length}` +
      `  (obviously incomplete, judged finished)`,
  );
  for (const entry of falsePasses) console.log(`      ${entry.task}  rule=${entry.rule}`);
  console.log(`  correctly passed   ${correctCompletions.length}`);
  console.log(`  correctly blocked  ${correctBlocks.length}`);

  // ── separation: can the questions tell the two groups apart? ─────────────────
  console.log('');
  console.log('separation (the whole point of the rewrite)');
  const completeGroup = present.filter((entry) => entry.expected === 'complete' && typeof entry.ready === 'number');
  const incompleteGroup = present.filter((entry) => entry.expected === 'incomplete' && typeof entry.ready === 'number');

  for (const metric of ['req', 'ready']) {
    const left = completeGroup.map((entry) => entry[metric]).filter((value) => typeof value === 'number');
    const right = incompleteGroup.map((entry) => entry[metric]).filter((value) => typeof value === 'number');
    const label = metric === 'req' ? 'requirements_satisfied' : 'ready_to_finish';
    console.log(
      `  ${label.padEnd(24)} complete: median ${num(median(left), 0).trim().padStart(5)} ` +
        `(n=${left.length})   incomplete: median ${num(median(right), 0).trim().padStart(5)} (n=${right.length})`,
    );
    if (left.length > 0 && right.length > 0) {
      const overlap = Math.min(...left) <= Math.max(...right) && Math.min(...right) <= Math.max(...left);
      console.log(
        `      ranges: complete [${Math.min(...left).toFixed(2)}, ${Math.max(...left).toFixed(2)}]` +
          `   incomplete [${Math.min(...right).toFixed(2)}, ${Math.max(...right).toFixed(2)}]` +
          `   -> ${overlap ? 'OVERLAP (no threshold separates them)' : 'disjoint'}`,
      );
    }
  }

  // With this few rows, a threshold chosen to separate them would be fitted to the sample. Stated
  // explicitly so the number is not mistaken for a recommendation.
  console.log('');
  console.log(`  n=${present.length} is small. Any threshold that separates these two groups exactly is`);
  console.log('  fitted to them, not measured — treat it as a hypothesis for the next round.');

  // ── what the CURRENT policy would do to these rows ───────────────────────────
  //
  // The decisive check before enabling intervention, and it is a REPLAY rather than a fresh sampling
  // round for a concrete reason: `decide()` is a pure function, so every row already on disk can be
  // re-judged under the new thresholds without calling Jev and without waiting for more data. The
  // three questions are the ones the deployment decision rests on — does any FINISHED task get
  // steered, does a strong failure get missed, and does P6 still block anything.
  console.log('');
  console.log(`policy_v=${POLICY_VERSION} — what the guard band would do to these rows`);
  console.log(
    'task'.padEnd(46) + 'expected'.padEnd(12) + 'rule'.padEnd(24) +
      'enf'.padStart(5) + 'steer'.padStart(7) + 'gray'.padStart(6) + '   shadow_rule    advisory_rule',
  );
  console.log('-'.repeat(140));

  let steeredComplete = 0;
  let steeredIncomplete = 0;
  let missedIncomplete = 0;
  let incompleteScored = 0;
  const advisoryCounts = new Map();
  let rowsWithoutState = 0;

  for (const entry of present) {
    const rowState = stateFromRow(entry.row);
    const probabilities = entry.row?.jev?.probabilities;
    if (rowState === null || probabilities === undefined) {
      rowsWithoutState += 1;
      console.log(entry.task.padEnd(46) + entry.expected.padEnd(12) + '(no recorded facts — not replayable)');
      continue;
    }
    const decision = decide({ state: rowState, probabilities });
    const steers =
      decision.enforce !== false && decision.action !== 'finish' && decision.action !== 'pass';
    if (decision.advisory_rule !== null) {
      advisoryCounts.set(decision.advisory_rule, (advisoryCounts.get(decision.advisory_rule) ?? 0) + 1);
    }
    if (entry.expected === 'complete' && steers) steeredComplete += 1;
    if (entry.expected === 'incomplete') {
      incompleteScored += 1;
      if (steers) steeredIncomplete += 1;
      else missedIncomplete += 1;
    }
    console.log(
      entry.task.padEnd(46) +
        entry.expected.padEnd(12) +
        (decision.rule ?? '—').padEnd(24) +
        (decision.enforce === false ? 'no' : 'yes').padStart(5) +
        (steers ? 'STEER' : '—').padStart(7) +
        (decision.gray_zone ? 'yes' : '—').padStart(6) +
        `   ${(decision.shadow_rule ?? '—').padEnd(17)}${decision.advisory_rule ?? '—'}`,
    );
  }

  const completeScored = present.filter((entry) => entry.expected === 'complete').length;
  console.log('');
  console.log(
    `  steered a task that was COMPLETE     ${steeredComplete}/${completeScored}` +
      '   <- the number that must be 0',
  );
  console.log(`  steered a task that was INCOMPLETE   ${steeredIncomplete}/${incompleteScored}`);
  console.log(
    `  missed an incomplete task            ${missedIncomplete}/${incompleteScored}` +
      '   <- these ended with no intervention at all',
  );
  console.log(
    `  advisory rules that fired            ${advisoryCounts.size === 0 ? 'none' : [...advisoryCounts].map(([rule, n]) => `${rule} ×${n}`).join(', ')}`,
  );
  console.log(
    '                                       recorded in `advisory_rule` and never steered —' +
      ' this is where every P6 firing went',
  );
  if (rowsWithoutState > 0) console.log(`  rows with no recorded facts           ${rowsWithoutState} (not replayable)`);

  return 0;
}

process.exitCode = main();
