/**
 * Completion Supervisor — Jev client.
 *
 * A hand-written TypeSafe System One client. Deliberately dependency-free: this
 * module must be unit-testable in plain Node without DSH, without the TypeSafe
 * SDK, and without network access (tests inject `fetch`).
 *
 * WHY NOT THE OFFICIAL SDK
 * ------------------------
 * The official SDK pulls retry policy, model discovery, and error taxonomy we do
 * not use. This supervisor's whole contract is: send one batched request, get
 * seven probabilities back, or fail loudly so the caller can fail open. That is
 * ~60 lines of fetch. `fast-jev-compaction` reached the same conclusion and hand
 * writes its request too.
 *
 * THE CONTRACT THIS MODULE ENFORCES
 * ---------------------------------
 * Jev is NOT an LLM. It answers typed questions against a state:
 *   - `noul`   -> a yes/no probability in [0,1]
 *   - `choice` -> {choice, confidence, probabilities}
 *   - `score`  -> {score, confidence, probabilities}
 *
 * We use ONLY `noul`, seven of them, in ONE request. Asking several narrow
 * questions in one call is the whole economic argument for this plugin: Foreman
 * asks nine Nouls per assessment, fast-jev-compaction asks two per tool call.
 *
 * VALIDATION IS STRICT ON PURPOSE
 * -------------------------------
 * Any deviation throws. There are no defaults and no clamping of garbage:
 *   - a missing answer   -> throw
 *   - a non-number       -> throw
 *   - NaN / Infinity     -> throw  (NOT clamped: clamping would disguise a bad
 *                                    response as confident, which could cause a
 *                                    false block)
 *   - out of [0,1]       -> clamped (a tiny numeric overshoot is harmless)
 *
 * The caller (index.js) turns every throw into fail-open: log it, do not steer.
 * Jev must never become a single point of failure.
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { JEV_QUESTIONS, JEV_QUESTION_NAMES } from './questions.js';

export const SYSTEM_ONE_URL = 'https://api.typesafe.ai/v1/systemone';
export const DEFAULT_MODEL = 'jev-latest';

/**
 * How long to wait for one assessment before giving up.
 *
 * 5000ms, not the 3000ms this started at. That is a deliberate calibration-phase
 * value and it is expected to change:
 *
 *   - During calibration the sample matters more than the ceiling. One of the first
 *     four real calls timed out at 3000ms, which does not merely lose a row — a
 *     timeout is a NON-observation, and if slow responses correlate with large or
 *     ambiguous states (the interesting ones), raising the cutoff is also a bias
 *     correction, not just a bigger number.
 *   - During intervention the ceiling matters more than the sample, because this
 *     timeout sits on the turn-close path and the user waits for it. That value must
 *     come from the measured latency distribution (P50/P95/P99), not from a guess.
 *
 * So expect this to come DOWN when `shadowMode` goes false. Raising it now is the
 * cheap direction: it only costs wall-clock in a phase where nothing is blocked.
 */
export const DEFAULT_TIMEOUT_MS = 5000;

/**
 * Jev's documented hard limits, from `../jev-supervisor/01-community-teardown.md` — a
 * SIBLING project directory rather than this package, hence the explicit path.
 */
export const MAX_QUESTION_TOKENS = 32000;

export class JevError extends Error {
  constructor(message, { kind = 'unknown', status, cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'JevError';
    this.kind = kind;
    if (status !== undefined) this.status = status;
  }
}

/**
 * Build the HTTP request for one assessment.
 *
 * @param {{apiKey: string, model?: string, baseUrl?: string}} params
 * @param {object} state - the compressed TaskState.
 * @returns {{url: string, init: {method: string, headers: object, body: string}}}
 */
export function buildJevRequest(params, state) {
  const apiKey = typeof params?.apiKey === 'string' ? params.apiKey.trim() : '';
  if (!apiKey) throw new JevError('TYPESAFE_API_KEY is not configured', { kind: 'no_key' });
  return {
    url: params.baseUrl ?? SYSTEM_ONE_URL,
    init: {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: params.model ?? DEFAULT_MODEL,
        state,
        questions: JEV_QUESTIONS,
      }),
    },
  };
}

/**
 * Validate one `noul` answer.
 *
 * Absent / non-number / non-finite all throw — we refuse to invent a probability
 * for a question Jev did not answer, because a fabricated 0.0 would read as
 * "confidently not done" and could block a turn that was actually fine.
 *
 * @param {unknown} answer
 * @param {string} name
 * @returns {number} probability, clamped into [0,1].
 */
