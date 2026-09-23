/**
 * Tests for the pure modules. No DSH, no network, no disk: `fetch` and the log
 * sink are injected. Every test here runs with plain `node --test`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { estimateTokens, estimateJsonTokens } from '../lib/tokens.js';
import {
  changedFields,
  fingerprintState,
  hash32,
  isMaterialChange,
  materialFacts,
} from '../lib/fingerprint.js';
import {
  classifyCommand,
  detectUnverifiedClaims,
  deriveEvidence,
  fitState,
  parseExitCode,
  readToolArguments,
  estimateCostUsd,
} from '../lib/taskstate.js';
import { ACTIONS, decide, decideWithoutJev, renderSteerMessage, resolveThresholds } from '../lib/policy.js';
import {
  buildJevRequest,
  JevError,
  noulAnswer,
  parseJevResponse,
  readApiKeyFromEnv,
  readApiKeyFromFile,
  resolveApiKey,
} from '../lib/jev.js';
import { classifyFollowup, judgeOutcome, DecisionLog, joinOutcomes, redactSecret } from '../lib/log.js';
import { JEV_QUESTION_NAMES } from '../lib/questions.js';
import { createStateStore } from '../lib/state.js';
import { parseStatus, parseShortstat } from '../lib/git.js';

// ── helpers ──────────────────────────────────────────────────────────────────

/** Build a plausible assessment with every probability defaulted to 0.9. */
function probs(overrides = {}) {
  const base = {};
  for (const name of JEV_QUESTION_NAMES) base[name] = 0.9;
  // Defaults that read as "done": the two negative questions are low.
  base.blocking_issue_remaining = 0.05;
  base.needs_more_verification = 0.05;
  return { ...base, ...overrides };
}

/** Minimal state factory. */
function state(overrides = {}) {
  return {
    goal: 'Add a retry to the uploader',
    claim: 'Done — added retry with backoff.',
    repo: { changed_files: ['src/upload.js'], untracked: [], insertions: 12, deletions: 3 },
    commands: [],
    evidence: {
      tests_run: false,
      tests_passed: null,
      build_ok: null,
      lint_ok: null,
      error_results: [],
      unverified_claims: [],
    },
    activity: { tool_calls_this_turn: 3, tools_used: ['edit'] },
    ...overrides,
  };
}

/**
 * One tool/call + tool/result pair as DSH appends them.
 *
 * `arguments` is a JSON STRING in the real session log, not an object: DSH writes
 * the model's raw argument text straight through (`appendToolCall`,
 * `dsh-agent-loop/lib/index.js:687-695`) and parses it only on the execution path.
 * An earlier version of this fixture passed an object, which hid a real defect:
 * `readToolCall` accepted only objects, so every real command read as absent and
 * "tests pass" became a fabricated "you never ran the tests" contradiction.
 */
function toolPair({ callId, name, args, resultText, isError = false, turn = 1, rawArguments }) {
  return [
    {
      type: 'tool/call',
      data: {
        turn,
        step: 1,
        callId,
        name,
        arguments: rawArguments !== undefined ? rawArguments : JSON.stringify(args),
      },
    },
    {
      type: 'tool/result',
      data: {
        turn,
        step: 1,
        message: { content: [{ type: 'tool-result', toolCallId: callId, content: resultText, isError }] },
      },
    },
  ];
}

// ── tokens ───────────────────────────────────────────────────────────────────

test('estimateTokens follows the calibrated letter/digit/symbol costs', () => {
  // Six letters = 1 token.
  assert.equal(estimateTokens('abcdef'), 1);
  // Twelve letters = 2 tokens (1 + floor(11/6) = 2).
  assert.equal(estimateTokens('abcdefghijkl'), 2);
  // Two digits = 1 token.
  assert.equal(estimateTokens('12'), 1);
  assert.equal(estimateTokens(''), 0);
  assert.equal(estimateTokens(null), 0);
  // Whitespace is not tokenised at all.
  assert.equal(estimateTokens('   '), 0);
});

test('estimateTokens over-estimates JSON rather than under-estimating it', () => {
  // The whole point of the calibration: never under-count a JSON-heavy state.
  const json = JSON.stringify({ a: 'hello world', b: [1, 2, 3], c: { d: true } });
  const estimate = estimateTokens(json);
  assert.ok(estimate > 0);
  // A naive chars/4 ratio must be lower than our estimate (i.e. we are safer).
  assert.ok(estimate >= json.length / 4);
});

test('estimateJsonTokens returns Infinity for unserialisable values', () => {
  const cyclic = {};
  cyclic.self = cyclic;
  assert.equal(estimateJsonTokens(cyclic), Number.POSITIVE_INFINITY);
  assert.ok(estimateJsonTokens({ a: 1 }) > 0);
});

// ── fingerprint ──────────────────────────────────────────────────────────────

test('hash32 is stable and hex-formatted', () => {
  assert.equal(hash32('abc'), hash32('abc'));
  assert.match(hash32('abc'), /^[0-9a-f]{8}$/);
  assert.notEqual(hash32('abc'), hash32('abd'));
});

test('fingerprint is stable across cosmetic whitespace changes', () => {
  const a = fingerprintState(state({ goal: 'Add  a retry' }));
  const b = fingerprintState(state({ goal: 'Add a  retry\n' }));
  assert.equal(a.fingerprint, b.fingerprint);
});

test('fingerprint ignores volatile fields like turn, timestamps and counts', () => {
  const base = state();
  const withVolatile = { ...base, turn: 99, at: '2030-01-01T00:00:00Z', session_id: 'other' };
  assert.equal(fingerprintState(base).fingerprint, fingerprintState(withVolatile).fingerprint);
});

