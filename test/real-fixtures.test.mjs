/**
 * Regressions locked to REAL captured data.
 *
 * Every other test file builds its own inputs. This one does not: it reads
 * `test/fixtures/real-rows.json`, which holds rows and events copied verbatim out
 * of a live DSH run. The distinction matters because all three defects found so far
 * were shape mismatches that a hand-written fixture would have encoded wrongly — I
 * wrote the original fixture with `arguments` as an object precisely because I
 * assumed it was one, and the test then passed while the plugin was broken in
 * production.
 *
 * A fixture written by the code's author can only confirm the author's assumptions.
 * A fixture copied from the system can contradict them.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  assembleTaskState,
  deriveEvidence,
  detectUnverifiedClaims,
  exitCodeIsAttributable,
  isUserAuthored,
  parseExitCode,
  readToolArguments,
  summariseToolActivity,
  topLevelStatements,
} from '../lib/taskstate.js';
import { assessmentRow } from '../lib/log.js';
import { materialFacts, fingerprintState } from '../lib/fingerprint.js';
import { JEV_QUESTIONS, JEV_QUESTION_NAMES, QUESTION_SET_HASH, readProbability } from '../lib/questions.js';
import { parseJevResponse } from '../lib/jev.js';
import { createHash } from 'node:crypto';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = JSON.parse(readFileSync(join(HERE, 'fixtures', 'real-rows.json'), 'utf8'));

/** `classifyCommand` is not exported for this test's use; derive the kind by hand. */
function classifyCommandFor(command) {
  return /\bnpm\s+(run\s+)?test\b|\bvitest\b|\bjest\b/i.test(command) ? 'test' : 'other';
}

// ── the captured session events ──────────────────────────────────────────────

test('a REAL tool/call carries its arguments as a JSON string and is parsed', () => {
  const call = FIXTURE._session_events.tool_call;

  // The premise itself: this is the shape the real log has.
  assert.equal(
    typeof call.data.arguments,
    'string',
    'the fixture must record the real shape — a string, not an object',
  );

  const args = readToolArguments(call.data.arguments);
  assert.equal(args.command, 'npm test');
  assert.equal(args.timeoutMs, 120000);
});

test('a REAL failing-test turn produces tests_run=false under the OLD reader', () => {
  // The counterfactual, kept as an executable statement of the bug rather than a
  // comment: narrow the reader back to "objects only" and the contradiction the bug
  // created reappears. This is what the plugin did in production before the fix.
  const events = [
    FIXTURE._session_events.tool_call,
    FIXTURE._session_events.tool_result,
    {
      type: 'assistant/message',
      data: {
        turn: 1,
        step: 2,
        message: { content: [{ type: 'text', text: 'All tests pass.' }] },
      },
    },
  ];

  const oldReader = (event) => {
    const data = event?.data;
    if (data === null || typeof data !== 'object') return null;
    return {
      callId: typeof data.callId === 'string' ? data.callId : '',
      name: typeof data.name === 'string' ? data.name : '',
      // The original line, verbatim.
      args: data.arguments !== null && typeof data.arguments === 'object' ? data.arguments : {},
      turn: typeof data.turn === 'number' ? data.turn : null,
    };
  };

  // Reproduce the old derivation by hand: same event stream, old reader.
  const call = oldReader(events[0]);
  assert.deepEqual(call.args, {}, 'the old reader saw no arguments at all');
  const cmd = typeof call.args.command === 'string' ? call.args.command : '';
  assert.equal(cmd, '', 'so no command was visible');
  const evidence = { tests_run: false, tests_passed: null, build_ok: null, lint_ok: null };

  // With tests invisible, an honest claim of passing tests is flagged as a
  // contradiction. THAT is the harm: a fabricated accusation against a turn that
  // really ran the tests.
  const claims = detectUnverifiedClaims('All tests pass.', evidence);
  assert.ok(claims.length > 0, 'the old reader manufactured a contradiction');

  // The fixed derivation on the same three events sees the command and the
  // failure, and levels no accusation at all.
  const derived = deriveEvidence(events, 1);
  assert.equal(derived.commands.length, 1);
  assert.equal(derived.commands[0].cmd, 'npm test');
  assert.equal(derived.commands[0].kind, 'test');
  assert.equal(derived.commands[0].exit, 1);
  assert.equal(derived.evidence.tests_run, true);
  assert.equal(derived.evidence.tests_passed, false);
  // The claim itself is still flagged, because the recorded run DID fail — the
  // plugin is not suppressing a real contradiction, it is reporting the right one.
  // The old reader reported a different, fabricated one.
  assert.deepEqual(detectUnverifiedClaims(derived.claim, derived.evidence), [
    'claims "tests pass" but the recorded test run did not pass',
  ]);
});

test('the REAL recorded verdicts replay to the recorded decision', () => {
  const row = FIXTURE._rows[0].row;
  assert.equal(row.facts.tests_run, true);
  assert.equal(row.facts.tests_passed, false);
  // The log says the policy concluded `continue` under P3, and the facts it
  // recorded are sufficient to reach that conclusion. If the facts ever stop
  // supporting the decision, this fails — which is the auditability the log exists
  // to provide.
  assert.equal(row.decision.rule, 'P3_failing_tests');
  assert.equal(row.decision.action, 'continue');
  assert.equal(row.decision.applied, false, 'shadow must never apply');
});

// ── the exit-code caveat, as a test rather than a comment ────────────────────

