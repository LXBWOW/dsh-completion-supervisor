/**
 * PROBE what the TypeSafe API actually answers with, for two questions the log
 * cannot answer.
 *
 * WHY A LIVE CALL IS NEEDED
 * -------------------------
 * Two things decide whether a calibration is still valid, and neither is knowable
 * offline:
 *
 *   1. Does the response name a concrete model? If it does, thresholds bind to that
 *      version. If it does not, `jev-latest` is a moving target and any threshold is
 *      calibrated against something unnamed.
 *   2. Does the API accept the TaskState shape we send? A 400 here would mean every
 *      assessment in the log failed for a reason no row explains.
 *
 * The existing rows cannot answer (1): they were written before the field was recorded,
 * so "no model" and "the API named none" are indistinguishable in them. One live call
 * settles it.
 *
 * SAFETY
 * ------
 * The key is read from the same place the plugin reads it and is NEVER printed, not even
 * truncated. Only the response's structure is shown, plus the model id itself — which is
 * not a secret and is the entire point of the probe.
 *
 * Usage: node tools/probe-model-id.mjs
 */

import { resolveApiKey, SYSTEM_ONE_URL, DEFAULT_MODEL, DEFAULT_TIMEOUT_MS } from '../lib/jev.js';
import { JEV_QUESTIONS, QUESTION_SET_HASH } from '../lib/questions.js';

/**
 * A small but structurally faithful TaskState.
 *
 * Deliberately mirrors the real shape rather than sending a toy `{}`: a probe that sends
 * a shape the plugin never sends can pass while the real request fails, which is the same
 * trap as testing a reader against a hand-written fixture.
 */
const PROBE_STATE = {
  task_v: 2,
  goal: 'Run the test suite in the working directory and report the pass/fail counts.',
  claim: 'Done: the suite ran and all tests passed.',
  evidence: {
    tests_run: true,
    tests_passed: true,
    build_ok: null,
    lint_ok: null,
    error_results: [],
    unverified_claims: [],
  },
  repo: { available: false, changed_files: [], untracked: [], insertions: null, deletions: null },
  commands: [{ kind: 'test', exit: 0, exit_attributable: true, cmd: 'npm test' }],
  activity: { tool_calls_this_turn: 1, material: 1, message_only: 0 },
};

/** Show a value only when it is short and not sensitive; otherwise show its type. */
function describe(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `array(${value.length})`;
  if (typeof value === 'object') return `object{${Object.keys(value).join(', ')}}`;
  if (typeof value === 'string') return value.length <= 80 ? JSON.stringify(value) : `string(${value.length} chars)`;
  return String(value);
}

async function main() {
  const { key, source } = resolveApiKey();
  if (key.length === 0) {
    console.log('no TYPESAFE_API_KEY resolved — nothing to probe');
    console.log('  (checked the environment, then ~/.dsh/completion-supervisor/.env)');
    return 1;
  }

  console.log(`key: resolved from ${source} (value deliberately not shown, length ${key.length})`);
  console.log(`endpoint: ${SYSTEM_ONE_URL}`);
  console.log(`requested model alias: ${DEFAULT_MODEL}`);
  console.log(`question set hash: ${QUESTION_SET_HASH}  (${Object.keys(JEV_QUESTIONS).length} questions)`);
  console.log('');
  console.log('sending one real assessment request...');

  const started = Date.now();
  let response;
  try {
    response = await fetch(SYSTEM_ONE_URL, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: DEFAULT_MODEL, state: PROBE_STATE, questions: JEV_QUESTIONS }),
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });
  } catch (error) {
    const aborted = error?.name === 'TimeoutError';
    console.log('');
    console.log(`REQUEST FAILED: ${aborted ? `timed out after ${DEFAULT_TIMEOUT_MS}ms` : String(error?.message ?? error)}`);
    console.log('  -> this is the same path the plugin fail-opens on, so the plugin would');
    console.log('     log a row and let the turn end. Nothing is broken; the call did not land.');
    return 1;
  }
  const elapsed = Date.now() - started;
  const text = await response.text();

  console.log(`HTTP ${response.status} (${response.ok ? 'ok' : 'NOT OK'}) in ${elapsed}ms`);
  console.log('');

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    console.log('response body is not JSON. First 300 characters:');
    console.log(`  ${text.slice(0, 300)}`);
    return 1;
  }

  console.log('top-level response fields:');
  for (const [name, value] of Object.entries(parsed ?? {})) {
    console.log(`  ${name.padEnd(16)} ${describe(value)}`);
  }
  console.log('');

  // Question 1: does the API name a model?
  const model = typeof parsed?.model === 'string' ? parsed.model : null;
  if (model === null) {
    console.log('MODEL: the response does NOT name a model.');
    console.log('  -> calibration stays bound to the moving alias `jev-latest`.');
    console.log('  -> before intervention, either find a pinnable version id from TypeSafe or');
    console.log('     accept re-calibration whenever probabilities drift.');
  } else {
    console.log(`MODEL: the response names "${model}".`);
    console.log('  -> pin to this concrete id for calibration, so a later alias move shows up');
    console.log('     as a changed id on new rows instead of silently invalidating thresholds.');
  }
  console.log('');

  // Question 2: did it accept the state, and did it answer all seven?
  const answers = parsed?.answers;
  if (answers === null || typeof answers !== 'object') {
    console.log('ANSWERS: missing. The response would be rejected as malformed by the plugin.');
    return 1;
  }
  const missing = Object.keys(JEV_QUESTIONS).filter((name) => answers[name] === undefined);
  console.log(`ANSWERS: ${Object.keys(answers).length} returned, ${missing.length} of the seven missing`);
  for (const [name, answer] of Object.entries(answers)) {
    console.log(`  ${name.padEnd(26)} ${describe(answer)}`);
  }
  if (missing.length > 0) {
    console.log(`  MISSING: ${missing.join(', ')} — the plugin rejects a partial response on purpose,`);
    console.log('  because defaulting a missing probability could read as "confidently done".');
  }
  console.log('');

  const usage = parsed?.usage;
  if (usage !== null && typeof usage === 'object') {
    console.log('usage:');
    for (const [name, value] of Object.entries(usage)) console.log(`  ${name.padEnd(16)} ${describe(value)}`);
  }

  // A sanity reading on the probe state itself: Jev should call a passing suite with a
  // matching claim "ready", and if it does not, the questions are misaligned even for the
  // case they were designed around. That is worth knowing before any threshold work.
  const ready = answers.ready_to_finish?.noul;
  if (typeof ready === 'number') {
    console.log('');
    console.log(`SANITY: on a clean, verified, honestly-described turn, ready_to_finish = ${ready}`);
    console.log(
      ready >= 0.5
        ? '  -> the question set reads its own best case as done. The low scores in the log are then'
        : '  -> the question set reads even its best case as NOT done. That points at the questions',
    );
    console.log(
      ready >= 0.5
        ? '     about the tasks, not about the model.'
        : '     themselves rather than at the states being judged.',
    );
  }

  return 0;
}

process.exitCode = await main();