test('fingerprint changes when material facts change', () => {
  const base = state();
  const basePrint = fingerprintState(base).fingerprint;

  // A changed file list is material.
  assert.notEqual(
    basePrint,
    fingerprintState(state({ repo: { ...base.repo, changed_files: ['src/other.js'] } })).fingerprint,
  );
  // An exit code flipping is material.
  assert.notEqual(
    basePrint,
    fingerprintState(state({ commands: [{ cmd: 'npm test', exit: 1, kind: 'test' }] })).fingerprint,
  );
  // A claim that stops being contradicted is material.
  assert.notEqual(
    basePrint,
    fingerprintState(state({ evidence: { ...base.evidence, tests_run: true, tests_passed: true } })).fingerprint,
  );
  // A different claim is material.
  assert.notEqual(basePrint, fingerprintState(state({ claim: 'Still working on it.' })).fingerprint);
});

test('fingerprint distinguishes "not run" from "ran and failed"', () => {
  const notRun = fingerprintState(state()).fingerprint;
  const failed = fingerprintState(
    state({ evidence: { ...state().evidence, tests_run: true, tests_passed: false } }),
  ).fingerprint;
  assert.notEqual(notRun, failed);
});

test('materialFacts sorts file and command lists so ordering is not material', () => {
  const one = state({ repo: { ...state().repo, changed_files: ['b.js', 'a.js'] } });
  const two = state({ repo: { ...state().repo, changed_files: ['a.js', 'b.js'] } });
  assert.equal(fingerprintState(one).fingerprint, fingerprintState(two).fingerprint);
});

test('fingerprint treats losing or gaining git visibility as material', () => {
  // REGRESSION, found by reading real log rows: `repo.available` was computed by
  // collectGitFacts but never reached the TaskState or the fingerprint, so an
  // unreadable repository produced exactly the same facts as a clean one. On this
  // machine the default workspace is NOT a git repository, so that is the normal
  // case, not an edge case.
  const blind = state({ repo: { ...state().repo, available: false } });
  const seeing = state({ repo: { ...state().repo, available: true } });
  assert.notEqual(fingerprintState(blind).fingerprint, fingerprintState(seeing).fingerprint);
  // The same emptiness means different things, so it must be visible in the facts.
  assert.equal(materialFacts(blind).repo_available, false);
  assert.equal(materialFacts(seeing).repo_available, true);
  // And it must survive the git-blind turn being assessed first, so the turn that
  // GAINS visibility is not skipped as "unchanged" at the moment evidence appears.
  assert.ok(changedFields(materialFacts(blind), materialFacts(seeing)).includes('repo_available'));
});

test('fitState never drops the git-visibility flag while compressing', () => {
  const big = state({
    repo: {
      ...state().repo,
      available: false,
      changed_files: Array.from({ length: 200 }, (_, i) => `src/deep/path/file-${i}.js`),
      untracked: Array.from({ length: 200 }, (_, i) => `tmp/scratch-${i}.txt`),
    },
    commands: Array.from({ length: 60 }, (_, i) => ({ cmd: `npm test -- suite-${i}`, exit: 0, kind: 'test' })),
  });
  const fitted = fitState(big, 1);
  // A budget of 1 forces every stage; the last resort may still fail, and both
  // outcomes must preserve the flag rather than silently reporting "clean repo".
  if (fitted !== null) {
    assert.equal(fitted.state.repo.available, false, `stage ${fitted.stage} dropped repo.available`);
  }
  // With a realistic budget the compressed state must still carry it.
  const realistic = fitState(big, 12000);
  assert.ok(realistic !== null);
  assert.equal(realistic.state.repo.available, false);
});

test('isMaterialChange treats a missing previous fingerprint as changed', () => {
  assert.equal(isMaterialChange(null, 'abcd'), true);
  assert.equal(isMaterialChange('', 'abcd'), true);
  assert.equal(isMaterialChange('abcd', 'abcd'), false);
  assert.equal(isMaterialChange('abcd', 'abce'), true);
});

test('changedFields reports which components differ', () => {
  const before = materialFacts(state());
  const after = materialFacts(state({ claim: 'Something else entirely.' }));
  const changed = changedFields(before, after);
  assert.ok(changed.includes('claim'));
  assert.ok(!changed.includes('goal'));
});

// ── evidence derivation ──────────────────────────────────────────────────────

test('parseExitCode reads the marker contract, and absent marker means 0', () => {
  assert.equal(parseExitCode('all good'), 0);
  assert.equal(parseExitCode('boom\n[exit code: 1]'), 1);
  assert.equal(parseExitCode('boom\n[exit code: 127]'), 127);
  // A signal kill has no exit code.
  assert.equal(parseExitCode('died\n[killed by signal: SIGKILL]'), null);
});

test('classifyCommand categorises the commands we care about', () => {
  assert.equal(classifyCommand('npm test'), 'test');
  assert.equal(classifyCommand('npx vitest run'), 'test');
  assert.equal(classifyCommand('go test ./...'), 'test');
  assert.equal(classifyCommand('tsc --noEmit'), 'typecheck');
  assert.equal(classifyCommand('npx eslint src'), 'lint');
  assert.equal(classifyCommand('npm run build'), 'build');
  assert.equal(classifyCommand('git status'), 'other');
  assert.equal(classifyCommand(''), 'other');
});

test('deriveEvidence reads shell commands, exit codes and errors out of a real turn', () => {
  const events = [
    ...toolPair({ callId: 'c1', name: 'pwsh', args: { command: 'npm test' }, resultText: 'ok\n' }),
    ...toolPair({
      callId: 'c2',
      name: 'pwsh',
      args: { command: 'npm run build' },
      resultText: 'tsc error\n[exit code: 2]',
    }),
    {
      type: 'assistant/message',
      data: { turn: 1, step: 2, message: { content: [{ type: 'text', text: 'All tests pass.' }] } },
    },
  ];

  const derived = deriveEvidence(events, 1);

  assert.equal(derived.commands.length, 2);
  assert.equal(derived.commands[0].kind, 'test');
  assert.equal(derived.commands[0].exit, 0);
  assert.equal(derived.commands[1].kind, 'build');
  assert.equal(derived.commands[1].exit, 2);

  assert.equal(derived.evidence.tests_run, true);
  assert.equal(derived.evidence.tests_passed, true);
  assert.equal(derived.evidence.build_ok, false);
  assert.equal(derived.claim, 'All tests pass.');
  assert.equal(derived.activity.tool_calls_this_turn, 2);
});