test('the exit marker is trusted only as zero versus non-zero', () => {
  const measured = FIXTURE._exit_code_measurement.observations;
  const seven = measured.find((o) => o.real_child_exit === 7);
  assert.ok(seven, 'the fixture must record the 7-is-reported-as-1 measurement');

  // The plugin reads whatever the marker says; it does NOT invent the child code.
  // The marker in the fixture is stored as its own line, exactly as DSH appends it.
  assert.equal(parseExitCode(`\n${seven.dsh_marker}`), 1);
  // So the honest contract is: 0 means success, non-zero means failure, and the
  // exact non-zero value is not the child's.
  assert.equal(parseExitCode('\n[exit code: 0]'), 0);
  assert.notEqual(parseExitCode(`\n${seven.dsh_marker}`), 0);
  // A signal kill stays distinguishable from a numeric failure.
  assert.equal(parseExitCode('\n[killed by signal: SIGKILL]'), null);
  // Success carries NO marker at all, so "absent" must mean 0 rather than "unknown".
  const ok = measured.find((o) => o.real_child_exit === 0);
  assert.equal(ok.dsh_marker, '(absent)');
  assert.equal(parseExitCode('npm 11.16.0'), 0);
});

test('a LONG failing run is still recorded as failing (marker lives at the tail)', () => {
  // REGRESSION from the fixture's `_truncation_measurement`.
  //
  // DSH appends `[exit code: N]` as the FINAL line of a shell result. A
  // prefix-preserving read therefore drops it as soon as the output is longer than
  // the cap — and a failing test suite is exactly the case that produces long
  // output. Measured on a realistic 31k-char run: the head read ended mid-assertion,
  // `parseExitCode` fell back to its "no marker means 0" default, and a FAILING
  // suite was recorded as passing.
  const noise = Array.from({ length: 900 }, (_, i) => `not ok ${i} - some assertion failed`).join('\n');
  const limit = FIXTURE._truncation_measurement.observation;
  assert.match(String(limit.head_read_at_4000_chars), /marker absent/);

  const events = [
    {
      type: 'tool/call',
      data: { turn: 1, step: 1, callId: 'c1', name: 'pwsh', arguments: '{"command":"npm test"}' },
    },
    {
      type: 'tool/result',
      data: {
        turn: 1,
        step: 1,
        message: {
          content: [
            {
              type: 'tool-result',
              toolCallId: 'c1',
              content: [{ type: 'text', text: `${noise}\n[exit code: 1]` }],
              isError: false,
            },
          ],
        },
      },
    },
  ];

  const derived = deriveEvidence(events, 1);
  assert.equal(derived.commands.length, 1, 'the command must still be visible');
  assert.equal(derived.commands[0].exit, 1, 'the failure marker must survive truncation');
  assert.equal(derived.evidence.tests_run, true);
  assert.equal(derived.evidence.tests_passed, false, 'a failing suite must never read as passing');
});

test('a long PASSING run is not falsely accused', () => {
  // The mirror image: with no marker at all the verdict is success, and an honest
  // claim must not be flagged.
  const noise = Array.from({ length: 900 }, (_, i) => `ok ${i} - passed`).join('\n');
  const events = [
    {
      type: 'tool/call',
      data: { turn: 1, step: 1, callId: 'c1', name: 'pwsh', arguments: '{"command":"npm test"}' },
    },
    {
      type: 'tool/result',
      data: {
        turn: 1,
        step: 1,
        message: {
          content: [
            {
              type: 'tool-result',
              toolCallId: 'c1',
              content: [{ type: 'text', text: noise }],
              isError: false,
            },
          ],
        },
      },
    },
    {
      type: 'assistant/message',
      data: { turn: 1, step: 2, message: { content: [{ type: 'text', text: 'All tests pass.' }] } },
    },
  ];
  const derived = deriveEvidence(events, 1);
  assert.equal(derived.commands[0].exit, 0);
  assert.equal(derived.evidence.tests_passed, true);
  assert.deepEqual(detectUnverifiedClaims(derived.claim, derived.evidence), []);
});

// ── repo availability, locked to a real row ──────────────────────────────────

test('a REAL row records repo availability beside its (empty) file counts', () => {
  const row = FIXTURE._rows[0].row;
  // The captured row predates the `repo_available` fact field, which is itself the
  // evidence that the field was missing: its `changed_fields` mentions
  // repo_available (so the fingerprints differed) while `facts` has no such key.
  assert.ok(
    row.changed_fields.includes('repo_available'),
    'the fingerprint already treated availability as material',
  );

  // Rebuilding the same facts through the current writer must now include it.
  const state = {
    repo: { changed_files: [], untracked: [], insertions: null, deletions: null, available: false },
    commands: [],
    evidence: {
      tests_run: true,
      tests_passed: false,
      build_ok: null,
      lint_ok: null,
      error_results: [],
      unverified_claims: [],
    },
    activity: { tool_calls_this_turn: 7, tools_used: ['pwsh'] },
  };
  const written = assessmentRow({
    assessmentId: 'x',
    sessionId: 's',
    turn: 1,
    cwd: 'C:\\tmp',
    shadow: true,
    trigger: 'turn-stopping',
    fingerprint: 'deadbeef',
    fingerprintVersion: 1,
    changedFields: [],
    state,
    stateTokens: 1,
    stateStage: 'full',
    decision: { action: 'continue', reason: 'r', rule: 'P3_failing_tests', policy_v: 1 },
    jev: null,
    jevError: null,
    latency: { total: 0, jev: null },
    costUsd: 0,
    promptVersion: 1,
    taskStateVersion: 1,
    taskKey: 's#task1',
    assessmentsUsedBefore: 0,
    maxAssessments: 3,
  });

  assert.equal(written.facts.repo_available, false);
  assert.equal(written.facts.changed_files_n, 0);
  // The two together are the point: an empty file list AND a known-blind repository
  // is unambiguous, whereas the count alone was not.
  assert.equal(written.commands.length, 0);
  assert.equal(materialFacts(state).repo_available, false);
  assert.notEqual(
    fingerprintState(state).fingerprint,
    fingerprintState({ ...state, repo: { ...state.repo, available: true } }).fingerprint,
  );

  // The task attribution must reach the row, or the per-task budget is unverifiable
  // offline: `<N> assessments` cannot distinguish one capped task from N reset ones.
  assert.equal(written.task_key, 's#task1');
  assert.equal(written.assessments_used_before, 0);
  assert.equal(written.max_assessments, 3);
});

