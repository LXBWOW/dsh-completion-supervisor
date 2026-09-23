/**
 * Tests for the read-only health summary.
 *
 * Scope, deliberately: this is a READER, so the tests cover the two ways a reader can lie — parsing
 * a log wrongly, and aggregating parsed rows wrongly — plus the one contract that must never
 * regress, which is that it refuses to call a steer a false positive. Depth of policy coverage
 * belongs to the policy tests; nothing here calls a model or writes state.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DEFAULT_HEALTH_LIMIT,
  MAX_HEALTH_LIMIT,
  buildReport,
  clampLimit,
  readLogTail,
  render,
  summarise,
} from '../lib/health.js';

const dir = mkdtempSync(join(tmpdir(), 'cs-health-'));
process.on('exit', () => rmSync(dir, { recursive: true, force: true }));

let fileCounter = 0;
/** Write rows as JSONL and return the path. */
function logFile(lines, name = `log-${(fileCounter += 1)}.jsonl`) {
  const path = join(dir, name);
  writeFileSync(path, lines.map((line) => (typeof line === 'string' ? line : JSON.stringify(line))).join('\n') + '\n', 'utf8');
  return path;
}

/** A minimal but realistic assessment row; override whatever a test is about. */
function assessment(overrides = {}) {
  return {
    log_v: 2,
    build_id: 'BUILD_CURRENT',
    row: 'assessment',
    assessment_id: 'a1',
    at: '2026-01-01T00:00:00.000Z',
    session_id: 's1',
    turn: 1,
    task_key: 'session-aaaaaaaa-1111#task1',
    shadow: false,
    policy_v: 2,
    task_v: 4,
    steers_used_before: 0,
    max_steers_per_task: 1,
    asked: { goal: 'do a thing', claim: 'done' },
    jev: {
      probabilities: { requirements_satisfied: 0.9, blocking_issue_remaining: 0.05 },
      model: 'jev-1.13.0',
    },
    jev_error: null,
    decision: {
      action: 'finish',
      reason: 'completion thresholds satisfied',
      rule: 'P8_finish',
      enforce: true,
      advisory_rule: null,
      gray_zone: false,
      would_steer: false,
      will_steer: false,
      steer_suppressed: null,
    },
    latency_ms: { total: 100, jev: 100 },
    ...overrides,
  };
}

/** A row the policy wanted to steer on. */
function steerRow(overrides = {}) {
  return assessment({
    decision: {
      action: 'continue',
      reason: 'requirements clearly unmet (0.22)',
      rule: 'P4_requirements_unmet',
      enforce: true,
      advisory_rule: null,
      gray_zone: false,
      would_steer: true,
      will_steer: true,
      steer_suppressed: null,
    },
    jev: {
      probabilities: { requirements_satisfied: 0.22, blocking_issue_remaining: 0.31 },
      model: 'jev-1.13.0',
    },
    ...overrides,
  });
}

const runtime = { buildId: 'BUILD_CURRENT', shadow: false };

// ── parsing ─────────────────────────────────────────────────────────────────

test('readLogTail: parses rows, counts bad lines, and reports a torn tail separately', () => {
  // Written by hand rather than through `logFile`, which always terminates the last line: the
  // missing final newline is the thing under test.
  const path = join(dir, 'torn.jsonl');
  writeFileSync(
    path,
    `${JSON.stringify(assessment())}\n{ this is not json\n${JSON.stringify(assessment({ assessment_id: 'a2' }))}\n{"row":"assess`,
    'utf8',
  );
  const tail = readLogTail(path);
  assert.equal(tail.rows.length, 2);
  assert.equal(tail.badLines, 1, 'the genuinely malformed line is counted');
  assert.equal(tail.tornTail, true, 'the unterminated final line is a torn tail, not corruption');
  assert.equal(tail.missing, false);
  assert.equal(tail.unreadable, false);
  assert.equal(tail.scannedAll, true);
});

