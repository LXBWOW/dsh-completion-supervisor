#!/usr/bin/env node
/**
 * Offline analysis and threshold replay.
 *
 * WHAT THIS IS FOR
 * ----------------
 * The shadow log records, for every assessment: the deterministic facts, Jev's
 * seven probabilities, the decision the policy reached, and (backfilled later)
 * what the user actually did next. Because `decide()` is a PURE function, we can
 * re-run every logged assessment through a DIFFERENT threshold set and count what
 * would have happened — without calling Jev again, and without touching a live
 * session.
 *
 * That is the only honest way to choose thresholds. Shipping a guess, then
 * observing production breakage, is not tuning; it is gambling with the user's
 * turns.
 *
 * USAGE
 *   node tools/analyse.mjs                     # summary of the default log
 *   node tools/analyse.mjs --replay            # threshold sweep
 *   node tools/analyse.mjs --path <file>       # a different log
 *
 * The replay is deliberately read-only: it never calls Jev and never writes.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

import { readLog, joinOutcomes } from '../lib/log.js';
import { ACTIONS, DEFAULT_THRESHOLDS, decide } from '../lib/policy.js';
import { JEV_QUESTION_NAMES } from '../lib/questions.js';

function parseArgs(argv) {
  const args = { path: null, replay: false, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--replay') args.replay = true;
    else if (token === '--json') args.json = true;
    else if (token === '--path') args.path = argv[index + 1] ?? null;
  }
  return args;
}

function defaultPath() {
  return join(homedir(), '.dsh', 'completion-supervisor', 'assessments.jsonl');
}

/** Percentage helper that never divides by zero. */
function pct(numerator, denominator) {
  if (denominator === 0) return '—';
  return `${((numerator / denominator) * 100).toFixed(1)}%`;
}

function countBy(list, key) {
  const counts = new Map();
  for (const item of list) {
    const value = typeof key === 'function' ? key(item) : item[key];
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return counts;
}

/**
 * Nearest-rank percentile over a numeric list.
 *
 * Nearest-rank, not interpolated: every value here is a real observed latency, and a
 * percentile reporting a number no call ever produced invites false precision on a
 * sample of a dozen rows. With small n the honest answer to "p99" is the maximum.
 */
function percentile(values, p) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
}

/** A fixed-width cell for a probability, or an em dash when the question has no data. */
function prob(value) {
  return value === null || value === undefined ? '      —' : value.toFixed(2).padStart(7);
}

/**
 * Classify a turn by its deterministic facts, for sample-coverage reporting.
 *
 * Deliberately keyed on FACTS and never on the decision: grouping by the decision would
 * make the report circular, since the decision is the thing under evaluation. Order is
 * most-specific-first, and the buckets are the coverage checklist a calibration sample
 * has to satisfy — a sample that is entirely "strong verification" says nothing about
 * the ambiguous cases the supervisor exists for.
 */