test('a real recorded tool/call (arguments as a JSON string) is fully readable', () => {
  // REGRESSION, caught by reading a real session log after the restart.
  //
  // The event below is copied verbatim from
  // ~/.dsh/sessions/<cwd>/<session>/session.v3.jsonl.zstd and only trimmed: DSH
  // stores `arguments` as the model's RAW STRING. The first implementation accepted
  // only an object, so `args` collapsed to `{}` and every shell command vanished.
  //
  // Why that matters more than "we lost a field": with no command visible,
  // `detectUnverifiedClaims` sees the agent say "tests pass" with nothing to back
  // it and reports a contradiction that never happened — the plugin would then
  // interrupt a turn that was actually fine. A silent parse failure must never
  // become a confident accusation.
  const events = [
    {
      type: 'tool/call',
      seq: 18,
      time: 1789838013750,
      data: {
        turn: 1,
        step: 1,
        callId: 'call_00_4YPj8LtOMF603lVoUZ4c3368',
        name: 'pwsh',
        arguments: '{"command":"npm test","timeoutMs":120000}',
      },
    },
    {
      type: 'tool/result',
      seq: 19,
      data: {
        turn: 1,
        step: 1,
        message: {
          source: { kind: 'tool', callId: 'call_00_4YPj8LtOMF603lVoUZ4c3368' },
          content: [
            {
              type: 'tool-result',
              toolCallId: 'call_00_4YPj8LtOMF603lVoUZ4c3368',
              content: [{ type: 'text', text: 'all 12 tests pass\n' }],
              isError: false,
            },
          ],
          role: 'user',
          id: 'f85933b8-72dc-427f-8014-9e66f2e034ae',
        },
      },
    },
    {
      type: 'assistant/message',
      data: { turn: 1, step: 2, message: { content: [{ type: 'text', text: 'All tests pass.' }] } },
    },
  ];

  const derived = deriveEvidence(events, 1);

  assert.equal(derived.commands.length, 1, 'the command must be visible, not dropped');
  assert.equal(derived.commands[0].cmd, 'npm test');
  assert.equal(derived.commands[0].kind, 'test');
  assert.equal(derived.evidence.tests_run, true);
  assert.equal(derived.evidence.tests_passed, true);
  // The payoff: an honest "tests pass" backed by a real command is NOT flagged.
  assert.deepEqual(detectUnverifiedClaims(derived), []);
});

test('readToolArguments accepts a string, an object, and unusable input', () => {
  assert.deepEqual(readToolArguments('{"command":"npm test"}'), { command: 'npm test' });
  // Hand-built events and older fixtures pass an object; both must keep working.
  assert.deepEqual(readToolArguments({ command: 'npm test' }), { command: 'npm test' });
  // Invalid JSON is preserved as source text by DSH, so it carries no argument.
  assert.deepEqual(readToolArguments('{not json'), {});
  assert.deepEqual(readToolArguments(''), {});
  assert.deepEqual(readToolArguments(undefined), {});
  assert.deepEqual(readToolArguments(null), {});
  // A JSON scalar is valid JSON but cannot carry a named argument.
  assert.deepEqual(readToolArguments('42'), {});
});

test('deriveEvidence ignores events from other turns', () => {  const events = toolPair({ callId: 'c1', name: 'pwsh', args: { command: 'npm test' }, resultText: 'ok\n', turn: 7 });
  const derived = deriveEvidence(events, 1);
  assert.equal(derived.commands.length, 0);
  assert.equal(derived.activity.tool_calls_this_turn, 0);
});

test('deriveEvidence captures error results', () => {
  const events = toolPair({
    callId: 'c1',
    name: 'edit',
    args: {},
    resultText: 'string not found in file',
    isError: true,
  });
  const derived = deriveEvidence(events, 1);
  assert.equal(derived.evidence.error_results.length, 1);
  assert.equal(derived.evidence.error_results[0].tool, 'edit');
});

test('deriveEvidence takes the goal from a user message but skips plugin and tool sources', () => {
  const events = [
    { type: 'user/message', data: { content: [{ type: 'text', text: 'Real goal' }], source: { kind: 'user' } } },
    { type: 'user/message', data: { content: [{ type: 'text', text: 'supervisor text' }], source: { kind: 'plugin' } } },
  ];
  const derived = deriveEvidence(events, 1);
  assert.equal(derived.goal, 'Real goal');
});

test('detectUnverifiedClaims catches a test claim with no test command', () => {
  const evidence = { tests_run: false, tests_passed: null, build_ok: null, lint_ok: null };
  const claims = detectUnverifiedClaims('All tests pass now.', evidence);
  assert.equal(claims.length, 1);
  assert.match(claims[0], /no test command/);
});

test('detectUnverifiedClaims reports each category once, however many phrases match', () => {
  // The pattern list intentionally overlaps: this sentence matches several. The
  // agent should be told once per missing verification, not once per pattern.
  const evidence = { tests_run: false, tests_passed: null, build_ok: null, lint_ok: null };
  const claims = detectUnverifiedClaims('All tests pass and the build is clean.', evidence);
  assert.equal(claims.length, 2);
  assert.equal(claims.filter((line) => /no test command/.test(line)).length, 1);
  assert.equal(claims.filter((line) => /no build command/.test(line)).length, 1);
});

test('detectUnverifiedClaims catches a test claim when the recorded run failed', () => {
  const evidence = { tests_run: true, tests_passed: false, build_ok: null, lint_ok: null };
  const claims = detectUnverifiedClaims('The test suite passes.', evidence);
  assert.equal(claims.length, 1);
  assert.match(claims[0], /did not pass/);
});

test('detectUnverifiedClaims accepts a claim backed by a passing run', () => {
  const evidence = { tests_run: true, tests_passed: true, build_ok: null, lint_ok: null };
  assert.deepEqual(detectUnverifiedClaims('All tests pass.', evidence), []);
});

test('detectUnverifiedClaims says nothing about a claim that asserts nothing', () => {
  const evidence = { tests_run: false, tests_passed: null, build_ok: null, lint_ok: null };
  assert.deepEqual(detectUnverifiedClaims('Refactored the parser for clarity.', evidence), []);
});