test('readLogTail: reading a byte-limited tail never reports the half row it started inside', () => {
  const rows = [];
  for (let i = 0; i < 6; i += 1) {
    rows.push(JSON.stringify(assessment({ assessment_id: `a${i}`, task_key: `session-aaaaaaaa-1111#task${i}` })));
  }
  const path = logFile(rows);
  const full = readLogTail(path);
  assert.equal(full.rows.length, 6);

  // Start inside the fifth row: one and a half rows fit in the window.
  const budget = Buffer.byteLength(rows[5], 'utf8') + 40;
  const clipped = readLogTail(path, { maxBytes: budget });
  assert.equal(clipped.scannedAll, false);
  assert.equal(clipped.badLines, 0, 'the partial first line is dropped, not counted as damage');
  assert.equal(clipped.rows.length, 1);
  assert.equal(clipped.rows[0].assessment_id, 'a5');
});

test('readLogTail: a missing file is reported, never thrown', () => {
  const tail = readLogTail(join(dir, 'does-not-exist.jsonl'));
  assert.equal(tail.missing, true);
  assert.deepEqual(tail.rows, []);
});

test('readLogTail: refuses a non-string path without throwing', () => {
  assert.equal(readLogTail(undefined).missing, true);
  assert.equal(readLogTail('').missing, true);
});

// ── aggregation ─────────────────────────────────────────────────────────────

test('summarise: counts a window of assessments and ignores outcome rows', () => {
  const rows = [
    assessment(),
    { row: 'outcome', assessment_id: 'a1', ground_truth: 'user_confirmed_done' },
    assessment({ assessment_id: 'a2' }),
    { row: 'outcome', assessment_id: 'a2' },
  ];
  const report = summarise(rows, { runtime });
  assert.equal(report.window.assessments, 2, 'outcome rows are not assessments');
  assert.equal(report.jev.successes, 2);
  assert.equal(report.jev.failures, 0);
  assert.equal(report.health, 'OK');
});

test('summarise: limit bounds the window from the end, and counts distinct tasks', () => {
  const rows = [];
  for (let i = 0; i < 10; i += 1) {
    rows.push(assessment({ assessment_id: `a${i}`, task_key: `session-aaaaaaaa-1111#task${i}` }));
  }
  const report = summarise(rows, { limit: 3, runtime });
  assert.equal(report.window.assessments, 3);
  assert.equal(report.window.tasks, 3);
  assert.equal(report.window.first, '2026-01-01T00:00:00.000Z');
});

test('summarise: separates wanted / steered / suppressed, including rows predating would_steer', () => {
  const rows = [
    // log_v 1 row: no would_steer field, but `continue` + enforce means the policy wanted to act.
    assessment({
      log_v: 1,
      shadow: true,
      decision: { action: 'continue', reason: 'x', rule: 'P1_unresolved_errors', enforce: true },
    }),
    // log_v 1 pass-through: the policy was content, so it is NOT a suppression.
    assessment({
      log_v: 1,
      shadow: true,
      decision: { action: 'finish', reason: 'x', rule: 'P9_default_pass', enforce: true },
    }),
    steerRow({ assessment_id: 'a3' }),
    assessment({
      assessment_id: 'a4',
      decision: {
        action: 'continue',
        reason: 'x',
        rule: 'P4_requirements_unmet',
        enforce: true,
        would_steer: true,
        will_steer: false,
        steer_suppressed: 'per_task_steer_budget',
      },
    }),
  ];
  const report = summarise(rows, { runtime });
  assert.equal(report.steer.wanted, 3, 'the pass-through row is not counted as wanting to act');
  assert.equal(report.steer.actual, 1);
  assert.equal(report.steer.suppressed, 2);
  assert.equal(report.steer.suppressionKinds.get('shadow_mode'), 1);
  assert.equal(report.steer.suppressionKinds.get('per_task_steer_budget'), 1);
});

test('summarise: latency covers successful calls only, so a timeout does not distort it', () => {
  const rows = [
    assessment({ latency_ms: { total: 100, jev: 100 } }),
    assessment({ assessment_id: 'a2', latency_ms: { total: 200, jev: 200 } }),
    // A failed call: its duration is the timeout setting, not the service's speed.
    assessment({
      assessment_id: 'a3',
      jev: null,
      jev_error: { kind: 'timeout', message: 'took too long' },
      latency_ms: { total: 5000, jev: null },
    }),
  ];
  const report = summarise(rows, { runtime });
  assert.equal(report.jev.successes, 2);
  assert.equal(report.jev.failures, 1);
  assert.equal(report.latency.samples, 2);
  assert.equal(report.latency.max, 200);
  assert.equal(report.latency.p50, 100);
});