export function noulAnswer(answer, name) {
  if (answer === null || typeof answer !== 'object') {
    throw new JevError(`missing answer for "${name}"`, { kind: 'malformed' });
  }
  const raw = /** @type {{noul?: unknown}} */ (answer).noul;
  if (typeof raw !== 'number') {
    throw new JevError(`answer "${name}" is not a number (got ${typeof raw})`, { kind: 'malformed' });
  }
  if (!Number.isFinite(raw)) {
    throw new JevError(`answer "${name}" is not finite (${String(raw)})`, { kind: 'malformed' });
  }
  return Math.min(1, Math.max(0, raw));
}

/**
 * Parse and validate a response body.
 *
 * @param {number} status
 * @param {boolean} ok
 * @param {string} text
 * @returns {{probabilities: Record<string, number>, requestId: string|null, usage: object|null, model: string|null}}
 */
export function parseJevResponse(status, ok, text) {
  if (!ok) {
    throw new JevError(`Jev request failed (HTTP ${status}): ${String(text).slice(0, 200)}`, {
      kind: 'http',
      status,
    });
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    throw new JevError('Jev returned malformed JSON', { kind: 'malformed', cause });
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new JevError('Jev response is not an object', { kind: 'malformed' });
  }
  const answers = parsed.answers;
  if (answers === null || typeof answers !== 'object' || Array.isArray(answers)) {
    throw new JevError('Jev response is missing an "answers" object', { kind: 'malformed' });
  }

  const probabilities = {};
  for (const name of JEV_QUESTION_NAMES) {
    probabilities[name] = noulAnswer(answers[name], name);
  }

  return {
    probabilities,
    requestId: typeof parsed.request_id === 'string' ? parsed.request_id : null,
    usage: parsed.usage !== null && typeof parsed.usage === 'object' ? parsed.usage : null,
    model: typeof parsed.model === 'string' ? parsed.model : null,
  };
}

/**
 * Run one assessment: build, send, validate, time out.
 *
 * The timeout is enforced with AbortSignal.timeout, so a hung socket cannot hold
 * the agent's turn open. Combined with the caller's own deadline this is the
 * latency ceiling that keeps Jev off the critical path in practice.
 *
 * @param {object} opts
 * @param {string} opts.apiKey
 * @param {object} opts.state
 * @param {number} [opts.timeoutMs]
 * @param {string} [opts.model]
 * @param {string} [opts.baseUrl]
 * @param {typeof fetch} [opts.fetchImpl] - injectable for tests.
 * @param {AbortSignal} [opts.signal] - the turn's signal.
 * @returns {Promise<{probabilities: object, requestId: string|null, usage: object|null, model: string|null, modelRequested: string, latencyMs: number}>}
 */
export async function assess(opts) {
  const { apiKey, state, timeoutMs = DEFAULT_TIMEOUT_MS, signal } = opts;
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new JevError('no fetch implementation available', { kind: 'unavailable' });
  }

  // The alias we ASK for, kept separately from the id the API ANSWERS with. During
  // calibration the distinction is the whole point: thresholds derived under
  // `jev-latest` are only meaningful for the concrete version that alias pointed at,
  // and `jev-latest` is free to move under us. If the response names a version, that
  // is the one the logged probabilities belong to.
  const modelRequested = opts.model ?? DEFAULT_MODEL;
  const { url, init } = buildJevRequest({ apiKey, model: modelRequested, baseUrl: opts.baseUrl }, state);

  // Combine our own timeout with the caller's signal: whichever fires first wins.
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const combined = signal !== undefined && typeof AbortSignal.any === 'function'
    ? AbortSignal.any([signal, timeoutSignal])
    : timeoutSignal;

  const started = Date.now();
  let response;
  try {
    response = await fetchImpl(url, { ...init, signal: combined });
  } catch (cause) {
    const aborted = cause?.name === 'TimeoutError' || timeoutSignal.aborted;
    throw new JevError(
      aborted ? `Jev assessment timed out after ${timeoutMs}ms` : `Jev request failed: ${String(cause?.message ?? cause)}`,
      { kind: aborted ? 'timeout' : 'network', cause },
    );
  }

  let text;
  try {
    text = await response.text();
  } catch (cause) {
    throw new JevError('could not read the Jev response body', { kind: 'network', cause });
  }

  const parsed = parseJevResponse(response.status, response.ok === true, text);
  return { ...parsed, modelRequested, latencyMs: Date.now() - started };
}

/**
 * Read the API key from the environment, tolerating the common shapes.
 *
 * We accept a bare key, a `KEY=value` line, and surrounding quotes, because the
 * key is most often pasted into a dotenv file. Never log the return value.
 *
 * @param {Record<string,string|undefined>} [env]
 * @returns {string} the key, or '' when absent.
 */
export function readApiKeyFromEnv(env = process.env) {
  return parseKeyValue(env?.TYPESAFE_API_KEY);
}