// ── state fitting ────────────────────────────────────────────────────────────

test('fitState returns the state untouched when it already fits', () => {
  const fitted = fitState(state(), 1_000_000);
  assert.equal(fitted.stage, 'full');
  assert.equal(fitted.state.claim, state().claim);
});

test('fitState compresses in stages and reports which one it used', () => {
  const big = state({
    claim: 'x'.repeat(40_000),
    goal: 'y'.repeat(40_000),
    commands: Array.from({ length: 12 }, (_, index) => ({
      cmd: `npm run step-${index}`,
      exit: 0,
      kind: 'other',
    })),
  });
  const fitted = fitState(big, 4000);
  assert.ok(fitted !== null);
  assert.notEqual(fitted.stage, 'full');
  assert.ok(fitted.tokens <= 4000);
  // The claim keeps its TAIL: a summary's conclusion is at the end.
  assert.ok(fitted.state.claim.startsWith('…'));
});

test('fitState returns null rather than a hopelessly truncated state', () => {
  const enormous = state({
    claim: 'x'.repeat(200_000),
    goal: 'y'.repeat(200_000),
  });
  // A budget so small that no stage can reach it.
  assert.equal(fitState(enormous, 10), null);
});

test('estimateCostUsd prices Jev input at $0.042 per million tokens', () => {
  assert.equal(estimateCostUsd({ input_tokens: 1_000_000 }), 0.042);
  assert.equal(estimateCostUsd({ input_tokens: 0 }), 0);
  assert.equal(estimateCostUsd(null), 0);
});

// ── policy ───────────────────────────────────────────────────────────────────

test('decide passes an unremarkable, well-evidenced turn', () => {
  const result = decide({
    state: state({ evidence: { ...state().evidence, tests_run: true, tests_passed: true } }),
    probabilities: probs(),
  });
  assert.equal(result.action, ACTIONS.FINISH);
  assert.equal(result.rule, 'P8_finish');
});

test('decide blocks on a failing test run before consulting any probability', () => {
  const result = decide({
    state: state({ evidence: { ...state().evidence, tests_run: true, tests_passed: false } }),
    probabilities: probs(), // Jev thinks it is fine; the exit code says otherwise.
  });
  assert.equal(result.action, ACTIONS.CONTINUE);
  assert.equal(result.rule, 'P3_failing_tests');
});

test('decide asks for verification when the claim outruns the evidence', () => {
  const result = decide({
    state: state({ evidence: { ...state().evidence, unverified_claims: ['claims "tests pass" but none ran'] } }),
    probabilities: probs(),
  });
  assert.equal(result.action, ACTIONS.VERIFY_MORE);
  assert.equal(result.rule, 'P2_unverified_claim');
});

test('decide blocks on unresolved errors unless tests passed cleanly', () => {
  const withError = state({
    evidence: { ...state().evidence, error_results: [{ tool: 'edit', msg: 'not found' }] },
  });
  assert.equal(decide({ state: withError, probabilities: probs() }).rule, 'P1_unresolved_errors');

  // A clean test run supersedes a stray earlier error.
  const superseded = state({
    evidence: {
      ...state().evidence,
      error_results: [{ tool: 'edit', msg: 'not found' }],
      tests_run: true,
      tests_passed: true,
    },
  });
  assert.notEqual(decide({ state: superseded, probabilities: probs() }).rule, 'P1_unresolved_errors');
});

test('decide treats the uncertain middle band as a pass', () => {
  // All seven probabilities mid-range: nothing crosses a threshold.
  const middling = {
    requirements_satisfied: 0.6,
    implementation_complete: 0.6,
    verification_sufficient: 0.6,
    blocking_issue_remaining: 0.3,
    evidence_matches_claim: 0.6,
    needs_more_verification: 0.3,
    ready_to_finish: 0.6,
  };
  const result = decide({ state: state(), probabilities: middling });
  assert.equal(result.action, ACTIONS.FINISH);
  assert.equal(result.rule, 'P9_default_pass');
});

test('no probability can steer any more, and P4b is gone with it', () => {
  // THE CONTRACT POLICY_VERSION 3 EXISTS FOR. P4 was the last rule a probability could steer
  // through; it is advisory now, so the most extreme reading Jev can produce is recorded and acted
  // on by nobody. Under v2 this exact input produced `continue`, and with a prior continue on the
  // same state it produced `retry`.
  const blocked = probs({ blocking_issue_remaining: 0.9 });
  const result = decide({ state: state(), probabilities: blocked });
  assert.equal(result.action, ACTIONS.FINISH, 'an advisory rule must not change the action');
  assert.equal(result.rule, 'P8_finish');
  assert.equal(result.advisory_rule, 'P4_requirements_unmet', 'but it must still be recorded');
  assert.equal(result.enforce, true);

  // A stale `prior` must not be able to change an action either. That was the whole of P4b, which
  // was deleted rather than demoted: it existed to make a SECOND steer differ from the first, and
  // with no first steer there is nothing left for it to escalate.
  const carryOver = state({
    prior: { assessment: { blocking_issue_remaining: 0.9 }, action: ACTIONS.CONTINUE },
  });
  const repeated = decide({ state: carryOver, probabilities: blocked });
  assert.equal(repeated.action, ACTIONS.FINISH);
  assert.notEqual(repeated.rule, 'P4b_repeat_blocker');
  assert.equal(repeated.advisory_rule, 'P4_requirements_unmet');
});

test('decide records P7 and P6 as ADVISORY and lets the turn finish', () => {
  // BEHAVIOUR CHANGE, POLICY_VERSION 2. Under v1 both of these blocked with `verify_more`. On the
  // real N2 row (task_v 4: needs 0.78, sufficient 0.59, evidence 0.41) both would have fired on a
  // task that had in fact done the work — the same false block under two different names — which is
  // why silencing P6 alone would not have been enough.
  const thin = decide({
    state: state({ evidence: { ...state().evidence, tests_run: true, tests_passed: true } }),
    probabilities: probs({ needs_more_verification: 0.8, verification_sufficient: 0.3 }),
  });
  assert.equal(thin.action, ACTIONS.FINISH, 'an advisory rule must not change the action');
  assert.equal(thin.rule, 'P8_finish');
  assert.equal(thin.advisory_rule, 'P7_needs_verification', 'but it must still be recorded');
  assert.equal(thin.enforce, true, 'the rule that decided is the enforceable P8, not the advisory P7');

  const unsupported = decide({ state: state(), probabilities: probs({ evidence_matches_claim: 0.2 }) });
  assert.equal(unsupported.action, ACTIONS.FINISH);
  assert.equal(unsupported.advisory_rule, 'P6_evidence_mismatch');
});

