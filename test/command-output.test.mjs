/**
 * Command output in the TaskState (task_v 4).
 *
 * WHY THIS FIELD EXISTS, IN ONE MEASURED SENTENCE
 * -----------------------------------------------
 * In the task_v 3 sample, every completed turn that was blocked was blocked by
 * `P6_evidence_mismatch`: `evidence_matches_claim` sat at 0.40-0.47 against a 0.50 threshold
 * (C1 0.42, C2 0.47, N2 0.40), and in all three the claim quoted something a command had
 * PRINTED — "output hello, world", "12 files, 4078 lines" — while the state carried only the
 * command text and its exit code. Jev said the claim was unsupported by the recorded items.
 * It was right. The evidence genuinely was not there, so the wording was not too strict and
 * the threshold was not too low.
 *
 * That makes these tests about EVIDENCE ARRIVING, not about a score moving. A test that only
 * asserted "the probability went up" would pass on a lucky sample and tell us nothing about
 * whether the missing fact now reaches the judge.
 *
 * The three cases here are the three the change has to get right: (1) the output a claim
 * refers to is actually present, (2) a large output is cut but its END — the summary, the
 * total, the exit marker — survives, and (3) a secret printed by a command reaches neither
 * the state nor the log.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  deriveEvidence,
  assembleTaskState,
  COMMAND_OUTPUT_LIMIT,
  COMMAND_OUTPUT_TOTAL_LIMIT,
} from '../lib/taskstate.js';
import { assessmentRow, DecisionLog } from '../lib/log.js';

let seq = 0;

/**
 * A `tool/call` event shaped exactly as the session log records one.
 *
 * `arguments` is a JSON STRING, not an object — `appendToolCall` writes the model's raw
 * argument text straight through, and the parsed form exists only on the execution path that
 * never reaches the log. Handing this helper a parsed object would test a shape that does not
 * occur and would hide the defect that made every command invisible once already.
 */
function callEvent(callId, name, args, turn = 1) {
  return { type: 'tool/call', data: { callId, name, arguments: JSON.stringify(args), turn } };
}

/** A `tool/result` event shaped exactly as the session log records one. */
function resultEvent(callId, text, { turn = 1, isError = false } = {}) {
  return {
    type: 'tool/result',
    data: {
      turn,
      step: 1,
      message: {
        id: `msg_${(seq += 1)}`,
        role: 'tool',
        source: { kind: 'tool', callId },
        content: [
          { type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text }], isError },
        ],
      },
    },
  };
}

/** A shell call and its result — the two events every case here needs. */
function runPair(command, text, { isError = false } = {}) {
  const callId = `call_${(seq += 1)}`;
  return [
    callEvent(callId, 'pwsh', { command, description: 'do the thing' }),
    resultEvent(callId, text, { isError }),
  ];
}

/** The one assistant text a turn ends with, which is the completion claim. */
function claimEvent(text, turn = 1) {
  return {
    type: 'assistant/message',
    data: { turn, step: 2, message: { content: [{ type: 'text', text }] } },
  };
}

const GIT_BLIND = { available: false, changed_files: [], untracked: [], insertions: null, deletions: null };

function stateFor(events, opts = {}) {
  const derived = deriveEvidence(events, 1, opts);
  return {
    derived,
    state: assembleTaskState({
      sessionId: 's1',
      turn: 1,
      cwd: 'C:\\tmp',
      derived,
      git: GIT_BLIND,
      prior: null,
      at: '2026-01-01T00:00:00.000Z',
    }),
  };
}

// ── 1. the output a claim refers to is present ────────────────────────────────

test('a claim that quotes what a command PRINTED is supported by output_tail', () => {
  const events = [
    ...runPair('node scratch/v2-c1-hello.mjs', 'hello, world\n'),
    claimEvent('The script printed hello, world.'),
  ];

  const { derived, state } = stateFor(events, { cwd: 'C:\\Users\\me\\Desktop\\git cloud' });
  const entry = state.commands[0];

  assert.equal(derived.commands.length, 1);
  assert.equal(entry.exit, 0);
  assert.ok(
    entry.output_tail.includes('hello, world'),
    'the line the claim quotes has to reach the judge, or the claim stays unsupported',
  );
  assert.equal(entry.output_truncated, false, 'fourteen characters are not a truncation');
  assert.equal(entry.output_chars, 'hello, world\n'.length, 'the length is the real one, not a guess');
  assert.match(entry.output_hash, /^[0-9a-f]{8}$/, 'the fingerprint component must be a stable hash');
});

// ── 2. a large output is cut, and its end survives ────────────────────────────