test('the log records what was asked — the goal and the claim — so a fabricated goal is visible', () => {
  // WHY THIS MATTERS MORE THAN IT LOOKS: the single worst defect found so far was
  // that `goal` could be extracted from a synthetic user-role message, so Jev could
  // be asked whether a SYSTEM REMINDER had been completed. Nothing in any log row
  // would have revealed that, because neither the goal nor the claim was recorded —
  // `facts` holds only counts. A judgement about text must log the text.
  const state = {
    goal: '  Fix the failing\n  test suite.  ',
    claim: 'Done. All tests pass.',
    repo: { changed_files: [], untracked: [], insertions: null, deletions: null, available: true },
    evidence: {
      tests_run: false,
      tests_passed: null,
      build_ok: null,
      lint_ok: null,
      error_results: [],
      unverified_claims: [],
    },
    activity: { tool_calls_this_turn: 1, tools_used: ['pwsh'] },
  };
  const base = {
    assessmentId: 'x',
    sessionId: 's',
    turn: 1,
    cwd: 'C:\\tmp',
    shadow: true,
    trigger: 'turn-stopping',
    fingerprint: 'deadbeef',
    fingerprintVersion: 1,
    changedFields: [],
    stateTokens: 1,
    stateStage: 'full',
    decision: { action: 'pass', reason: 'r', rule: 'P0_no_jev', policy_v: 1 },
    jev: null,
    jevError: null,
    latency: { total: 0, jev: null },
    costUsd: 0,
    promptVersion: 1,
    taskStateVersion: 1,
  };

  const written = assessmentRow({ ...base, state });
  // Whitespace is collapsed, so the row stays one readable line.
  assert.equal(written.asked.goal, 'Fix the failing test suite.');
  assert.equal(written.asked.claim, 'Done. All tests pass.');

  // Bounded, so a huge claim cannot bloat the row it is supposed to make auditable.
  //
  // The bound is 800 and it reads from the TAIL, because that is the form Jev actually
  // receives: the compression stages keep the end of a claim, so a head read here would
  // record a fragment Jev was never shown. That is not a cosmetic difference — it is the
  // whole value of the field, and getting it wrong is how the reasoning-in-claim defect
  // stayed invisible in the log that was supposed to expose it.
  const huge = assessmentRow({ ...base, state: { ...state, claim: `START${'x'.repeat(5000)}END` } });
  assert.equal(huge.asked.claim.length, 801, '800 chars plus the leading ellipsis');
  assert.ok(huge.asked.claim.startsWith('…'), 'a truncated claim must be marked at the front');
  assert.ok(huge.asked.claim.endsWith('END'), 'the conclusion lives at the end and must survive');

  // A turn with no goal or claim records nulls rather than empty strings, so a
  // reader can tell "nothing was asked" from "asked about nothing".
  assert.equal(assessmentRow({ ...base, state: { ...state, goal: '', claim: '   ' } }).asked.goal, null);
  assert.equal(assessmentRow({ ...base, state: null }).asked, null);
});

// ── the exit code does not always belong to the command ──────────────────────

test('a WRAPPED failing test run is not recorded as passing — the second fabricated pass', () => {
  // THE BUG THIS LOCKS OUT: on the first real-Jev round a subagent ran the deliberately
  // failing suite through `$out = npm test 2>&1; …; Write-Output …`. The shell host
  // reports the LAST statement's code, so DSH wrote `[exit code: 0]` — well, it wrote no
  // marker at all, which means 0 — and a suite that really failed was recorded as
  // `tests_passed: true`.
  //
  // The claim was honest; the EVIDENCE was wrong. That is the worse of the two failure
  // directions for this plugin to have, because everything downstream trusts the facts.
  //
  // The commands below are copied VERBATIM from the two live sessions; the true outcome
  // was established by running each one.
  const WRAPPED = [
    // case C, session ebc5ed01 — genuinely failed, host reported 0
    '$out = npm test 2>&1; $code = $LASTEXITCODE; Write-Output "===LAST3==="; $out | Select-Object -Last 3; Write-Output "===EXITCODE===$code"',
    "$out = npm test 2>&1 | Out-String; $tmp = Join-Path $env:TEMP 'x.txt'; $out | Set-Content -Path $tmp; Write-Output 'done'",
    'npm test; Write-Output "after"',
    'npm test > $null 2>&1; Write-Output "after"',
  ];
  for (const command of WRAPPED) {
    assert.equal(
      exitCodeIsAttributable(command, 'test'),
      false,
      `a wrapped command must not have its host code attributed to it: ${command.slice(0, 60)}`,
    );
  }

  // And the shapes that ARE faithful, measured the same way. These must keep voting, or
  // the fix would trade a false pass for a permanent "unknown".
  const FAITHFUL = [
    'npm test',
    'npm test 2>&1 | Select-Object -Last 6',
    'cd "some dir"; npm test',
    'npm test; exit $LASTEXITCODE',
    'node tools/build-id.mjs --check',
  ];
  for (const command of FAITHFUL) {
    assert.equal(
      exitCodeIsAttributable(command, classifyCommandFor(command)),
      true,
      `a faithful command must keep its exit code: ${command}`,
    );
  }
});