test('both bands now RECORD only, and the gap between them is a count rather than a decision', () => {
  // What v2 asserted here was a pair of BEHAVIOURS split by the gap between 0.30 and 0.40: inside it
  // the turn passed, below it the turn was steered. v3 took the second half of that pair away from
  // every probability, so these inputs now differ only in what they record — which is the reason both
  // bands are still kept and still printed. `advisory_rule` is the one that answers "would the guard
  // band have interrupted this before v3?", and it is the count of steers the contraction removed.
  const gray = decide({ state: state(), probabilities: probs({ requirements_satisfied: 0.35 }) });
  assert.equal(gray.rule, 'P9_default_pass', 'inside the band: pass, exactly as DSH would without us');
  assert.equal(gray.shadow_rule, 'P4_requirements_unmet', 'the observation band still flags it');
  assert.equal(gray.advisory_rule, null, 'while the intervention band does not — 0.35 is above 0.30');
  assert.equal(gray.gray_zone, true, 'which is precisely what makes it grey');

  const clear = decide({ state: state(), probabilities: probs({ requirements_satisfied: 0.25 }) });
  assert.equal(clear.rule, 'P9_default_pass', 'below BOTH bands, and still no action: the v3 change');
  assert.equal(clear.advisory_rule, 'P4_requirements_unmet', 'recorded as a steer that v3 removed');
  assert.equal(clear.shadow_rule, 'P4_requirements_unmet', 'and the two bands agree here');
  assert.equal(clear.gray_zone, true, 'because nothing acted on them');

  // The same three readings on the blocker side: 0.70 is inside the gap and 0.80 is outside it. The
  // action is P8 in BOTH cases, because the other six probabilities still read as a confident finish.
  const grayBlock = decide({ state: state(), probabilities: probs({ blocking_issue_remaining: 0.7 }) });
  assert.equal(grayBlock.rule, 'P8_finish');
  assert.equal(grayBlock.advisory_rule, null, '0.70 is below the 0.75 boundary');
  assert.equal(grayBlock.gray_zone, true, 'while the observation band would have blocked it');

  const clearBlock = decide({ state: state(), probabilities: probs({ blocking_issue_remaining: 0.8 }) });
  assert.equal(clearBlock.rule, 'P8_finish', 'and the action is identical above it — that is the change');
  assert.equal(clearBlock.advisory_rule, 'P4_requirements_unmet', 'only the recording differs');
});

test('a deterministic failure steers without any probability', () => {
  // P1/P2/P3 compare against code-computed facts, so they are not advisory and they carry no band.
  // They are also the rules that must keep working when Jev is unreachable: a failing test exit code
  // is not a matter of opinion.
  const failed = decide({
    state: state({ evidence: { ...state().evidence, tests_run: true, tests_passed: false } }),
    probabilities: probs({ requirements_satisfied: 0.9, ready_to_finish: 0.9 }),
  });
  assert.equal(failed.rule, 'P3_failing_tests');
  assert.equal(failed.enforce, true);
  assert.equal(failed.gray_zone, false, 'the observation band agrees, so there is no grey zone');
  assert.equal(failed.shadow_rule, 'P3_failing_tests');

  const noJev = decideWithoutJev({
    state: state({ evidence: { ...state().evidence, tests_run: true, tests_passed: false } }),
  });
  assert.equal(noJev.rule, 'P3_failing_tests');
  assert.equal(noJev.enforce, true, 'a fact we computed ourselves may steer even with no Jev');

  assert.equal(decideWithoutJev({ state: state() }).enforce, false, 'no Jev and no contradiction: nothing may steer');
});

test('decideWithoutJev still catches deterministic contradictions', () => {
  const withClaim = state({ evidence: { ...state().evidence, unverified_claims: ['claims tests that never ran'] } });
  assert.equal(decideWithoutJev({ state: withClaim }).action, ACTIONS.VERIFY_MORE);

  const clean = state();
  const passed = decideWithoutJev({ state: clean });
  assert.equal(passed.action, ACTIONS.PASS);
  assert.equal(passed.rule, 'P0_no_jev');
});

test('thresholds are overridable for offline replay', () => {
  const strict = decide({
    state: state(),
    probabilities: probs({ ready_to_finish: 0.72, requirements_satisfied: 0.72 }),
    thresholds: { readyToFinishAtOrAbove: 0.95, requirementsSatisfiedAtOrAbove: 0.95 },
  });
  // Under the default thresholds this would finish; under the strict ones it does not.
  assert.notEqual(strict.rule, 'P8_finish');

  const lenient = decide({
    state: state(),
    probabilities: probs({ ready_to_finish: 0.72, requirements_satisfied: 0.72 }),
    thresholds: { readyToFinishAtOrAbove: 0.5, requirementsSatisfiedAtOrAbove: 0.5 },
  });
  assert.equal(lenient.rule, 'P8_finish');
});

test('resolveThresholds ignores unknown keys and type mismatches', () => {
  const resolved = resolveThresholds({ readyToFinishAtOrAbove: 0.5, bogus: 1, blockOnFailingTests: 'yes' });
  assert.equal(resolved.readyToFinishAtOrAbove, 0.5);
  assert.equal(resolved.blockOnFailingTests, true);
  assert.equal('bogus' in resolved, false);
});

test('every decision carries the policy version so logs stay interpretable', () => {
  const result = decide({ state: state(), probabilities: probs() });
  assert.equal(typeof result.policy_v, 'number');
});