test('a large output is truncated, and the end of it survives', () => {
  // The end is where the evidence is — a test summary, a total, a count, DSH's exit marker —
  // which is the same reason `readToolResult` has always read from the tail. 28.6k characters
  // of padding puts the original past the 20k tail window AND past the 1500-character
  // per-command budget, so both cuts are exercised at once.
  const padding = 'line of output padding\n'.repeat(1300);
  const ending = 'Tests  12 passed (12)\n12 files, 4078 lines total';
  const text = `${padding}${ending}\n[exit code: 0]`;

  const { state } = stateFor(runPair('npm test', text));
  const entry = state.commands[0];

  assert.ok(entry.output_tail.length <= COMMAND_OUTPUT_LIMIT, 'the per-command budget must hold');
  assert.ok(entry.output_tail.includes('12 files, 4078 lines total'), 'the last line must survive');
  assert.ok(entry.output_tail.includes('Tests  12 passed'), 'and the summary line above it');
  assert.equal(entry.output_truncated, true);
  assert.equal(
    entry.output_chars,
    text.length,
    'the ORIGINAL length — comparing the 20k window instead would make a 200k log describe its reader',
  );
  assert.ok(entry.output_chars > 20000, 'the fixture has to exceed the tail window to test this');

  // The SHARED budget, on top of the per-command one. Twelve commands each at their own limit
  // would be 18k characters inside a 12k-token state, and `fitState` would then have to degrade
  // the goal and the claim — the two texts the judgement is actually about — to make room for
  // log tails.
  const many = [];
  for (let index = 1; index <= 12; index += 1) {
    many.push(...runPair(`echo step ${index}`, `${'y'.repeat(1400)}end-${index}\n`));
  }
  const shared = deriveEvidence(many, 1).commands;
  const total = shared.reduce((sum, item) => sum + item.output_tail.length, 0);
  assert.ok(total <= COMMAND_OUTPUT_TOTAL_LIMIT, `total ${total} must respect the shared budget`);
  assert.ok(
    shared[shared.length - 1].output_tail.includes('end-12'),
    'the newest command is the one a closing claim refers to, so it keeps its output',
  );
  assert.equal(shared[0].output_tail, '', 'the oldest command gives up its output first');
  assert.equal(shared[0].output_truncated, true, 'and says so, rather than looking empty');
  assert.equal(shared[0].exit, 0, 'it keeps its exit code, which is what tests_passed is built from');
});

// ── 3. a secret printed by a command reaches neither sink ─────────────────────

test('a secret printed by a command reaches neither the state nor the log', () => {
  // Defence in depth, and the DEEPER layer is the one under test. `DecisionLog` already scrubs
  // every row it writes, so configuring the log with the secret would let this pass even with no
  // redaction at the source. This log is deliberately given NO secret: the row must still be
  // clean, which can only be true if the text was cleaned before it entered the state.
  const SECRET = 'tsk_live_9f3a2b7c1d4e5f60718293a4b5c6d7e8';
  const events = [
    ...runPair('Get-ChildItem env:', `SOME_KEY=${SECRET}\nok\n`),
    claimEvent('Listed the environment.'),
  ];

  const { state } = stateFor(events, { secret: SECRET });
  const stateText = JSON.stringify(state);

  assert.ok(!stateText.includes(SECRET), 'the secret must not be in the state sent to Jev');
  assert.ok(
    stateText.includes('[redacted-key]'),
    'and the redaction must be visible, so a reader can tell it happened',
  );

  const lines = [];
  const log = new DecisionLog({ sink: (line) => lines.push(line) });
  log.write(
    assessmentRow({
      assessmentId: 'a1',
      sessionId: 's1',
      turn: 1,
      cwd: 'C:\\tmp',
      shadow: true,
      trigger: 'turn-stopping',
      fingerprint: 'deadbeef',
      fingerprintVersion: 3,
      changedFields: [],
      state,
      stateTokens: 1,
      stateStage: 'full',
      decision: { action: 'continue', reason: 'r', rule: null, policy_v: 1 },
      jev: null,
      jevError: null,
      latency: { total: 0, jev: null },
      costUsd: 0,
      promptVersion: 2,
      taskStateVersion: 4,
      taskKey: 's1#t1',
      assessmentsUsedBefore: 0,
      maxAssessments: 3,
    }),
  );

  assert.equal(lines.length, 1, 'the row must actually have been written, or this proves nothing');
  assert.ok(!lines.join('').includes(SECRET), 'nor in the decision log');
  assert.equal(
    log.redactions,
    0,
    'the log writer must never have to fire: a non-zero count here means the source leaked',
  );
});

// ── the fingerprint must not churn on output text ─────────────────────────────

test('the fingerprint tracks output changes by hash, not by text', () => {
  // Why this matters, mechanically: `materialFacts` is `JSON.stringify`-ed and hashed, so live
  // command output would make the fingerprint move on every unrelated byte a deterministic tool
  // printed — a timestamp inside a log line, a progress counter, a temp path. Each move costs a
  // Jev call, and `no_material_change` is the deduplication the fingerprint exists for.
  const base = stateFor(runPair('npm test', 'ok\n')).state;
  const noisy = stateFor(
    runPair('npm test', `ok\n# finished at ${new Date().toISOString()} in C:\\tmp\\x${'z'.repeat(300)}\n`),
  ).state;

  // The tails differ, so the two states are NOT identical — the point is only that nothing threw.
  assert.notEqual(base.commands[0].output_hash, noisy.commands[0].output_hash);

  // Same output twice must fingerprint identically. That is the property the skip depends on.
  const once = stateFor(runPair('npm test', 'ok\n')).state;
  const twice = stateFor(runPair('npm test', 'ok\n')).state;
  assert.equal(once.commands[0].output_hash, twice.commands[0].output_hash);
});