test('a wrapped test run yields tests_passed UNKNOWN, never true', () => {
  // The end-to-end consequence, through the real derivation path. A wrapped run must not
  // resolve to a pass, and must not resolve to a failure either — "we could not read the
  // result" is the honest answer, and `null` already means exactly that in this schema.
  //
  // The event shapes below are CLONED FROM THE REAL FIXTURE rather than invented. My
  // first version of this test hand-wrote `{callId}` on the result block, but the real
  // field is `toolCallId` — so deriveEvidence found no matching call and silently
  // recorded nothing at all. A hand-written shape tests the author's assumption; this
  // one tests the system's actual contract.
  const call = (callId, command) => ({
    type: 'tool/call',
    data: { turn: 1, step: 1, callId, name: 'pwsh', arguments: JSON.stringify({ command }) },
  });
  const textBlock = (text) => ({ type: 'text', text });
  const result = (callId, text) => ({
    type: 'tool/result',
    data: {
      turn: 1,
      step: 1,
      message: {
        source: { kind: 'tool', callId },
        content: [{ type: 'tool-result', toolCallId: callId, content: [textBlock(text)], isError: false }],
        role: 'user',
      },
    },
  });

  // A wrapped run: no marker at all, because the host reported the WRAPPER's clean exit.
  const derived = deriveEvidence(
    [
      call('w1', '$out = npm test 2>&1; $code = $LASTEXITCODE; Write-Output "done"'),
      result('w1', '===LAST3===\n  }\n===EXITCODE===1'),
    ],
    1,
  );
  assert.equal(derived.evidence.tests_run, true, 'the test command is still recorded');
  assert.equal(
    derived.evidence.tests_passed,
    null,
    'a wrapped run must be UNKNOWN — not true (a fabricated pass), not false (a fabricated failure)',
  );
  assert.equal(derived.commands[0].exit_attributable, false);
  // The raw host code stays visible so a reader can see what happened rather than
  // wondering why the verdict is unknown.
  assert.equal(derived.commands[0].exit, 0);

  // The same command WITHOUT the wrapper is a definite failure. The marker sits where
  // DSH really puts it: the last line, preceded by a newline.
  const plain = deriveEvidence(
    [call('p1', 'npm test'), result('p1', 'boom\n[exit code: 1]')],
    1,
  );
  assert.equal(plain.evidence.tests_passed, false, 'an unwrapped failure must still be definite');
  assert.equal(plain.commands[0].exit_attributable, true);

  // And an unwrapped PASS is still a definite pass, or the fix would have traded a
  // false pass for a permanent "unknown".
  const passing = deriveEvidence(
    [call('p2', 'npm test'), result('p2', 'ℹ pass 101\nℹ fail 0')],
    1,
  );
  assert.equal(passing.evidence.tests_passed, true, 'a clean unwrapped run is still a definite pass');
});

test('the statement splitter respects quotes, brackets and line continuations', () => {
  // The splitter decides where one statement ends, so a mistake here silently
  // mis-attributes exit codes — the failure mode is invisible in the log.
  assert.deepEqual(topLevelStatements('npm test'), ['npm test']);
  assert.deepEqual(topLevelStatements('a; b; c'), ['a', 'b', 'c']);
  // A semicolon inside a string is not a separator.
  assert.deepEqual(topLevelStatements('Write-Output "a; b"'), ['Write-Output "a; b"']);
  assert.deepEqual(topLevelStatements("Write-Output 'a; b'"), ["Write-Output 'a; b'"]);
  // Backtick escapes a quote inside double quotes.
  assert.deepEqual(topLevelStatements('Write-Output "say `"; now"'), ['Write-Output "say `"; now"']);
  // Doubled quotes inside single quotes are an escaped quote, not a terminator.
  assert.deepEqual(topLevelStatements("Write-Output 'it''s; fine'"), ["Write-Output 'it''s; fine'"]);
  // A semicolon inside a subexpression or script block does not split the container.
  assert.deepEqual(topLevelStatements('$x = $(a; b)'), ['$x = $(a; b)']);
  assert.deepEqual(topLevelStatements('if ($x) { a; b }'), ['if ($x) { a; b }']);
  // Newlines separate, unless the line continues.
  assert.deepEqual(topLevelStatements('a\nb'), ['a', 'b']);
  assert.deepEqual(topLevelStatements('a |\nb'), ['a | b']);
  assert.deepEqual(topLevelStatements(''), []);
});



test('the material/message split classifies the tools this machine actually uses', () => {
  const observed = summariseToolActivity(['pwsh', 'write', 'read', 'send_message']);
  assert.equal(observed.total, 4);
  assert.equal(observed.material, 3);
  assert.equal(observed.message_only, 1);
  assert.deepEqual(observed.material_names, ['pwsh', 'read', 'write']);

  // An unknown tool must count as material. A deny-list errs toward assessing a
  // turn, which is the status quo; an allow-list would err toward silently skipping
  // one, and a skipped assessment leaves no trace in the log.
  assert.equal(summariseToolActivity(['some_future_browser_tool']).material, 1);
  assert.equal(summariseToolActivity(['ask_user_question']).material, 0);
});

// ── who counts as the user, on the measured source distribution ──────────────

test('only a REAL user message is the human, out of the sources a session actually contains', () => {
  const measured = FIXTURE._user_message_source_measurement;

  // The premise: the fixture records that non-human sources OUTNUMBER the human.
  // If this ever stops being true, the allow-list below is no longer load-bearing
  // and this test should be reconsidered rather than silently kept.
  const counts = measured._counts_by_source;
  const humanMessages = counts.user;
  const syntheticMessages = Object.entries(counts)
    .filter(([key]) => key !== 'user')
    .reduce((sum, [, n]) => sum + n, 0);
  assert.ok(
    syntheticMessages > humanMessages,
    'the fixture must be a session where synthetic user-role messages dominate',
  );

  // Every kind the session actually contained, mapped through the real predicate.
  for (const [key, count] of Object.entries(counts)) {
    const kind = key.includes('(') ? 'plugin' : key;
    assert.ok(count > 0, `${key} should have been observed`);
    if (key === 'user') {
      assert.equal(isUserAuthored({ kind: 'user' }), true, `${key} IS the human`);
    } else {
      assert.equal(
        isUserAuthored({ kind }),
        false,
        `${key} arrives in a user-role envelope but is NOT the human`,
      );
    }
  }

  // The verbatim source object from the real log.
  assert.equal(isUserAuthored(measured._real_user_source_verbatim), true);
  // A message from the human via the RPC path maps to the same kind.
  assert.equal(isUserAuthored({ kind: 'user', rpcId: 'x' }), true);
  // Malformed input must not be mistaken for a task boundary.
  assert.equal(isUserAuthored(undefined), false);
  assert.equal(isUserAuthored(null), false);
  assert.equal(isUserAuthored({}), false);
});