test('renderSteerMessage names the specific problem and offers the honest exit', () => {
  // Use a claim produced by the real detector, so this exercises the actual text
  // the agent would receive rather than a hand-written stand-in.
  const evidence = { tests_run: false, tests_passed: null, build_ok: null, lint_ok: null };
  const claims = detectUnverifiedClaims('All tests pass now.', evidence);
  const withClaim = state({ evidence: { ...state().evidence, unverified_claims: claims } });

  const decision = decideWithoutJev({ state: withClaim });
  const text = renderSteerMessage(decision, withClaim);

  // Names the concrete problem...
  assert.match(text, /no test command/);
  // ...tells the agent to report the real result...
  assert.match(text, /ACTUAL result/);
  // ...and offers the honest exit. Each branch phrases it for its own action:
  // a verify_more says "if you cannot run it, say so"; a continue says "state
  // plainly what remains unfinished". Either way the agent is never cornered
  // into claiming success it cannot demonstrate.
  assert.match(text, /say so explicitly/);
});

test('renderSteerMessage on a retry tells the agent not to restate itself', () => {
  const text = renderSteerMessage({ action: ACTIONS.RETRY, reason: 'x', rule: 'P4b' }, state());
  assert.match(text, /different approach/);
  assert.match(text, /Do not restate/);
});

// ── Jev client ───────────────────────────────────────────────────────────────

test('buildJevRequest throws without a key and otherwise builds a batched body', () => {
  assert.throws(() => buildJevRequest({ apiKey: '' }, {}), JevError);

  const { url, init } = buildJevRequest({ apiKey: 'k' }, { a: 1 });
  assert.match(url, /api\.typesafe\.ai\/v1\/systemone$/);
  assert.equal(init.method, 'POST');
  assert.equal(init.headers.authorization, 'Bearer k');

  const body = JSON.parse(init.body);
  assert.equal(body.state.a, 1);
  // All seven questions in ONE request — the core economic decision.
  assert.deepEqual(Object.keys(body.questions).sort(), [...JEV_QUESTION_NAMES].sort());
});

test('noulAnswer rejects everything that is not a finite number', () => {
  assert.equal(noulAnswer({ noul: 0.5 }, 'q'), 0.5);
  assert.throws(() => noulAnswer(undefined, 'q'), JevError);
  assert.throws(() => noulAnswer({}, 'q'), JevError);
  assert.throws(() => noulAnswer({ noul: 'yes' }, 'q'), JevError);
  assert.throws(() => noulAnswer({ noul: Number.NaN }, 'q'), JevError);
  assert.throws(() => noulAnswer({ noul: Number.POSITIVE_INFINITY }, 'q'), JevError);
  // Out of range is clamped, not rejected: a small overshoot is harmless.
  assert.equal(noulAnswer({ noul: 1.0001 }, 'q'), 1);
  assert.equal(noulAnswer({ noul: -0.0001 }, 'q'), 0);
});

test('parseJevResponse requires a complete answer set', () => {
  const good = { answers: Object.fromEntries(JEV_QUESTION_NAMES.map((n) => [n, { noul: 0.5 }])) };
  const parsed = parseJevResponse(200, true, JSON.stringify(good));
  assert.equal(Object.keys(parsed.probabilities).length, JEV_QUESTION_NAMES.length);

  // Missing one answer must fail the whole assessment, not default it.
  const partial = { answers: { ...good.answers } };
  delete partial.answers.ready_to_finish;
  assert.throws(() => parseJevResponse(200, true, JSON.stringify(partial)), JevError);

  assert.throws(() => parseJevResponse(500, false, 'boom'), JevError);
  assert.throws(() => parseJevResponse(200, true, 'not json'), JevError);
  assert.throws(() => parseJevResponse(200, true, JSON.stringify({ noAnswers: true })), JevError);
});

test('readApiKeyFromEnv tolerates a dotenv line and quotes', () => {
  assert.equal(readApiKeyFromEnv({ TYPESAFE_API_KEY: 'abc' }), 'abc');
  assert.equal(readApiKeyFromEnv({ TYPESAFE_API_KEY: 'TYPESAFE_API_KEY=abc' }), 'abc');
  assert.equal(readApiKeyFromEnv({ TYPESAFE_API_KEY: '"abc"' }), 'abc');
  assert.equal(readApiKeyFromEnv({ TYPESAFE_API_KEY: "  'abc'  " }), 'abc');
  assert.equal(readApiKeyFromEnv({}), '');
  assert.equal(readApiKeyFromEnv({ TYPESAFE_API_KEY: '' }), '');
});

// ── where the key comes from, and keeping it out of every sink ───────────────

test('a key file is read, because DSH Desktop never loads .env itself', () => {
  // THE REASON THIS EXISTS: `dsh-app-boot` defines `loadEnv()` which calls
  // `process.loadEnvFile('.env')`, and its own doc comment promises .env is loaded.
  // In the shipped Desktop build that function is defined and NEVER CALLED — a
  // recursive search finds three references, all on its definition and export lines.
  // So "put it in .env" is silent misinformation, and a user following it sees
  // `present: false` with no explanation. The plugin therefore reads the file itself.
  const read = (content) => () => content;

  assert.equal(readApiKeyFromFile('k.env', read('TYPESAFE_API_KEY=abc123')), 'abc123');
  assert.equal(readApiKeyFromFile('k.env', read('export TYPESAFE_API_KEY=abc123')), 'abc123');
  assert.equal(readApiKeyFromFile('k.env', read('  TYPESAFE_API_KEY = "abc123"  ')), 'abc123');
  assert.equal(readApiKeyFromFile('k.env', read("TYPESAFE_API_KEY='abc123'\n")), 'abc123');

  // Comments, blank lines and unrelated entries must not confuse the parse.
  const real = ['# my DSH keys', '', 'OTHER_KEY=zzz', 'TYPESAFE_API_KEY=abc123', 'ANOTHER=1'].join('\n');
  assert.equal(readApiKeyFromFile('k.env', read(real)), 'abc123');

  // CRLF is what Windows editors actually write.
  assert.equal(readApiKeyFromFile('k.env', read('OTHER=1\r\nTYPESAFE_API_KEY=abc123\r\n')), 'abc123');

  // Absent / unreadable / no matching line: all degrade to "no key", never a throw.
  // This runs on the turn-close path, so throwing here would break the turn.
  assert.equal(readApiKeyFromFile('missing', () => { throw new Error('ENOENT'); }), '');
  assert.equal(readApiKeyFromFile('k.env', read('')), '');
  assert.equal(readApiKeyFromFile('k.env', read('SOMETHING_ELSE=1')), '');
  assert.equal(readApiKeyFromFile('', read('TYPESAFE_API_KEY=abc123')), '');
});