function turnShape(row) {
  const facts = row.facts;
  if (facts === null || facts === undefined) return 'no facts recorded (older row)';
  if (facts.repo_available === false) return 'repo unavailable (git could not answer)';
  if (facts.tests_passed === false || facts.build_ok === false || facts.lint_ok === false) {
    return 'observed failure';
  }
  if (facts.error_results_n > 0) return 'errors in tool results';
  if (facts.tests_run === true && facts.tests_passed === null) {
    return 'test evidence unknown (exit not attributable)';
  }
  if (facts.tests_run === true && facts.tests_passed === true) return 'strong verification (tests ran and passed)';
  if (facts.unverified_claims_n > 0) return 'claim without evidence (contradiction)';
  if (facts.tests_run === false || facts.tests_run === null) return 'unverified (no test run recorded)';
  return 'other';
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const path = args.path ?? defaultPath();

  if (!existsSync(path)) {
    console.log(`no log at ${path}`);
    console.log('run DSH with the completion supervisor enabled and shadowMode: true first.');
    return 0;
  }

  const rows = readLog(path);
  const assessments = joinOutcomes(rows);
  const withOutcome = assessments.filter((row) => row.ground_truth !== null);
  const skips = rows.filter((row) => row.row === 'skip');

  if (args.json) {
    console.log(JSON.stringify({ path, total: assessments.length, assessments, skips }, null, 2));
    return 0;
  }

  console.log(`log: ${path}`);
  console.log(`assessments: ${assessments.length}   with a recorded outcome: ${withOutcome.length}   skips: ${skips.length}`);
  if (assessments.length === 0 && skips.length === 0) return 0;

  // ── what we chose NOT to assess ────────────────────────────────────────────
  //
  // Reported before the assessments, on purpose. A skip rule that fires too often
  // makes the rest of this report look BETTER than reality, because the turns it
  // swallowed never appear in the assessment counts. Reading the suppressions first
  // is what keeps that from being invisible.
  if (skips.length > 0) {
    console.log('');
    console.log('skips (turns we chose not to assess)');
    for (const [reason, count] of [...countBy(skips, (row) => row.reason ?? 'unknown')].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${String(reason).padEnd(28)} ${String(count).padStart(5)}`);
    }
    // The material/message split at the moment of skipping: the field that will
    // decide whether `no_tool_calls` is a good rule or a blunt one.
    const skippedByRule = skips.filter((row) => row.reason === 'no_tool_calls');
    const withSplit = skippedByRule.filter((row) => typeof row.material_tool_calls === 'number');
    if (withSplit.length > 0) {
      const messageOnly = withSplit.filter((row) => row.material_tool_calls === 0).length;
      console.log(
        `  of the ${withSplit.length} no_tool_calls skips, ${messageOnly} had zero MATERIAL tool calls ` +
          `(${pct(messageOnly, withSplit.length)}) — the rest carried real work`,
      );
    }
    const total = assessments.length + skips.length;
    console.log(`  skip rate: ${pct(skips.length, total)} of ${total} stoppages`);
  }

  // ── the per-task budget ────────────────────────────────────────────────────
  //
  // Answers one question the row counts cannot: are assessments capped per USER
  // TASK (the ceiling), or is the ceiling silently not applying because the budget
  // resets more often than intended? Both look identical in a bare total.
  //
  // Grouped by `task_key`, which only rows written after the field was added carry.
  // Old rows are reported as unattributed rather than merged into a bucket, because
  // pooling them with real task keys would invent a task that never existed.
  const attributed = assessments.filter((row) => typeof row.task_key === 'string' && row.task_key.length > 0);
  if (attributed.length > 0) {
    const perTask = countBy(attributed, (row) => row.task_key);
    const sizes = [...perTask.values()];
    const busiest = Math.max(...sizes);
    const hitsCeiling = [...perTask.entries()].filter(([, n]) => busiest > 0 && n >= busiest).length;

    console.log('');
    console.log('per-task budget');
    console.log(`  tasks with an assessment: ${perTask.size}   assessments: ${attributed.length}`);
    console.log(
      `  assessments per task: max ${busiest}, mean ${(attributed.length / perTask.size).toFixed(2)}`,
    );
    if (busiest > 1) {
      console.log(`  -> the budget is being spent more than once in a task: the ceiling is live, not vacuous`);
    } else {
      console.log(`  -> every task used exactly one assessment (the normal target)`);
    }
    // A budget row records the counter it compared against. If the ceiling ever
    // fired without a matching skip row, the two views disagree and that is worth
    // seeing rather than trusting.
    const atCeiling = attributed.filter((row) => {
      const used = row.assessments_used_before;
      const max = row.max_assessments;
      return typeof used === 'number' && typeof max === 'number' && used >= max;
    });
    if (atCeiling.length > 0) {
      console.log(`  WARNING: ${atCeiling.length} assessment(s) ran with the budget already spent`);
    }
    const unattributed = assessments.length - attributed.length;
    if (unattributed > 0) {
      console.log(`  (${unattributed} older row(s) predate task_key and are excluded above)`);
    }
  }

  // ── what was actually asked about ──────────────────────────────────────────
  //
  // The goal and the claim are the two texts the whole judgement is about, and the
  // worst defect found so far was a goal fabricated from a synthetic user-role
  // message. Rows written before `asked` existed cannot be checked; rows after it
  // can, so this prints the most recent few for eyeballing rather than requiring a
  // reader to hand-decode JSONL.
  const withAsked = assessments.filter((row) => row.asked?.goal !== undefined && row.asked !== null);
  if (withAsked.length > 0) {
    console.log('');
    console.log(`what was asked about (last ${Math.min(5, withAsked.length)} of ${withAsked.length})`);
    for (const row of withAsked.slice(-5)) {
      const goal = typeof row.asked.goal === 'string' ? row.asked.goal : '(none)';
      const claim = typeof row.asked.claim === 'string' ? row.asked.claim : '(none)';
      console.log(`  turn ${String(row.turn).padStart(3)}  goal : ${goal.slice(0, 90)}`);
      console.log(`             claim: ${claim.slice(0, 90)}`);
    }
    // A goal that looks like injected context is a red flag worth surfacing without
    // requiring anyone to read the excerpts above.
    const suspicious = withAsked.filter(
      (row) => typeof row.asked.goal === 'string' &&
        /system-reminder|skill-catalog|workspace instructions/i.test(row.asked.goal),
    );
    if (suspicious.length > 0) {
      console.log(`  WARNING: ${suspicious.length} row(s) have an INJECTED goal, not a user request`);
    }
  } else if (assessments.length > 0) {
    console.log('');
    console.log('no row records what was asked (rows predate the `asked` field)');
  }

  // ── evidence we could not read ─────────────────────────────────────────────
  //
  // A command whose host exit code belongs to a LATER statement (the agent wrapped the
  // call to capture its output) is recorded with `exit_attributable: false`, and its
  // verdict becomes "unknown" rather than a pass. On the first live round that is
  // exactly how a FAILING suite was nearly recorded as passing. Reporting the rate does
  // two things: it explains why some rows show `tests_passed: null` instead of a
  // verdict, and it measures how often agents write that shape at all — a prerequisite
  // for deciding whether the plugin should suggest the faithful form.
  const unattributable = assessments.filter(
    (row) => typeof row.facts?.unattributable_exits_n === 'number' && row.facts.unattributable_exits_n > 0,
  );
  if (unattributable.length > 0) {
    console.log('');
    console.log('unreadable exit codes (wrapped commands)');
    console.log(
      `  rows affected: ${unattributable.length}/${assessments.length} (${pct(unattributable.length, assessments.length)})`,
    );
    const totalWrapped = unattributable.reduce((sum, row) => sum + row.facts.unattributable_exits_n, 0);
    console.log(`  commands affected: ${totalWrapped}`);
    const unknownVerdicts = unattributable.filter(
      (row) => row.facts.tests_passed === null && row.facts.tests_run === true,
    ).length;
    if (unknownVerdicts > 0) {
      console.log(`  -> ${unknownVerdicts} row(s) have tests_run=true with tests_passed=null: the run happened,`);
      console.log('     and its result honestly could not be read. Not a failure, not a pass.');
    }
  }

  if (assessments.length === 0) return 0;

  // ── headline numbers ───────────────────────────────────────────────────────
  const shadowCount = assessments.filter((row) => row.shadow === true).length;
  const cost = assessments.reduce((sum, row) => sum + (row.cost_usd_est ?? 0), 0);

  // A timeout is counted SEPARATELY from every other failure, because it is not the
  // same kind of event. A malformed response is a bug in one of us; a timeout is a
  // MISSING OBSERVATION, and if slow calls are systematically the hard or ambiguous
  // ones then the cutoff biases the sample rather than merely shrinking it. The
  // distinction also drives a different fix: a bug needs code, a timeout needs a
  // number — and that number has to be measured before it can be chosen, because once
  // intervention is on it sits on the turn-close path where the user waits for it.
  const answered = assessments.filter((row) => row.jev?.probabilities !== undefined);
  const timedOut = assessments.filter((row) => row.jev_error?.kind === 'timeout');
  // Failures of a request we actually SENT. `no_key` and `state_overflow` are excluded
  // and reported separately, because neither is a Jev failure: one is a configuration
  // state, the other a decision not to ask. Counting them here would inflate the
  // fail-open rate with rows where nothing was ever attempted, and the whole point of
  // this metric is to measure how often a real call goes wrong.
  const notAttempted = assessments.filter(
    (row) => row.jev_error?.kind === 'no_key' || row.jev_error?.kind === 'state_overflow',
  );
  const attempted = answered.length + assessments.filter((row) => row.jev_error !== null &&
    row.jev_error !== undefined && row.jev_error.kind !== 'no_key' && row.jev_error.kind !== 'state_overflow').length;
  const otherFailures = assessments.filter(
    (row) => row.jev_error !== null && row.jev_error !== undefined &&
      row.jev_error.kind !== 'timeout' && row.jev_error.kind !== 'no_key' && row.jev_error.kind !== 'state_overflow',
  );
  const latencies = answered.map((row) => row.latency_ms?.jev).filter((value) => typeof value === 'number');

  console.log('');
  console.log('mode');
  console.log(`  shadow rows:  ${shadowCount}/${assessments.length}`);
  console.log(`  total cost:   $${cost.toFixed(5)}`);

  console.log('');
  console.log('jev calls');
  console.log(`  attempted: ${attempted}   answered: ${answered.length}   timed out: ${timedOut.length}   other failures: ${otherFailures.length}`);
  if (notAttempted.length > 0) {
    console.log('  not attempted (not failures — no request was sent):');
    for (const [kind, count] of [...countBy(notAttempted, (row) => row.jev_error?.kind ?? 'unknown')].sort((a, b) => b[1] - a[1])) {
      console.log(`    ${String(kind).padEnd(18)} ${String(count).padStart(5)}`);
    }
  }
  if (latencies.length > 0) {
    console.log(
      `  latency (answered only): p50 ${percentile(latencies, 50)}ms   p95 ${percentile(latencies, 95)}ms` +
        `   p99 ${percentile(latencies, 99)}ms   max ${percentile(latencies, 100)}ms`,
    );
  }
  if (timedOut.length > 0) {
    // The configured cutoff at the time of each timeout is the only latency fact a
    // timeout row carries: the call ran for AT LEAST that long, and how much longer is
    // unknowable. Printed per cutoff rather than averaged, because the cutoff may have
    // changed between rows and pooling them would hide that.
    for (const [cutoff, count] of countBy(timedOut, (row) => row.jev_error?.message ?? 'unknown cutoff')) {
      console.log(`  timed out against: ${count} x ${String(cutoff).slice(0, 70)}`);
    }
    console.log('  -> these are LOST observations, not slow rows. If the slow calls are the');
    console.log('     ambiguous ones, the remaining sample is biased toward the easy cases.');
  }
  if (attempted > 0) {
    console.log(
      `  fail-open rate: ${pct(timedOut.length + otherFailures.length, attempted)} of ${attempted} real calls` +
        ' (target: under 5%)',
    );
  }

  // ── which model actually answered ──────────────────────────────────────────
  //
  // The check that decides whether a calibration is still valid. `jev-latest` is a
  // moving alias, so a log recording only the alias cannot answer "has the thing behind
  // it changed since these rows were written?" — and a threshold derived under one
  // model and applied under another is not a weaker calibration, it is an unvalidated
  // one. Rows with no reported model are counted rather than assumed, because assuming
  // would manufacture exactly the confirmation this section exists to provide.
  if (answered.length > 0) {
    // "The field is absent" and "the field is null" are DIFFERENT facts and must not be
    // pooled: the first says the row predates the field, the second says the API did not
    // name a model. Collapsing them into one bucket would report an API behaviour that
    // was never observed — the same mistake as reading an empty `changed_files_n` on a
    // non-repository directory as "nothing changed".
    const provenance = (row, key, absentLabel) => {
      if (row.jev === null || row.jev === undefined || !(key in row.jev)) return absentLabel;
      return row.jev[key] ?? '(the response named none)';
    };
    const requested = countBy(answered, (row) => provenance(row, 'model_requested', '(row predates the field)'));
    const observed = countBy(answered, (row) => provenance(row, 'model', '(row predates the field)'));
    const measured = answered.filter((row) => row.jev !== null && row.jev !== undefined && 'model' in row.jev);

    console.log('');
    console.log('model provenance');
    for (const [alias, count] of requested) console.log(`  requested: ${alias}  (${count} row(s))`);
    for (const [id, count] of observed) console.log(`  answered by: ${id}  (${count} row(s))`);
    if (measured.length === 0) {
      console.log('  NOTE: no row yet carries an observed model id — they were all written before');
      console.log('  the field existed. Nothing is known about which version answered them, so treat');
      console.log('  their probabilities as unlabelled. The next assessment will settle it.');
    } else if (observed.size > 1) {
      console.log('  WARNING: rows span more than one model. Do not pool them when tuning');
      console.log('  thresholds, and re-check any calibration derived before the change.');
    } else if ([...observed.keys()][0] === '(the response named none)') {
      console.log('  NOTE: the API returned no model field in these responses, so calibration is');
      console.log('  bound to a moving alias. Pin a concrete version before tuning thresholds.');
    }
  }

  // ── are the probabilities carrying information at all? ─────────────────────
  //
  // A question that returns the same number on every state is a constant: it cannot
  // discriminate, so its weight in the policy is dead weight, and any threshold tuned
  // on it is fitted to noise. This has to be checked BEFORE thresholds are chosen —
  // afterwards it is indistinguishable from a real signal. Reported per question rather
  // than as one number, because the informative failure is one question going flat
  // while the others still vary.
  if (answered.length > 0) {
    console.log('');
    console.log(`probability spread per question (n=${answered.length})`);
    console.log(
      '  ' +
        'question'.padEnd(26) +
        'min'.padStart(7) +
        'p25'.padStart(7) +
        'med'.padStart(7) +
        'p75'.padStart(7) +
        'max'.padStart(7) +
        'distinct'.padStart(10),
    );
    for (const name of JEV_QUESTION_NAMES) {
      const values = answered
        .map((row) => row.jev.probabilities?.[name])
        .filter((value) => typeof value === 'number');
      if (values.length === 0) continue;
      console.log(
        '  ' +
          name.padEnd(26) +
          prob(percentile(values, 0)) +
          prob(percentile(values, 25)) +
          prob(percentile(values, 50)) +
          prob(percentile(values, 75)) +
          prob(percentile(values, 100)) +
          String(new Set(values).size).padStart(10),
      );
    }
    console.log('  distinct=1 across every row means that question is a constant on this sample,');
    console.log('  so its weight in the policy is not yet justified by any data.');
  }

  // ── coverage: what KIND of turn was assessed? ──────────────────────────────
  //
  // Grouped by deterministic facts, never by the decision, so the grouping cannot
  // become circular. These buckets are the coverage checklist for a calibration sample:
  // a sample that is entirely "strong verification" cannot show how the policy behaves
  // on the ambiguous cases, which are the only ones it exists for.
  if (assessments.length > 0) {
    console.log('');
    console.log('task shapes (deterministic facts, not the decision)');
    for (const [shape, count] of [...countBy(assessments, turnShape)].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${String(shape).padEnd(46)} ${String(count).padStart(5)}`);
    }
  }

  // ── what the policy decided ────────────────────────────────────────────────
  console.log('');
  console.log('decisions (would-have)');
  for (const [action, count] of [...countBy(assessments, (row) => row.decision?.action ?? 'none')].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(action).padEnd(12)} ${String(count).padStart(5)}  ${pct(count, assessments.length)}`);
  }

  console.log('');
  console.log('rules fired');
  for (const [rule, count] of [...countBy(assessments, (row) => row.decision?.rule ?? 'none')].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(rule).padEnd(28)} ${String(count).padStart(5)}`);
  }

  // ── compression pressure ───────────────────────────────────────────────────
  console.log('');
  console.log('state compression stages');
  for (const [stage, count] of [...countBy(assessments, (row) => row.state_stage ?? 'unknown')].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(stage).padEnd(24)} ${String(count).padStart(5)}`);
  }
  const tokens = assessments.map((row) => row.state_tokens_est).filter((value) => typeof value === 'number');
  if (tokens.length > 0) {
    const sorted = [...tokens].sort((a, b) => a - b);
    console.log(`  estimated state tokens: median ${sorted[Math.floor(sorted.length / 2)]}, max ${sorted.at(-1)}`);
  }

  // ── the metrics that actually matter ───────────────────────────────────────
  if (withOutcome.length > 0) {
    console.log('');
    console.log('ground truth (the judgements that matter)');
    for (const [verdict, count] of [...countBy(withOutcome, (row) => row.ground_truth?.verdict ?? 'unknown')].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${String(verdict).padEnd(22)} ${String(count).padStart(5)}`);
    }

    // Of the turns we would have blocked, how many would the user have disputed?
    const blocked = withOutcome.filter((row) => row.ground_truth?.blocked === true);
    const falseBlocks = blocked.filter((row) => row.ground_truth?.verdict === 'false_block').length;
    const goodBlocks = blocked.filter((row) => row.ground_truth?.verdict === 'good_block').length;

    // Of the turns we would have passed, how many did the user then complain about?
    const passed = withOutcome.filter((row) => row.ground_truth?.passed === true);
    const falsePasses = passed.filter((row) => row.ground_truth?.verdict === 'false_pass').length;

    console.log('');
    console.log('headline');
    console.log(`  would-block: ${blocked.length}  -> false blocks ${falseBlocks} (${pct(falseBlocks, blocked.length)}), helpful ${goodBlocks}`);
    console.log(`  would-pass:  ${passed.length}  -> false passes ${falsePasses} (${pct(falsePasses, passed.length)})`);
    console.log('');
    console.log('  NOTE: a false block is far more expensive than a false pass. Do not');
    console.log('  enable intervention if the false-block rate is above ~10%.');
  } else {
    console.log('');
    console.log('no outcome rows yet — ground truth is backfilled when the next user');
    console.log('message arrives after an assessment, so this fills in with use.');
  }

  // ── threshold replay ───────────────────────────────────────────────────────
  if (args.replay) {
    const replayable = assessments.filter((row) => row.jev?.probabilities !== undefined && row.facts !== null);
    console.log('');
    console.log(`threshold replay over ${replayable.length} assessments with probabilities`);

    if (replayable.length === 0) {
      console.log('  nothing to replay (no rows carry both probabilities and facts)');
      return 0;
    }

    const sweep = [
      { label: 'default', thresholds: {} },
      { label: 'finish>=0.90', thresholds: { readyToFinishAtOrAbove: 0.9 } },
      { label: 'finish>=0.85', thresholds: { readyToFinishAtOrAbove: 0.85 } },
      { label: 'finish>=0.80', thresholds: { readyToFinishAtOrAbove: 0.8 } },
      { label: 'finish>=0.70', thresholds: { readyToFinishAtOrAbove: 0.7 } },
      { label: 'block<=0.30', thresholds: { requirementsUnsatisfiedBelow: 0.3, blockingIssueAtOrAbove: 0.8 } },
      { label: 'block<=0.50', thresholds: { requirementsUnsatisfiedBelow: 0.5, blockingIssueAtOrAbove: 0.55 } },
      { label: 'no det. gates', thresholds: { blockOnUnverifiedClaim: false, blockOnUnresolvedErrors: false } },
    ];

    console.log('');
    console.log('  thresholds'.padEnd(20) + 'block'.padStart(8) + 'finish'.padStart(8) + 'false-block'.padStart(13));

    for (const entry of sweep) {
      let wouldBlock = 0;
      let wouldFinish = 0;
      let observedFalseBlocks = 0;

      for (const row of replayable) {
        // Reconstruct the minimal state the policy reads, from the logged facts.
        const replayed = {
          evidence: {
            tests_run: row.facts.tests_run,
            tests_passed: row.facts.tests_passed,
            build_ok: row.facts.build_ok,
            lint_ok: row.facts.lint_ok,
            error_results: Array.from({ length: row.facts.error_results_n ?? 0 }, () => ({ tool: 'logged', msg: '' })),
            unverified_claims: Array.from({ length: row.facts.unverified_claims_n ?? 0 }, () => 'logged'),
          },
          repo: { changed_files: [], untracked: [] },
          prior: null,
        };
        const decision = decide({
          state: replayed,
          probabilities: row.jev.probabilities,
          thresholds: { ...DEFAULT_THRESHOLDS, ...entry.thresholds },
        });
        const blocked = decision.action !== ACTIONS.FINISH && decision.action !== ACTIONS.PASS;
        if (blocked) {
          wouldBlock += 1;
          if (row.ground_truth?.verdict === 'false_block') observedFalseBlocks += 1;
        } else {
          wouldFinish += 1;
        }
      }

      console.log(
        `  ${entry.label.padEnd(20)}${String(wouldBlock).padStart(8)}${String(wouldFinish).padStart(8)}` +
          `${String(observedFalseBlocks).padStart(13)}`,
      );
    }

    console.log('');
    console.log('  Read this as: how many turns each threshold set would have interrupted,');
    console.log('  and how often the user then dismissed us. Pick the strictest set whose');
    console.log('  false-block count stays acceptable.');
  }

  return 0;
}

process.exitCode = main();