test('the OLD deny-list accepted synthetic sources as the human — the counterfactual', () => {
  const counts = FIXTURE._user_message_source_measurement._counts_by_source;

  // Reconstruct the shipped-and-wrong predicate: exclude `plugin` and `tool`,
  // accept everything else.
  const oldIsUserAuthored = (source) =>
    source?.kind !== 'plugin' && source?.kind !== 'tool';

  // List every source the real session contained that the old rule got WRONG.
  const wronglyAccepted = [];
  for (const key of Object.keys(counts)) {
    const kind = key.includes('(') ? 'plugin' : key;
    if (oldIsUserAuthored({ kind }) && kind !== 'user') wronglyAccepted.push(key);
  }

  // This is the bug, stated executably. `subagent-settled` alone fired 13 times in
  // one session; each one reset the per-task budget.
  assert.ok(wronglyAccepted.length > 0, 'the old rule really did accept synthetic sources');
  assert.ok(
    wronglyAccepted.some((key) => key.startsWith('subagent-settled')),
    'a child agent finishing must be among the false positives',
  );
  assert.equal(
    oldIsUserAuthored({ kind: 'subagent-settled' }),
    true,
    'the old rule counted a subagent settling as a new user task',
  );

  // And the volume, so the severity is visible in the test rather than asserted.
  const falseResets = wronglyAccepted.reduce((sum, key) => sum + counts[key], 0);
  assert.ok(
    falseResets > 10,
    `the old rule would have reset the budget ${falseResets} times in one session`,
  );
});

test('a synthetic user-role message is neither the goal nor a task boundary', () => {
  const measured = FIXTURE._user_message_source_measurement;
  const ordered = measured._first_six_user_role_messages_in_order;

  // The measurement that motivated the goal fix: the human's message is first, and
  // an `agent-instructions` block is second. Under the old deny-list the second one
  // was an eligible goal.
  assert.equal(ordered[0].kind, 'user');
  assert.equal(ordered[1].kind, 'agent-instructions');

  const events = [
    { type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: ordered[0].text_preview }], source: measured._real_user_source_verbatim } },
    { type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: ordered[1].text_preview }], source: { kind: 'agent-instructions' } } },
  ];

  // A reordered stream where the synthetic message comes FIRST, which is the case
  // the old rule got wrong.
  const reordered = [
    { type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: ordered[1].text_preview }], source: { kind: 'agent-instructions' } } },
  ];

  // Build the state twice: once with the real allow-list, once with the old rule
  // applied to the SAME events, so the comparison isolates the predicate.
  const withAllowList = deriveEvidence(events, null);
  assert.equal(
    withAllowList.goal,
    ordered[0].text_preview,
    'the goal must be the human message, and the goal must exist',
  );
  assert.ok(
    !withAllowList.goal.includes('system-reminder'),
    'the goal must never be a system reminder',
  );

  // The old rule, applied by hand to the same input, would have accepted the
  // second message had the human's not been first. Reconstruct the extraction
  // itself — feeding filtered events to the FIXED reader would prove nothing,
  // because the fix lives inside the reader.
  const oldGoalFrom = (eventList) => {
    let goal = '';
    for (const event of eventList) {
      if (event?.type !== 'user/message') continue;
      const source = event.data?.source;
      // The original two lines, verbatim.
      if (source?.kind === 'plugin') continue;
      if (source?.kind === 'tool') continue;
      const text = (event.data?.content ?? [])
        .filter((b) => b?.type === 'text')
        .map((b) => b.text)
        .join('\n');
      if (text.trim().length > 0 && goal.length === 0) goal = text;
    }
    return goal;
  };

  const oldGoal = oldGoalFrom(reordered);
  assert.ok(
    oldGoal.includes('system-reminder'),
    'the old rule really would have handed Jev a system reminder as the user goal',
  );

  // And against the REAL two-message sequence the old rule and the new one agree
  // only because the human happened to speak first — which is the fragility.
  assert.equal(oldGoalFrom(events), ordered[0].text_preview);

  // The fixed reader on the same reordered input picks nothing at all.
  assert.equal(deriveEvidence(reordered, null).goal, '');
});

// ── the claim must be the reply, not the thinking ────────────────────────────

/**
 * A real assistant message, in the shape a live session log actually has.
 *
 * Measured with `node tools/decode-session.mjs --match <id> --blocks` on a 160-line
 * session: `[reasoning, text, tool-call]` appeared 11 times, `[reasoning, tool-call]` 5
 * times, `[reasoning, text]` 3 times. So the most common shape carries a reasoning block,
 * and BOTH `reasoning` and `text` have a `.text` string.
 */
function assistantMessage({ reasoning = null, text = null, toolCalls = 0, turn = 1, step = 1 }) {
  const content = [];
  if (reasoning !== null) content.push({ type: 'reasoning', text: reasoning });
  if (text !== null) content.push({ type: 'text', text });
  for (let index = 0; index < toolCalls; index += 1) {
    content.push({ type: 'tool-call', id: `call-${index}`, name: 'pwsh', arguments: '{}' });
  }
  return { type: 'assistant/message', data: { turn, step, message: { content } } };
}