test('the environment wins over the file, so a one-off export is not shadowed', () => {
  // Deliberately the OPPOSITE of dotenv's usual precedence. A key exported for one
  // run must not be silently overridden by a file left over from months ago: that
  // would send traffic to the wrong account, and nothing in the output would say so.
  const read = () => 'TYPESAFE_API_KEY=from-the-file';

  const fromEnv = resolveApiKey({ env: { TYPESAFE_API_KEY: 'from-the-env' }, filePath: 'k.env', readFile: read });
  assert.equal(fromEnv.key, 'from-the-env');
  assert.equal(fromEnv.source, 'environment');
  assert.equal(fromEnv.filePath, null);

  const fromFile = resolveApiKey({ env: {}, filePath: 'k.env', readFile: read });
  assert.equal(fromFile.key, 'from-the-file');
  assert.equal(fromFile.source, 'file');
  assert.equal(fromFile.filePath, 'k.env', 'the source path is reported, never the value');

  const none = resolveApiKey({ env: {}, filePath: 'k.env', readFile: () => { throw new Error('ENOENT'); } });
  assert.equal(none.key, '');
  assert.equal(none.source, 'none');
});

test('the key can never reach a log row, whichever field carries it', () => {
  // A key gets into a log by ACCIDENT: an upstream error quoting the header it
  // rejected, a request dump added while debugging. Nobody writes `log(key)`. So the
  // guard lives where every row must pass, not at the call sites.
  const KEY = 'apikey_0123456789abcdef0123456789abcdef_deadbeefdeadbeef';
  const lines = [];
  const log = new DecisionLog({ path: '', sink: (line) => lines.push(line), secret: KEY });

  log.write({ row: 'assessment', jev_error: { kind: 'http', message: `401 for Bearer ${KEY}` } });
  log.write({ row: 'assessment', note: `authorization: Bearer ${KEY}`, nested: { deep: [KEY] } });
  log.write({ row: 'assessment', clean: 'nothing to see' });

  assert.equal(lines.length, 3);
  for (const line of lines) {
    assert.ok(!line.includes(KEY), 'the key must not appear anywhere in a written row');
  }
  assert.match(lines[0], /\[redacted-key\]/);
  assert.equal(log.redactions, 2, 'each affected row is counted');
  assert.equal(lines[2].includes('[redacted-key]'), false, 'a clean row is untouched');

  // A short value is not treated as a secret: redacting it would mangle real words.
  const short = new DecisionLog({ path: '', sink: (line) => lines.push(line), secret: 'abc' });
  short.write({ row: 'x', text: 'abc is a common substring' });
  assert.equal(lines[3].includes('abc is a common substring'), true);
});

test('redactSecret scrubs every sink, not just the row writer', () => {
  // There are TWO sinks. DSH's own logger is the easy one to forget, because it is
  // not ours — and the Jev HTTP error path echoes up to 200 chars of the response
  // body, which an API may fill with the header it rejected.
  const KEY = 'apikey_0123456789abcdef0123456789abcdef_deadbeefdeadbeef';
  assert.equal(redactSecret(`boom Bearer ${KEY} boom`, KEY), 'boom Bearer [redacted-key] boom');
  assert.equal(redactSecret('nothing here', KEY), 'nothing here');
  // Two occurrences, both replaced — a single replace would leave the rest exposed.
  assert.equal(redactSecret(`${KEY} and ${KEY}`, KEY), '[redacted-key] and [redacted-key]');
  assert.equal(redactSecret(null, KEY), '');
  assert.equal(redactSecret('abc', 'abc'), 'abc', 'a short secret is left alone');
});

// ── log and ground truth ─────────────────────────────────────────────────────

test('classifyFollowup separates a correction from a normal continuation', () => {
  assert.equal(classifyFollowup('that still does not work').kind, 'user_reported_problem');
  assert.equal(classifyFollowup('现在还是报错').kind, 'user_reported_problem');
  assert.equal(classifyFollowup('never mind, forget it').kind, 'user_dismissed');
  assert.equal(classifyFollowup('算了').kind, 'user_dismissed');
  // The important negative: a satisfied user moving on is NOT a complaint.
  assert.equal(classifyFollowup('now add a test for the parser').kind, 'user_moved_on');
  assert.equal(classifyFollowup('').kind, 'no_followup');
});

test('judgeOutcome identifies the two disagreements that matter', () => {
  // We said finish, the user complained: we missed an unfinished turn.
  assert.equal(judgeOutcome({ action: 'finish' }, { kind: 'user_reported_problem' }).verdict, 'false_pass');
  // We blocked, the user dismissed us: our most expensive error.
  assert.equal(judgeOutcome({ action: 'continue' }, { kind: 'user_dismissed' }).verdict, 'false_block');
  // We blocked and it helped.
  assert.equal(
    judgeOutcome({ action: 'verify_more' }, { kind: 'user_moved_on' }, { fixedAfterBlock: true }).verdict,
    'good_block',
  );
  // We passed and the user simply continued.
  assert.equal(judgeOutcome({ action: 'finish' }, { kind: 'user_moved_on' }).verdict, 'true_pass');
});

test('DecisionLog writes one JSON object per line to the injected sink', () => {
  const lines = [];
  const log = new DecisionLog({ sink: (line) => lines.push(line) });
  assert.equal(log.write({ a: 1 }), true);
  assert.equal(log.write({ b: 2 }), true);
  assert.equal(lines.length, 2);
  assert.deepEqual(JSON.parse(lines[0]), { a: 1 });
  assert.ok(lines[0].endsWith('\n'));
});