test('summarise: reports the advisory and gray-zone fields, and names the P4 side', () => {
  const rows = [
    assessment({
      decision: {
        action: 'finish',
        reason: 'no threshold crossed',
        rule: 'P9_default_pass',
        enforce: true,
        advisory_rule: 'P6_evidence_mismatch',
        gray_zone: true,
        would_steer: false,
        will_steer: false,
        steer_suppressed: null,
      },
    }),
    steerRow({ assessment_id: 'a2' }),
  ];
  const report = summarise(rows, { runtime });
  assert.equal(report.steer.advisoryP6, 1);
  assert.equal(report.steer.grayZone, 1);
  assert.deepEqual([...report.steer.byRule.keys()], ['P4_requirements_unmet (requirements)']);
});

test('clampLimit: defaults, clamps, and survives nonsense', () => {
  assert.equal(clampLimit(undefined), DEFAULT_HEALTH_LIMIT);
  assert.equal(clampLimit(null), DEFAULT_HEALTH_LIMIT);
  assert.equal(clampLimit('abc'), DEFAULT_HEALTH_LIMIT);
  assert.equal(clampLimit(0), 1);
  assert.equal(clampLimit(-5), 1);
  assert.equal(clampLimit(9999), MAX_HEALTH_LIMIT);
  assert.equal(clampLimit('20'), 20);
});

// ── verdicts ────────────────────────────────────────────────────────────────

test('verdicts: a clean window is OK', () => {
  const report = summarise([assessment(), assessment({ assessment_id: 'a2' })], { runtime });
  assert.equal(report.health, 'OK');
  assert.deepEqual(report.checks, []);
});

test('verdicts: a stale build is a CHECK, and the newest logged row is named', () => {
  const report = summarise([assessment({ build_id: 'BUILD_OLD' })], { runtime });
  assert.equal(report.health, 'CHECK');
  assert.match(report.checks.join('\n'), /BUILD_CURRENT differs from the newest logged row \(BUILD_OLD\)/);
  assert.match(render(report), /Build: BUILD_CURRENT {2}\(newest logged row: BUILD_OLD\)/);
});

test('verdicts: a restart whose log predates the process is a note, not a CHECK', () => {
  // Regression, from the first live run of this check. The row below is NEWER than the build and
  // OLDER than the process — which is the normal shape right after a restart, because the old
  // process keeps writing rows after a new build lands and nothing restarts it when sources change.
  // The first version compared against the build's timestamp, so it raised a stale-code alarm
  // immediately after the very restart meant to clear it. The process's own start time is the only
  // sound separator: everything this process writes carries this build's id.
  const rows = [assessment({ build_id: 'BUILD_OLD', at: '2026-06-01T00:00:58.000Z' })];
  const awaiting = summarise(rows, {
    runtime: { buildId: 'BUILD_CURRENT', shadow: false, startedAt: '2026-06-01T00:01:38.000Z' },
  });
  assert.equal(awaiting.buildVerdict, 'awaiting_rows');
  assert.equal(awaiting.health, 'OK');
  assert.match(awaiting.notes.join('\n'), /no row has been written since this process started/);
  assert.match(render(awaiting), /^note: no row has been written since this process started/m);

  // A row written AFTER this process started that still names a different id: something else is
  // appending to this log, which is the fault actually worth reporting.
  const stale = summarise(rows, {
    runtime: { buildId: 'BUILD_CURRENT', shadow: false, startedAt: '2026-05-31T23:00:00.000Z' },
  });
  assert.equal(stale.buildVerdict, 'stale_process');
  assert.equal(stale.health, 'CHECK');
  assert.match(stale.checks.join('\n'), /written AFTER this process started/);

  // No usable start time at all: fail towards reporting, never towards silence.
  const unknown = summarise(rows, { runtime: { buildId: 'BUILD_CURRENT', shadow: false } });
  assert.equal(unknown.buildVerdict, 'stale_process');
});