test('a reasoning block is NOT part of the completion claim', () => {
  // The defect this locks out: every block with a `.text` was concatenated, so the claim
  // Jev received was the model's private deliberation followed by its reply — and on a
  // 4000-character head read the deliberation filled the budget and the reply was cut off
  // entirely. That is why `evidence_matches_claim` sat at 0.10-0.34 on every real
  // assessment: Jev was judging whether a DRAFT was supported by the evidence.
  const events = [
    assistantMessage({
      reasoning: 'Let me think about which browser to download. AdsPower is well known but the free tier is limited.',
      text: 'Done: the installer is at C:\\Users\\me\\Downloads\\AdsPower.exe and the signature is valid.',
      toolCalls: 1,
    }),
  ];

  const derived = deriveEvidence(events, 1);
  assert.match(derived.claim, /installer is at/);
  assert.ok(
    !derived.claim.includes('Let me think'),
    'the model\'s private reasoning must never be presented as the completion claim',
  );
});

test('the OLD reader put the reasoning into the claim — the counterfactual', () => {
  // Kept as an executable statement of the bug rather than a comment, so the fix cannot be
  // quietly reverted: concatenate every block that has a `.text`, exactly as before.
  const content = [
    { type: 'reasoning', text: 'Let me think about which browser to download.' },
    { type: 'text', text: 'Done: the installer is downloaded.' },
  ];
  const oldClaim = content
    .filter((block) => typeof block?.text === 'string')
    .map((block) => block.text)
    .join('\n');

  assert.ok(oldClaim.includes('Let me think'), 'the old rule really did include reasoning');
  assert.equal(deriveEvidence([assistantMessage({ reasoning: content[0].text, text: content[1].text })], 1).claim,
    'Done: the installer is downloaded.');
});

test('a reasoning-only message does not overwrite the claim', () => {
  // A mid-turn step that only thinks and calls a tool is not a completion statement. If it
  // overwrote the claim, the last tool call of a turn would decide what Jev was asked about.
  const events = [
    assistantMessage({ text: 'Running the test suite now.', step: 1 }),
    assistantMessage({
      reasoning: 'That failed. Let me reconsider the whole approach and try something else.',
      toolCalls: 1,
      step: 2,
    }),
  ];

  const derived = deriveEvidence(events, 1);
  assert.equal(derived.claim, 'Running the test suite now.');
});

test('reasoning about tests does not fabricate an unverified claim', () => {
  // A second-order effect of the same defect, and the more dangerous half: the unverified
  // claim detector runs REGEXES over the claim. A model thinking "I should check whether the
  // tests pass before I say so" was matched as a claim that tests passed, with no test
  // command recorded — producing a fabricated accusation against an honest turn, which the
  // policy can then block on. Measured against the real wording the detector looks for.
  const events = [
    assistantMessage({
      reasoning: 'I should verify the tests pass before I claim anything. There are no tests here though.',
      text: 'The file is written. No test suite exists in this directory, so nothing was run.',
    }),
  ];

  const derived = deriveEvidence(events, 1);
  assert.equal(derived.evidence.tests_run, false);
  assert.deepEqual(
    derived.evidence.unverified_claims,
    [],
    'thinking about tests must not read as claiming tests passed',
  );

  // And the counterfactual: with the reasoning included, the detector does fire.
  const withReasoning = 'I should verify the tests pass before I claim anything.\nThe file is written.';
  assert.ok(
    detectUnverifiedClaims(withReasoning, derived.evidence).length > 0,
    'the old claim text really did trip the detector, or this test proves nothing',
  );
});

// ── artifacts: the evidence a non-git directory was throwing away ─────────────

/** A `write` call + result in the shape the session log actually stores. */
function writePair({ callId = 'w1', filePath, turn = 1, isError = false, text = 'File created successfully.' }) {
  return [
    {
      type: 'tool/call',
      data: { turn, step: 1, callId, name: 'write', arguments: JSON.stringify({ content: 'three lines\n', file_path: filePath }) },
    },
    {
      type: 'tool/result',
      data: {
        turn,
        step: 1,
        message: {
          role: 'tool',
          id: 'm1',
          source: { kind: 'tool', callId },
          // Real shape: `arguments` parsed only on the execution path, and the result body is
          // `content[0].content[0].text` — verified against a live session log.
          content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text }], isError }],
        },
      },
    },
  ];
}

test('a turn that wrote a file now carries that path, even with no git repository', () => {
  // THE GAP THIS CLOSES. `repo.changed_files` was the only channel for "what did this turn
  // produce", and on this machine the working directory is not a git repository, so it was
  // always empty. A turn that created a file therefore reached Jev with no evidence of it, and
  // Jev's `requirements_satisfied` came back at 0.26-0.48 across every real turn — low enough
  // to trip the P4 block rule on turns that were complete.
  const WS = 'C:\\Users\\me\\Desktop\\git cloud\\dsh-completion-supervisor';
  const events = [
    ...writePair({ filePath: `${WS}\\scratch\\note.md` }),
    { type: 'assistant/message', data: { turn: 1, step: 2, message: { content: [{ type: 'text', text: 'Created `scratch/note.md`.' }] } } },
  ];

  const derived = deriveEvidence(events, 1, { cwd: WS });
  assert.deepEqual(derived.artifacts.created_or_written_paths, ['scratch\\note.md']);
  assert.deepEqual(derived.artifacts.verified_artifacts, [{ path: 'scratch\\note.md', tool: 'write', ok: true }]);

  // And it survives into the state Jev receives, beside the (empty) repository facts — which
  // is the whole point: `changed_files: []` plus `available: false` must no longer be the only
  // thing Jev can see about what the turn did.
  const state = assembleTaskState({
    sessionId: 's1',
    turn: 1,
    cwd: WS,
    derived,
    git: { available: false, changed_files: [], untracked: [], insertions: null, deletions: null },
    prior: null,
    at: '2026-01-01T00:00:00.000Z',
  });

  assert.equal(state.repo.available, false);
  assert.deepEqual(state.repo.changed_files, []);
  assert.deepEqual(state.activity.created_or_written_paths, ['scratch\\note.md']);
  assert.equal(state.task_v, 4, 'the state shape changed, so the version must say so');
});