test('DecisionLog swallows an unserialisable row instead of throwing', () => {
  const log = new DecisionLog({ sink: () => {} });
  const cyclic = {};
  cyclic.self = cyclic;
  assert.equal(log.write(cyclic), false);
  assert.equal(log.writeFailures, 1);
});

test('joinOutcomes attaches the outcome row to its assessment', () => {
  const rows = [
    { row: 'assessment', assessment_id: 'x', decision: { action: 'finish' } },
    { row: 'outcome', assessment_id: 'x', ground_truth: { verdict: 'true_pass' } },
    { row: 'assessment', assessment_id: 'y' },
  ];
  const joined = joinOutcomes(rows);
  assert.equal(joined.length, 2);
  assert.equal(joined[0].ground_truth.verdict, 'true_pass');
  assert.equal(joined[1].ground_truth, null);
});

// ── state store ──────────────────────────────────────────────────────────────

test('state store counts assessments per task and resets on a new task', () => {
  const store = createStateStore();
  store.beginTask('s1', 1);
  store.recordAssessment('s1', { fingerprint: 'f1', facts: {}, assessmentId: 'a1', decision: {}, shadow: true });
  assert.equal(store.get('s1').assessmentsUsed, 1);

  // Same task: keeps counting.
  store.beginTask('s1', 1);
  assert.equal(store.get('s1').assessmentsUsed, 1);

  // New task: budget resets.
  store.beginTask('s1', 2);
  assert.equal(store.get('s1').assessmentsUsed, 0);
});

test('state store tracks intervention per turn for the self-trigger guard', () => {
  const store = createStateStore();
  assert.equal(store.intervenedIn('s1', 5), false);
  store.markIntervened('s1', 5);
  assert.equal(store.intervenedIn('s1', 5), true);
  assert.equal(store.intervenedIn('s1', 6), false);
});

test('state store hands out a pending assessment exactly once', () => {
  const store = createStateStore();
  store.beginTask('s1', 1);
  store.recordAssessment('s1', { fingerprint: 'f', facts: {}, assessmentId: 'a1', decision: { action: 'finish' }, shadow: true });
  const first = store.takePending('s1');
  assert.equal(first.assessmentId, 'a1');
  assert.equal(store.takePending('s1'), null);
});

test('state store evicts the oldest session past its cap', () => {
  const store = createStateStore({ maxTracked: 2 });
  store.get('a');
  store.get('b');
  store.get('c');
  assert.equal(store.size, 2);
});

// ── git parsing ──────────────────────────────────────────────────────────────

test('parseStatus separates changed from untracked files', () => {
  const text = [' M src/a.js', '?? new-file.txt', 'A  src/added.js', 'R  old.js -> new.js'].join('\n');
  const { changed, untracked } = parseStatus(text);
  assert.deepEqual(untracked, ['new-file.txt']);
  assert.ok(changed.includes('src/a.js'));
  assert.ok(changed.includes('src/added.js'));
  // A rename keeps the path that exists on disk.
  assert.ok(changed.includes('new.js'));
  assert.ok(!changed.includes('old.js'));
});

test('parseStatus tolerates empty and null input', () => {
  assert.deepEqual(parseStatus(null), { changed: [], untracked: [] });
  assert.deepEqual(parseStatus(''), { changed: [], untracked: [] });
});

test('parseShortstat reads insertions and deletions', () => {
  const parsed = parseShortstat(' 3 files changed, 120 insertions(+), 8 deletions(-)');
  assert.equal(parsed.insertions, 120);
  assert.equal(parsed.deletions, 8);
  assert.deepEqual(parseShortstat(''), { insertions: null, deletions: null });
});

// ── end-to-end through the pure pipeline ─────────────────────────────────────

test('a turn that claims passing tests it never ran is caught without Jev', () => {
  // This is the scenario the plugin exists for, exercised end to end through
  // pure functions only: no DSH, no network.
  const events = [
    ...toolPair({ callId: 'c1', name: 'edit', args: { file_path: 'src/upload.js' }, resultText: 'ok' }),
    {
      type: 'assistant/message',
      data: {
        turn: 1,
        step: 2,
        message: { content: [{ type: 'text', text: 'Done. All tests pass and the build is clean.' }] },
      },
    },
  ];
  const derived = deriveEvidence(events, 1);

  assert.equal(derived.evidence.tests_run, false);
  assert.ok(derived.evidence.unverified_claims.length >= 1);

  const taskState = {
    ...state(),
    claim: derived.claim,
    commands: derived.commands,
    evidence: derived.evidence,
    activity: derived.activity,
  };

  const decision = decideWithoutJev({ state: taskState });
  assert.equal(decision.action, ACTIONS.VERIFY_MORE);
  assert.equal(decision.rule, 'P2_unverified_claim');

  // And the message we would send names the actual problem.
  assert.match(renderSteerMessage(decision, taskState), /no test command/);
});

test('an honest turn with real passing evidence passes through untouched', () => {
  const events = [
    ...toolPair({ callId: 'c1', name: 'edit', args: { file_path: 'src/upload.js' }, resultText: 'ok' }),
    ...toolPair({ callId: 'c2', name: 'pwsh', args: { command: 'npm test' }, resultText: 'ok\n' }),
    {
      type: 'assistant/message',
      data: { turn: 1, step: 3, message: { content: [{ type: 'text', text: 'Added retry; tests pass.' }] } },
    },
  ];
  const derived = deriveEvidence(events, 1);
  assert.equal(derived.evidence.tests_run, true);
  assert.equal(derived.evidence.tests_passed, true);
  assert.deepEqual(derived.evidence.unverified_claims, []);

  const taskState = { ...state(), claim: derived.claim, commands: derived.commands, evidence: derived.evidence };
  // Jev agrees, and nothing in the facts contradicts it.
  assert.equal(decide({ state: taskState, probabilities: probs() }).action, ACTIONS.FINISH);
  // Even without Jev, there is nothing to object to.
  assert.equal(decideWithoutJev({ state: taskState }).action, ACTIONS.PASS);
});