test('verdicts: a mode change since the newest row is a CHECK', () => {
  const report = summarise([assessment({ shadow: true })], { runtime });
  assert.equal(report.health, 'CHECK');
  assert.match(report.checks.join('\n'), /newest logged row was written in SHADOW mode/);
});

test('verdicts: repeated steers on one task, and a steer past the budget, are each a CHECK', () => {
  const sameTask = summarise(
    [steerRow(), steerRow({ assessment_id: 'a2', at: '2026-01-01T00:05:00.000Z' })],
    { runtime },
  );
  assert.match(sameTask.checks.join('\n'), /steered more than once/);

  const overBudget = summarise([steerRow({ steers_used_before: 1, max_steers_per_task: 1 })], {
    runtime,
  });
  assert.match(overBudget.checks.join('\n'), /maxSteersPerTask was violated/);
});

test('verdicts: failures in the recent tail raise a CHECK; an old outage does not', () => {
  const failed = (id) =>
    assessment({ assessment_id: id, jev: null, jev_error: { kind: 'timeout', message: 'x' } });

  const recent = summarise(
    [assessment({ assessment_id: 'ok1' }), failed('f1'), failed('f2')],
    { runtime },
  );
  assert.equal(recent.health, 'CHECK');
  assert.match(recent.checks.join('\n'), /2 Jev failure\(s\) in the last 3 assessments/);

  // The same two failures, buried under 25 healthy rows: history, not a live problem.
  const buried = summarise(
    [failed('f1'), failed('f2'), ...Array.from({ length: 25 }, (_, i) => assessment({ assessment_id: `ok${i}` }))],
    { runtime },
  );
  assert.equal(buried.health, 'OK');
});

test('verdicts: unparsable lines and an unreadable log are each a CHECK', () => {
  const path = join(dir, 'broken.jsonl');
  writeFileSync(path, `${JSON.stringify(assessment())}\nnot json at all\n`, 'utf8');
  const report = buildReport({ path, runtime });
  assert.equal(report.parse.badLines, 1);
  assert.match(report.checks.join('\n'), /1 unparsable line\(s\)/);
});

test('verdicts: a missing log is a CHECK on a report that still renders', () => {
  const report = buildReport({ path: join(dir, 'nothing-here.jsonl'), runtime });
  assert.equal(report.health, 'CHECK');
  assert.match(report.checks.join('\n'), /no log file at/);
  const text = render(report);
  assert.match(text, /Health: CHECK/);
  assert.match(text, /Assessments: {10}0/);
});

// ── the contract that must not regress ──────────────────────────────────────

test('render: reports that a recent steer needs review, and never calls it a false positive', () => {
  const report = summarise([steerRow(), assessment({ assessment_id: 'a2' })], { runtime });
  const text = render(report);
  assert.match(text, /recent_steer_needs_review: true/);
  assert.match(text, /Most recent steer:/);
  assert.match(text, /goal: {2}"do a thing"/);
  // The whole point: deciding whether the steer was wrong needs the task's meaning, which is not
  // in the log. A command that guessed would be believed.
  assert.doesNotMatch(text, /false_positive/);
  assert.doesNotMatch(text, /false positive/i);
});

test('render: an empty window still renders every section header without throwing', () => {
  const text = render(buildReport({ path: join(dir, 'empty.jsonl'), limit: 50, runtime }));
  assert.match(text, /^Completion Supervisor Health\n/);
  assert.match(text, /Last 50 assessments/);
  assert.doesNotMatch(text, /Steers by reason:/, 'no steers means no steer section');
});

test('summary spans the whole result: mode, versions, Jev model, steer list', () => {
  const report = summarise([steerRow()], { limit: 1, runtime });
  const text = render(report);
  assert.match(text, /Mode: INTERVENTION/);
  assert.match(text, /Policy: v2/);
  assert.match(text, /Task state: v4/);
  assert.match(text, /Jev model: jev-1.13.0/);
  assert.match(text, /recent_steer_needs_review/);
  assert.match(text, /P4_requirements_unmet \(requirements\)/);
});