test('the OLD state carried no artifact evidence at all — the counterfactual', () => {
  // The v2 behaviour, reconstructed: artifacts were not part of `activity`, so this is what Jev
  // saw for a turn that created a file in a non-repository directory. Nothing about the file
  // appears anywhere in the state.
  const WS = 'C:\\Users\\me\\Desktop\\git cloud\\dsh-completion-supervisor';
  const derived = deriveEvidence(
    [...writePair({ filePath: `${WS}\\scratch\\note.md` }), { type: 'assistant/message', data: { turn: 1, step: 2, message: { content: [{ type: 'text', text: 'Created `scratch/note.md`.' }] } } }],
    1,
    { cwd: WS },
  );

  const v2Activity = { tool_calls_this_turn: derived.activity.tool_calls_this_turn, tools_used: derived.activity.tools_used };
  const serialised = JSON.stringify(v2Activity);
  assert.ok(
    !serialised.includes('note.md'),
    'the old activity object really did carry no path, or this test proves nothing',
  );
  assert.ok(
    JSON.stringify(derived.activity).includes('note.md'),
    'and the new one does',
  );
});

test('a FAILED write is reported as an action but not as a delivered artifact', () => {
  const WS = 'C:\\Users\\me\\Desktop\\git cloud\\dsh-completion-supervisor';
  const derived = deriveEvidence(
    writePair({ filePath: `${WS}\\nope.md`, isError: true, text: 'EACCES: permission denied' }),
    1,
    { cwd: WS },
  );

  assert.deepEqual(derived.artifacts.created_or_written_paths, ['nope.md'], 'the attempt is visible');
  assert.deepEqual(derived.artifacts.verified_artifacts, [], 'the delivery is not claimed');
});

test('a shell command contributes no artifact, however suggestive its text', () => {
  // The exclusion, asserted against the real argument shape of a `pwsh` call: on this machine
  // 545 of them carried only command/description/workdir/timeoutMs/run_in_background, and all
  // 1375 tool results were prose, so there is nothing structured to read.
  const WS = 'C:\\Users\\me\\Desktop\\git cloud\\dsh-completion-supervisor';
  const command = 'Invoke-WebRequest -Uri https://version.adspower.net/x.exe -OutFile C:\\Users\\me\\Downloads\\AdsPower.exe';
  const events = [
    { type: 'tool/call', data: { turn: 1, step: 1, callId: 'c1', name: 'pwsh', arguments: JSON.stringify({ command, workdir: WS }) } },
    {
      type: 'tool/result',
      data: {
        turn: 1,
        step: 1,
        message: {
          role: 'tool',
          id: 'm1',
          source: { kind: 'tool', callId: 'c1' },
          content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: '下载完成，路径: C:\\Users\\me\\Downloads\\AdsPower.exe' }], isError: false }],
        },
      },
    },
  ];

  const derived = deriveEvidence(events, 1, { cwd: WS });
  assert.deepEqual(derived.artifacts.created_or_written_paths, [], 'a path must come from a schema, not from prose');
  assert.deepEqual(derived.artifacts.verified_artifacts, []);
  assert.equal(derived.commands.length, 1, 'the command itself is still recorded');
});

// ── the v2 question set must not presuppose a code task ──────────────────────

test('no question presupposes a code change — the v1 defect, locked out as an assertion', () => {
  // WHY THIS TEST EXISTS. v1 asked whether "the repository state" met the request. On 22 real
  // assessments — every one of them a task that touched no repository — that question scored a
  // median of 0.26, and the P4 block rule (`req < 0.40`) fired on turns that were complete. The
  // low score was a correct answer to a question about something that did not exist, and it looked
  // exactly like a calibration problem, which is why the instinct was to move a threshold.
  //
  // So the wording is asserted directly. If someone reintroduces a repository-shaped question, this
  // fails rather than quietly restoring the defect.
  const all = JEV_QUESTION_NAMES.map((name) => JEV_QUESTIONS[name].instructions).join(' ');
  for (const forbidden of ['repository state', 'recorded commands and file changes', 'test coverage']) {
    assert.ok(
      !all.toLowerCase().includes(forbidden),
      `"${forbidden}" would make a question unanswerable for a task that touches no code`,
    );
  }

  // And the verification question has to SAY that a lack of tests is not a defect elsewhere,
  // because that is the whole point of the rewrite rather than an incidental nicety.
  const verification = JEV_QUESTIONS.verification_sufficient.instructions;
  assert.match(verification, /no tests/i);
  assert.match(verification, /download|generated file/);
});

test('the v1 wording really did presuppose a repository — the counterfactual', () => {
  // Kept as an executable statement of what changed. Without it, the assertion above could be read
  // as tidiness rather than as a fix for a measured defect.
  const V1_REQUIREMENTS =
    "The repository state actually satisfies the user's original request as a whole — " +
    'not merely the part the assistant chose to describe in its summary.';
  const V1_TESTS =
    'The work has adequate test coverage for what was changed, AND those tests were ' +
    'actually executed with passing results visible in the recorded commands.';

  for (const text of [V1_REQUIREMENTS, V1_TESTS]) {
    assert.ok(
      /repository state|test coverage/.test(text),
      'the v1 strings must contain the wording this round removed, or this proves nothing',
    );
  }

  // The current text is a strict improvement on exactly those phrases.
  assert.ok(!/repository state/.test(JEV_QUESTIONS.requirements_satisfied.instructions));
  assert.ok(!/test coverage/.test(JEV_QUESTIONS.verification_sufficient.instructions));
});