/** Normalise one raw key value: strip a `NAME=`, then quotes, then whitespace. */
function parseKeyValue(raw) {
  if (typeof raw !== 'string') return '';
  let value = raw.trim();
  if (value.includes('=') && /^[A-Za-z_][A-Za-z0-9_]*\s*=/.test(value)) {
    value = value.slice(value.indexOf('=') + 1).trim();
  }
  if (
    (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
    (value.startsWith("'") && value.endsWith("'") && value.length > 1)
  ) {
    value = value.slice(1, -1).trim();
  }
  return value;
}

/**
 * Read the key from a dotenv file, or '' when there is nothing usable there.
 *
 * WHY THIS EXISTS, AND WHY IT IS NOT REDUNDANT WITH THE ENVIRONMENT
 * ----------------------------------------------------------------
 * The environment variable alone is not enough on DSH Desktop, and the way it
 * falls short is silent — which is the worst kind.
 *
 * `dsh-app-boot` exports a `loadEnv()` that calls `process.loadEnvFile('.env')`,
 * and its doc comment says "Load the optional gitignored `.env` from `dir`". That
 * promise is what makes "put it in `.env`" the natural instruction. But in the
 * shipped Desktop build that function is **defined and never called**: a recursive
 * search of the whole app tree finds exactly three references to `loadEnv`, all on
 * its own definition and export lines, and none of them a call site. So a `.env`
 * file placed next to the app does nothing, and a user who followed the README
 * would see `TYPESAFE_API_KEY present: false` with no explanation.
 *
 * Rather than document a caveat ("Desktop ignores .env"), the plugin reads the file
 * itself. That makes the instruction true regardless of which shell or launcher
 * started DSH, and it keeps the key out of the process environment, where it would
 * be inherited by every child process the agent spawns.
 *
 * Precedence is intentionally the opposite of dotenv's usual rule: the real
 * environment WINS. A key exported for a one-off run should not be shadowed by a
 * stale file left over from months ago — an accidental override there would send
 * traffic to the wrong account in a way that is very hard to notice.
 *
 * A missing file is not an error; unreadable or malformed content is tolerated the
 * same way, because a key we cannot parse must degrade to "no key" rather than
 * throw inside the turn-close path.
 *
 * @param {string} path
 * @param {(p: string) => string} [readFile] - injectable for tests.
 * @returns {string} the key, or '' when the file is absent or has none.
 */
export function readApiKeyFromFile(path, readFile) {
  if (typeof path !== 'string' || path.length === 0) return '';
  let text;
  try {
    text = (readFile ?? ((p) => readFileSync(p, 'utf8')))(path);
  } catch {
    return '';
  }
  if (typeof text !== 'string' || text.length === 0) return '';
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue;
    // Tolerate an `export ` prefix, which is common in shell-sourced dotenv files.
    const body = trimmed.startsWith('export ') ? trimmed.slice('export '.length).trim() : trimmed;
    const match = /^TYPESAFE_API_KEY\s*=(.*)$/.exec(body);
    if (match === null) continue;
    const value = parseKeyValue(match[1]);
    if (value.length > 0) return value;
  }
  return '';
}

/**
 * Resolve the key from all supported sources, and report WHICH one answered.
 *
 * The source matters operationally, not just for debugging: after a restart the
 * first question is "did the key I just set get picked up, or is this the old one?"
 * Reporting `environment` versus a file path answers that without ever printing the
 * key itself.
 *
 * @param {{env?: Record<string,string|undefined>, filePath?: string, readFile?: (p: string) => string}} [opts]
 * @returns {{key: string, source: 'environment'|'file'|'none', filePath: string|null}}
 */
export function resolveApiKey(opts = {}) {
  const env = opts.env ?? process.env;
  const filePath = opts.filePath ?? defaultKeyFilePath();

  const fromEnv = readApiKeyFromEnv(env);
  if (fromEnv.length > 0) return { key: fromEnv, source: 'environment', filePath: null };

  const fromFile = readApiKeyFromFile(filePath, opts.readFile);
  if (fromFile.length > 0) return { key: fromFile, source: 'file', filePath };

  return { key: '', source: 'none', filePath };
}

/**
 * Where the plugin looks for a key file.
 *
 * `DSH_TYPESAFE_KEY_FILE` wins when set, so a machine with an unusual layout is not
 * stuck with this default. Otherwise it sits beside the decision log, inside the
 * DSH home: a directory the user already owns, that no repository tracks, and that
 * a `git status` in a project checkout can never see.
 *
 * The basename is `.env` because that is the file the operator naturally reaches for
 * and the one the README already named — the difference is that this plugin actually
 * reads it, whereas the harness's own `.env` loader is never invoked in the shipped
 * Desktop build.
 *
 * @param {Record<string,string|undefined>} [env]
 * @returns {string}
 */
export function defaultKeyFilePath(env = process.env) {
  const override = env?.DSH_TYPESAFE_KEY_FILE;
  if (typeof override === 'string' && override.trim().length > 0) return override.trim();
  return join(homedir(), '.dsh', 'completion-supervisor', '.env');
}