test('a renamed question is readable under both prompt versions', () => {
  // v1 logged `tests_sufficient`; v2 logs `verification_sufficient`. An analysis that reads only
  // the current name shows em dashes for every v1 row, which reads as "Jev did not answer" rather
  // than "the field was called something else then".
  assert.equal(readProbability({ verification_sufficient: 0.7 }, 'verification_sufficient'), 0.7);
  assert.equal(readProbability({ tests_sufficient: 0.4 }, 'verification_sufficient'), 0.4, 'v1 rows stay readable');
  assert.equal(readProbability({ tests_sufficient: 0.4, verification_sufficient: 0.7 }, 'verification_sufficient'), 0.7, 'the current key wins');
  assert.equal(readProbability({}, 'verification_sufficient'), undefined);
  assert.equal(readProbability(null, 'verification_sufficient'), undefined);
  assert.equal(readProbability({ requirements_satisfied: 0.5 }, 'requirements_satisfied'), 0.5, 'unrenamed names are unaffected');
});

// ── calibration provenance ───────────────────────────────────────────────────
//
// A threshold is a claim about a model. These tests lock the two fields that make
// such a claim checkable later: which concrete model answered, and which questions
// were asked. Without them a calibration table is not falsifiable — you cannot tell a
// changed model from a changed prompt from ordinary drift.

/** Recompute the hash recipe independently of the module, so agreement means something. */
function hashQuestionSet(pairs) {
  return createHash('sha256').update(pairs.join('\u0001')).digest('hex').slice(0, 16);
}

function questionPairs(names = JEV_QUESTION_NAMES) {
  return names.map((name) => `${name}\u0000${JEV_QUESTIONS[name].instructions}`);
}

test('the question-set hash is derived, stable and sensitive to the questions', () => {
  assert.match(QUESTION_SET_HASH, /^[0-9a-f]{16}$/, 'the hash must be a short hex digest');

  // Stability. Recomputed here from scratch: if the recipe were non-deterministic, the
  // same rows would group differently in different processes and the field would be
  // worthless for comparison.
  assert.equal(hashQuestionSet(questionPairs()), QUESTION_SET_HASH);

  // Sensitivity — the actual promise, and the thing a hand-bumped version number cannot do.
  //
  // The tamper APPENDS a character rather than substituting a phrase. A phrase-based edit broke the
  // moment the v2 wording replaced the v1 wording it quoted, which would have quietly turned a
  // sensitivity test into a test of whether someone remembered to update the test.
  const tampered = questionPairs();
  tampered[2] = `${questionPairs()[2]}!`;
  assert.notEqual(tampered[2], questionPairs()[2], 'the tamper must land, or this proves nothing');
  assert.notEqual(
    hashQuestionSet(tampered),
    QUESTION_SET_HASH,
    'editing an instruction must change the hash even if PROMPT_VERSION was not bumped',
  );

  // Order is load-bearing. The questions are answered by index in a batched request, so
  // a reordering silently reassigns every probability to a different question. If the
  // hash ignored order, that would be invisible in the log.
  const reversed = questionPairs([...JEV_QUESTION_NAMES].reverse());
  assert.notEqual(hashQuestionSet(reversed), QUESTION_SET_HASH, 'order must be part of the hash');
});

test('an assessment row records which model answered, separately from the alias asked for', () => {
  const row = assessmentRow({
    assessmentId: 'a-1',
    sessionId: 's-1',
    turn: 1,
    cwd: 'C:\\work',
    shadow: true,
    trigger: 'turn-stopping',
    fingerprint: 'fp',
    fingerprintVersion: 1,
    changedFields: [],
    state: null,
    stateTokens: null,
    stateStage: 'none',
    decision: { action: 'pass', reason: 'fine', rule: 'P0', policy_v: 1 },
    jev: {
      probabilities: { ready_to_finish: 0.91 },
      requestId: 'req-1',
      usage: { input_tokens: 900, output_tokens: 40 },
      model: 'jev-2026-01-15',
      modelRequested: 'jev-latest',
    },
    jevError: null,
    latency: { total: 12, jev: 9 },
    costUsd: 0.0001,
    promptVersion: 1,
    questionSetHash: QUESTION_SET_HASH,
    taskStateVersion: 2,
  });

  assert.equal(row.jev.model, 'jev-2026-01-15', 'the concrete version must be recorded');
  assert.equal(row.jev.model_requested, 'jev-latest', 'the alias must be recorded too');
  assert.equal(row.question_set_hash, QUESTION_SET_HASH);
  assert.equal(row.question_set_v, 1);
  // `prompt_v` is kept because existing rows already carry it; a reader grouping by
  // either name must see the same number.
  assert.equal(row.prompt_v, row.question_set_v);
});

test('a response that does not name its model records null, never the requested alias', () => {
  // The trap this guards: filling `model` from the request would make the log assert a
  // concrete version that the API never confirmed, which is worse than admitting the
  // field is unknown. A recorded alias would then be read later as "calibration is
  // still valid".
  const answers = {};
  for (const name of JEV_QUESTION_NAMES) answers[name] = { noul: 0.5 };
  const parsed = parseJevResponse(200, true, JSON.stringify({ answers, request_id: 'r' }));
  assert.equal(parsed.model, null);

  const named = parseJevResponse(
    200,
    true,
    JSON.stringify({ answers, request_id: 'r', model: 'jev-2026-01-15' }),
  );
  assert.equal(named.model, 'jev-2026-01-15');
});

test('a row written without a question-set hash says null rather than guessing one', () => {
  // Older callers (and the captured fixture rows) predate the field. Recording a
  // default would silently claim provenance those rows do not have.
  const row = assessmentRow({
    assessmentId: 'a-2',
    sessionId: 's-2',
    turn: 1,
    cwd: '.',
    shadow: true,
    trigger: 'turn-stopping',
    fingerprint: 'fp',
    fingerprintVersion: 1,
    changedFields: [],
    state: null,
    stateTokens: null,
    stateStage: 'none',
    decision: null,
    jev: null,
    jevError: { kind: 'timeout', message: 'timed out' },
    latency: { total: 5001, jev: null },
    costUsd: null,
    promptVersion: 1,
    taskStateVersion: 2,
  });
  assert.equal(row.question_set_hash, null);
  assert.equal(row.jev, null);
});
