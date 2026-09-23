/**
 * Completion Supervisor — read-only health summary over the assessment log.
 *
 * WHY THIS EXISTS
 * ---------------
 * The decision log is the only place that shows whether the supervisor is working, and reading it
 * by hand means parsing rows that are several kilobytes of JSON each. That is enough friction that
 * a real fault — a Jev outage, a restarted process running stale code, a steer budget being
 * exceeded — waits for a dedicated analysis session instead of being noticed the day it happens.
 * This module turns the last N rows into the handful of numbers that answer "is it working right
 * now?".
 *
 * WHAT IT IS NOT
 * --------------
 * It is a READER. It computes and prints. It writes nothing, calls no model, touches no
 * supervisor state, and holds no opinion about whether a particular steer was correct.
 *
 * The distinction matters most for the one number a reader wants first: "was that steer a false
 * positive?". That question needs the MEANING of the task, which lives in the conversation and not
 * in the log, so this module reports `recent_steer_needs_review` and never `false_positive`. A
 * deterministic counter that claimed to know would be worse than no counter at all, because it
 * would be believed.
 *
 * Every verdict below is therefore a rule over fields literally present in the rows — a build id
 * that differs, a failure that happened, a budget that was exceeded. Nothing is inferred.
 *
 * ROWS WRITTEN BEFORE `log_v 2` CARRY FEWER FIELDS
 * ------------------------------------------------
 * `would_steer`, `will_steer`, `steer_suppressed`, `gray_zone` and `advisory_rule` were added with
 * `log_v 2`. Older rows do not have them. A reader that only counted `would_steer: true` would
 * report "0 suppressed" for a window in which 42 turns were in fact suppressed by shadow mode —
 * confidently wrong, and in the flattering direction. So `wantedToAct()` below re-derives the
 * pre-`log_v 2` answer from `action` + `enforce`, which those rows DO carry, and the report prints
 * which versions the window actually spans so the reader can see the mixture.
 */

import { closeSync, openSync, readSync, statSync } from 'node:fs';

import { ACTIONS } from './policy.js';

/** Bump when the report's fields or verdict rules change. */
export const HEALTH_VERSION = 1;

/** How many assessments the summary covers unless the caller says otherwise. */
export const DEFAULT_HEALTH_LIMIT = 50;

/**
 * Ceiling on `limit`. Not a performance limit — reading is cheap and bounded by `TAIL_BYTES` — but
 * a readability one: a "summary" that spans thousands of rows is a different tool.
 */
export const MAX_HEALTH_LIMIT = 500;

/**
 * How many bytes of the tail to read.
 *
 * The file is append-only and grows without bound, so the whole file is never read. At the
 * measured ~3 KB per row this holds roughly 2 700 rows, which is several times `MAX_HEALTH_LIMIT`
 * of assessments even after outcome rows are filtered out.
 */
const TAIL_BYTES = 8 * 1024 * 1024;

/** Characters of `goal` / `claim` shown per line. */
const EXCERPT_CHARS = 90;

/** How many steers the compact list shows. */
const RECENT_STEERS_SHOWN = 5;

/** The window used by the "Jev is failing" rule, measured back from the newest row. */
const FAILURE_WINDOW = 20;

/** Failures within `FAILURE_WINDOW` that raise a check. Two is already abnormal: the steady state is zero. */
const FAILURE_CHECK_AT = 2;

/** Consecutive failures at the END of the window that raise a check. */
const TRAILING_FAILURE_CHECK_AT = 5;

/** Actions that mean "the policy is content with this turn". */
const PASS_LIKE_ACTIONS = Object.freeze(new Set([ACTIONS.FINISH, ACTIONS.PASS]));

/** First words of the two `P4` reason strings, used to tell its two sides apart. See `steerLabel`. */
const P4_BLOCKING_PREFIX = 'blocking issue';
const P4_REQUIREMENTS_PREFIX = 'requirements';

/**
 * Coerce the `limit` argument.
 *
 * The tool schema cannot express bounds — DSH's supported JSON-schema subset is
 * `type/oneOf/properties/required/additionalProperties/items/enum/const` and rejects `minimum` /
 * `maximum` outright, which would fail the plugin at load time — so the clamp lives here.
 *
 * @param {unknown} value
 * @returns {number}
 */
export function clampLimit(value) {
  if (value === null || value === undefined || value === '') return DEFAULT_HEALTH_LIMIT;
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric)) return DEFAULT_HEALTH_LIMIT;
  return Math.max(1, Math.min(MAX_HEALTH_LIMIT, Math.floor(numeric)));
}

/**
 * Read the tail of a JSONL log without ever throwing.
 *
 * A missing file, an unreadable file, a row torn by a crash mid-write and a genuinely malformed
 * row are four different facts and are reported as four different fields. Collapsing them into
 * "read failed" is what makes a monitor useless exactly when it is needed.
 *
 * @param {string} path
 * @param {{maxBytes?: number}} [options]
 * @returns {{rows: object[], badLines: number, tornTail: boolean, missing: boolean, unreadable: boolean, fileBytes: number, scannedAll: boolean}}
 */
export function readLogTail(path, options = {}) {
  const maxBytes =
    Number.isFinite(options.maxBytes) && options.maxBytes > 0 ? options.maxBytes : TAIL_BYTES;
  const result = {
    rows: [],
    badLines: 0,
    tornTail: false,
    missing: false,
    unreadable: false,
    fileBytes: 0,
    scannedAll: true,
  };
  if (typeof path !== 'string' || path.length === 0) {
    result.missing = true;
    return result;
  }

  let size;
  try {
    const stats = statSync(path);
    if (!stats.isFile()) {
      result.missing = true;
      return result;
    }
    size = stats.size;
  } catch {
    // ENOENT and a permissions failure are not worth separating here: both mean "no rows to
    // read", and the caller reports the path so the reader can look.
    result.missing = true;
    return result;
  }
  result.fileBytes = size;
  if (size === 0) return result;

  const start = Math.max(0, size - maxBytes);
  result.scannedAll = start === 0;

  let text;
  try {
    const fd = openSync(path, 'r');
    try {
      const buffer = Buffer.allocUnsafe(size - start);
      const read = readSync(fd, buffer, 0, buffer.length, start);
      text = buffer.subarray(0, read).toString('utf8');
    } finally {
      closeSync(fd);
    }
  } catch {
    result.unreadable = true;
    return result;
  }

  // Starting at a byte offset usually lands mid-row. That fragment is not malformed input, so it
  // is dropped rather than counted as damage. A newline byte cannot occur inside a multi-byte
  // UTF-8 sequence, so slicing at the first one is always safe.
  if (start > 0) {
    const firstBreak = text.indexOf('\n');
    if (firstBreak === -1) return result;
    text = text.slice(firstBreak + 1);
  }

  const endedCleanly = text.endsWith('\n');
  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (line.length === 0) continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      // An unterminated final line is a write that was interrupted, not corruption. The two get
      // different verdicts because they call for different actions: one says "a process died
      // while appending", the other says "something is writing rows we cannot read".
      if (index === lines.length - 1 && !endedCleanly) result.tornTail = true;
      else result.badLines += 1;
      continue;
    }
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      result.rows.push(parsed);
    } else {
      result.badLines += 1;
    }
  }
  return result;
}

/** @returns {number|null} */
function finiteOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Collapse whitespace and cut to `max`, so one row stays on one line. */
function excerpt(text, max = EXCERPT_CHARS) {
  if (typeof text !== 'string') return '';
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}\u2026`;
}

/** `session-<uuid>#task2` -> `<8 hex>#task2`. Task keys are long and the prefix is noise in a list. */
function shortTask(key) {
  if (typeof key !== 'string' || key.length === 0) return '<unknown>';
  const hash = key.indexOf('#');
  const head = hash === -1 ? key : key.slice(0, hash);
  const tail = hash === -1 ? '' : key.slice(hash);
  return `${head.replace(/^session-/, '').slice(0, 8)}${tail}`;
}

/** Nearest-rank percentile over an already-sorted array. */
function percentile(sorted, q) {
  if (sorted.length === 0) return null;
  const rank = Math.ceil(q * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
}

/** `2026-09-20T17:31:00.016Z` -> `2026-09-20T17:31:00Z` for column-style output. */
function shortTime(value) {
  return typeof value === 'string' && value.length >= 19 ? `${value.slice(0, 19)}Z` : String(value ?? '');
}

/**
 * Did the POLICY want to interrupt this turn?
 *
 * Rows written from `log_v 2` onwards carry the answer directly. Older rows do not, and the
 * fallback reproduces exactly what the writer computed (`policyWantsToAct && enforce !== false`)
 * from the two fields those rows do carry. Without this, a shadow-phase window reports zero
 * suppressions and reads as "nothing ever wanted to fire".
 *
 * @param {object} row
 * @returns {boolean}
 */
function wantedToAct(row) {
  const decision = row?.decision;
  if (decision === null || typeof decision !== 'object') return false;
  if (typeof decision.would_steer === 'boolean') return decision.would_steer;
  const acts = !PASS_LIKE_ACTIONS.has(decision.action);
  return acts && decision.enforce !== false;
}

/**
 * The label a steered row is counted under.
 *
 * `P4_requirements_unmet` covers two different triggers — requirements scored clearly unmet, or a
 * blocker scored clearly present — and they are worth separating: one says the work is missing,
 * the other says something recorded still stands in its way.
 *
 * The side is read from the reason string, which `policy.js` composes, rather than re-derived from
 * the probabilities. Re-deriving would have to apply TODAY's thresholds to rows written under
 * yesterday's, and would mislabel every `policy_v 1` row (`req < 0.40` then, `req < 0.30` now).
 * The prefix match is therefore deliberate; an unrecognised reason degrades to the bare rule name
 * instead of guessing.
 *
 * @param {object} row
 * @returns {string}
 */
function steerLabel(row) {
  const rule =
    typeof row?.decision?.rule === 'string' && row.decision.rule.length > 0
      ? row.decision.rule
      : 'unknown';
  if (rule !== 'P4_requirements_unmet') return rule;
  const reason = typeof row?.decision?.reason === 'string' ? row.decision.reason : '';
  if (reason.startsWith(P4_BLOCKING_PREFIX)) return 'P4_requirements_unmet (blocking)';
  if (reason.startsWith(P4_REQUIREMENTS_PREFIX)) return 'P4_requirements_unmet (requirements)';
  return 'P4_requirements_unmet (side not recorded)';
}

/** Which Jev failure a row records. `no_key` is a configuration fault, not an outage. */
function failureKind(row) {
  const kind = row?.jev_error?.kind;
  return typeof kind === 'string' && kind.length > 0 ? kind : 'unknown';
}

/**
 * Aggregate a list of parsed rows into the report the renderer prints.
 *
 * Pure: no file access, no clock, no randomness. `parse` and `runtime` are passed in so a test can
 * drive every verdict without touching a real log.
 *
 * @param {object[]} rows - parsed JSONL rows, any mix of `assessment` and `outcome`.
 * @param {object} [opts]
 * @param {number} [opts.limit]
 * @param {{buildId?: string, shadow?: boolean, path?: string}} [opts.runtime]
 * @param {{missing?: boolean, unreadable?: boolean, badLines?: number, tornTail?: boolean, fileBytes?: number, scannedAll?: boolean}} [opts.parse]
 * @returns {object}
 */
export function summarise(rows, opts = {}) {
  const limit = clampLimit(opts.limit ?? DEFAULT_HEALTH_LIMIT);
  const runtime = opts.runtime ?? {};
  const parse = opts.parse ?? {};

  const assessments = Array.isArray(rows)
    ? rows.filter((row) => row !== null && typeof row === 'object' && row.row === 'assessment')
    : [];
  const window = assessments.slice(-limit);
  const newest = window.length > 0 ? window[window.length - 1] : null;

  const tasks = new Set();
  const models = new Set();
  const failureKinds = new Map();
  const suppressionKinds = new Map();
  const advisoryHits = new Map();
  const ruleLabels = new Map();
  const steerPerTask = new Map();
  const steerRows = [];
  const latencies = [];

  let jevSuccesses = 0;
  let wanted = 0;
  let steers = 0;
  let suppressed = 0;
  let grayZone = 0;
  let advisoryP6 = 0;
  let overBudget = 0;

  for (const row of window) {
    const decision = row.decision ?? {};
    const taskKey =
      typeof row.task_key === 'string' && row.task_key.length > 0 ? row.task_key : '<none>';
    tasks.add(taskKey);

    if (typeof row.jev?.model === 'string' && row.jev.model.length > 0) models.add(row.jev.model);

    if (row.jev === null || row.jev === undefined) {
      const kind = failureKind(row);
      failureKinds.set(kind, (failureKinds.get(kind) ?? 0) + 1);
    } else {
      jevSuccesses += 1;
      // Only successful calls contribute to the latency distribution. A timeout would add its
      // full timeout value, which is a measurement of the timeout setting, not of the service.
      const ms =
        finiteOrNull(row.latency_ms?.jev) ??
        finiteOrNull(row.latency_ms?.total) ??
        finiteOrNull(row.latency_ms);
      if (ms !== null && ms >= 0) latencies.push(ms);
    }

    if (decision.gray_zone === true) grayZone += 1;

    const advisory = decision.advisory_rule;
    if (typeof advisory === 'string' && advisory.length > 0) {
      advisoryHits.set(advisory, (advisoryHits.get(advisory) ?? 0) + 1);
      if (advisory === 'P6_evidence_mismatch') advisoryP6 += 1;
    }

    if (!wantedToAct(row)) continue;
    wanted += 1;

    if (decision.will_steer !== true) {
      suppressed += 1;
      const kind =
        typeof decision.steer_suppressed === 'string' && decision.steer_suppressed.length > 0
          ? decision.steer_suppressed
          : row.shadow === true
            ? 'shadow_mode'
            : 'not_acted_on';
      suppressionKinds.set(kind, (suppressionKinds.get(kind) ?? 0) + 1);
      continue;
    }

    steers += 1;
    const label = steerLabel(row);
    ruleLabels.set(label, (ruleLabels.get(label) ?? 0) + 1);
    steerPerTask.set(taskKey, (steerPerTask.get(taskKey) ?? 0) + 1);

    const usedBefore = finiteOrNull(row.steers_used_before);
    const cap = finiteOrNull(row.max_steers_per_task);
    if (usedBefore !== null && cap !== null && usedBefore >= cap) overBudget += 1;

    steerRows.push({
      at: typeof row.at === 'string' ? row.at : null,
      task: shortTask(taskKey),
      rule: String(decision.rule ?? 'unknown'),
      requirements: finiteOrNull(row.jev?.probabilities?.requirements_satisfied),
      blocking: finiteOrNull(row.jev?.probabilities?.blocking_issue_remaining),
      gray: decision.gray_zone === true,
      goal: excerpt(row.asked?.goal),
      claim: excerpt(row.asked?.claim),
    });
  }

  const lastWith = (pick) => {
    for (let index = window.length - 1; index >= 0; index -= 1) {
      const value = pick(window[index]);
      if (value !== null && value !== undefined && value !== '') return value;
    }
    return null;
  };
  const distinctIn = (pick) => {
    const seen = new Set();
    for (const row of window) {
      const value = pick(row);
      if (value !== null && value !== undefined && value !== '') seen.add(String(value));
    }
    return [...seen].sort();
  };

  const head = {
    mode:
      typeof runtime.shadow === 'boolean'
        ? runtime.shadow
          ? 'SHADOW'
          : 'INTERVENTION'
        : 'UNKNOWN',
    build: typeof runtime.buildId === 'string' && runtime.buildId.length > 0 ? runtime.buildId : null,
    buildLogged: lastWith((row) => (typeof row.build_id === 'string' ? row.build_id : null)),
    policy: lastWith((row) => finiteOrNull(row.policy_v)),
    taskState: lastWith((row) => finiteOrNull(row.task_v)),
    logVersion: lastWith((row) => finiteOrNull(row.log_v)),
    jevModel: lastWith((row) => (typeof row.jev?.model === 'string' ? row.jev.model : null)),
    questionSetHash: lastWith((row) =>
      typeof row.question_set_hash === 'string' ? row.question_set_hash : null,
    ),
  };

  const sorted = [...latencies].sort((a, b) => a - b);
  const latency = {
    samples: sorted.length,
    avg: sorted.length === 0 ? null : Math.round(sorted.reduce((sum, v) => sum + v, 0) / sorted.length),
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    max: sorted.length === 0 ? null : sorted[sorted.length - 1],
  };

  const mixed = {
    policy: distinctIn((row) => finiteOrNull(row.policy_v)),
    taskState: distinctIn((row) => finiteOrNull(row.task_v)),
    logVersion: distinctIn((row) => finiteOrNull(row.log_v)),
    mode: distinctIn((row) => (typeof row.shadow === 'boolean' ? (row.shadow ? 'shadow' : 'intervention') : null)),
  };

  // Failures near the end of the window, counted separately from the window total. An outage that
  // ended three days ago is history; one inside the last twenty rows is happening now, and only
  // the second is a reason to look today.
  const recentWindow = window.slice(-FAILURE_WINDOW);
  const recentFailureKinds = new Map();
  let last20Failures = 0;
  for (const row of recentWindow) {
    if (row.jev === null || row.jev === undefined) {
      last20Failures += 1;
      const kind = failureKind(row);
      recentFailureKinds.set(kind, (recentFailureKinds.get(kind) ?? 0) + 1);
    }
  }
  // Consecutive failures at the very end: "the last few turns all went unsupervised" is a
  // stronger statement than any rate, because it is true regardless of how long the window is.
  let trailingFailures = 0;
  for (let index = window.length - 1; index >= 0; index -= 1) {
    if (window[index].jev === null || window[index].jev === undefined) trailingFailures += 1;
    else break;
  }

  // A differing build id has two completely different causes, and only one of them is a fault.
  //
  // After a rebuild and a restart, the newest row on disk was written by whatever ran BEFORE this
  // process until the first turn of this session is assessed. Reporting that as a check would light
  // up on every fresh start and teach the reader to ignore the one verdict that catches a genuinely
  // stale process.
  //
  // The separator is THIS PROCESS's start time, not the build's. The obvious-looking alternative —
  // "a row newer than the build cannot have come from an older build" — is wrong, and was wrong in
  // the field: an old process keeps writing rows after a new build lands, because nothing restarts
  // it when sources change. That version fired immediately after the very restart meant to clear
  // it, on a row written 58 seconds after the build and 40 seconds before the new process started.
  //
  // Start time IS sound, for a reason that does not depend on timing luck: every row this process
  // writes carries this build's id. So a row older than the process cannot be ours, and is normal;
  // a row written AFTER we started that names a different id means something else is writing to
  // this log, which is the fault worth reporting.
  const buildMismatch =
    head.build !== null && head.buildLogged !== null && head.buildLogged !== head.build;
  let buildVerdict = 'match';
  if (buildMismatch) {
    const startedAt = Date.parse(runtime.startedAt ?? '');
    const newestAt = newest !== null && typeof newest.at === 'string' ? Date.parse(newest.at) : Number.NaN;
    buildVerdict =
      Number.isFinite(startedAt) && Number.isFinite(newestAt) && newestAt < startedAt
        ? 'awaiting_rows'
        : 'stale_process';
  }

  const windowInfo = {
    limit,
    assessments: window.length,
    tasks: tasks.size,
    first: window.length > 0 && typeof window[0].at === 'string' ? window[0].at : null,
    last: newest !== null && typeof newest.at === 'string' ? newest.at : null,
    shadowRows: window.filter((row) => row.shadow === true).length,
  };

  const notes = [];
  if (buildVerdict === 'awaiting_rows') {
    notes.push(
      `no row has been written since this process started; the newest logged row is ${head.buildLogged} at ${shortTime(newest.at)} — expected until the first turn of this session is assessed`,
    );
  }

  const report = {
    healthVersion: HEALTH_VERSION,
    path: typeof runtime.path === 'string' ? runtime.path : null,
    head,
    buildVerdict,
    notes,
    window: windowInfo,
    mixed,
    jev: {
      successes: jevSuccesses,
      failures: window.length - jevSuccesses,
      failureKinds,
      models: [...models],
      last20Failures,
      last20Window: recentWindow.length,
      last20Kinds: recentFailureKinds,
      trailingFailures,
    },
    steer: {
      wanted,
      actual: steers,
      suppressed,
      suppressionKinds,
      grayZone,
      advisoryP6,
      advisoryHits,
      byRule: ruleLabels,
      perTask: steerPerTask,
      recent: steerRows.slice(-RECENT_STEERS_SHOWN),
      latest: steerRows.length > 0 ? steerRows[steerRows.length - 1] : null,
      overBudget,
    },
    latency,
    parse,
    checks: [],
    steerNeedsReview: steers > 0,
  };

  report.checks = buildChecks(report, newest, runtime, parse);
  report.health = report.checks.length === 0 ? 'OK' : 'CHECK';
  return report;
}

/**
 * The verdicts. Each one is a comparison over fields the rows actually carry — no model, no
 * inference, and no judgement about whether a decision was correct.
 *
 * @returns {string[]}
 */
function buildChecks(report, newest, runtime, parse) {
  const checks = [];
  const { head, window: win } = report;

  if (parse.missing === true) {
    checks.push(
      `no log file at ${report.path ?? '(path unknown)'} — either nothing has been assessed since it was created, or the path differs from the configured one`,
    );
  }
  if (parse.unreadable === true) {
    checks.push(`the log at ${report.path ?? '(path unknown)'} exists but could not be read`);
  }
  if (win.assessments === 0 && parse.missing !== true && parse.unreadable !== true) {
    checks.push('the log holds no assessment rows yet');
  }

  // A log written by something other than this process is the failure mode that produces perfectly
  // reasonable-looking output about code that is not the code under discussion, so it is checked
  // first. The lookalike — a fresh restart whose log simply predates it — is a note, not a check;
  // see `buildVerdict` for why the build's own timestamp cannot tell the two apart.
  if (report.buildVerdict === 'stale_process') {
    checks.push(
      `running build ${head.build} differs from the newest logged row (${head.buildLogged}), and that row was written AFTER this process started — something else is appending to this log`,
    );
  }
  if (
    newest !== null &&
    typeof newest.shadow === 'boolean' &&
    typeof runtime.shadow === 'boolean' &&
    newest.shadow !== runtime.shadow
  ) {
    const logged = newest.shadow ? 'SHADOW' : 'INTERVENTION';
    checks.push(
      `the newest logged row was written in ${logged} mode and this process is in ${head.mode} — a restart changed the mode`,
    );
  }

  // Failure check, measured over the tail of the window rather than the whole of it: an outage
  // that ended is history, an outage inside the last twenty rows is happening now.
  if (report.jev.last20Failures >= FAILURE_CHECK_AT) {
    checks.push(
      `${report.jev.last20Failures} Jev failure(s) in the last ${report.jev.last20Window} assessments (${describeKinds(report.jev.last20Kinds)}) — each one is fail-open, so those turns ended unsupervised`,
    );
  }
  if (report.jev.trailingFailures >= TRAILING_FAILURE_CHECK_AT) {
    checks.push(
      `the most recent ${report.jev.trailingFailures} assessments all have no Jev response — supervision is not running`,
    );
  }
  if (report.jev.successes === 0 && win.assessments > 0) {
    checks.push('no Jev response has ever succeeded in this window');
  }

  if (report.steerNeedsReview) {
    checks.push(
      `recent_steer_needs_review: true — ${report.steer.actual} steer(s) in the last ${win.assessments} assessments; whether a given one was CORRECT depends on the task's meaning, which this command cannot judge`,
    );
  }
  const repeated = [...report.steer.perTask.entries()].filter(([, count]) => count > 1);
  if (repeated.length > 0) {
    checks.push(
      `${repeated.length} task(s) were steered more than once: ${repeated
        .map(([key, count]) => `${shortTask(key)} x${count}`)
        .join(', ')}`,
    );
  }
  if (report.steer.overBudget > 0) {
    checks.push(
      `${report.steer.overBudget} steer(s) happened with the per-task steer budget already spent — maxSteersPerTask was violated`,
    );
  }

  if (parse.badLines > 0) {
    checks.push(
      `${parse.badLines} unparsable line(s) in the log tail — rows are being written that this reader cannot read`,
    );
  }
  // Checked against the recent tail rather than the whole window. A `no_key` row written before
  // the key was installed is history, and reporting it as a live problem on every run until it
  // scrolls out of the window is exactly the kind of false alarm that teaches a reader to ignore
  // the check. A key that is missing RIGHT NOW fails every new row, so the tail sees it anyway.
  if (report.jev.last20Kinds.has('no_key')) {
    checks.push(
      `${report.jev.last20Kinds.get('no_key')} of the last ${report.jev.last20Window} assessments ran with no TYPESAFE_API_KEY, so they were decided from deterministic facts alone`,
    );
  }
  if (report.jev.models.length > 1) {
    checks.push(
      `more than one Jev model answered in this window (${report.jev.models.join(', ')}) — probabilities from different models are not comparable, and any threshold calibrated on one does not transfer`,
    );
  }
  return checks;
}

/** `Map` of failure kinds -> `no_key 1, timeout 1`. */
function describeKinds(kinds) {
  if (kinds === null || kinds === undefined || kinds.size === 0) return 'kind not recorded';
  return [...kinds.entries()].map(([kind, count]) => `${kind} ${count}`).join(', ');
}

/**
 * Render a report as short plain text.
 *
 * Plain text on purpose: this lands in a transcript, so any structure beyond indentation and
 * dashes costs more than it explains.
 *
 * @param {object} report
 * @returns {string}
 */
export function render(report) {
  const lines = [];
  const put = (label, value) => lines.push(`${label.padEnd(22)}${value}`);

  lines.push('Completion Supervisor Health');
  lines.push('');
  lines.push(`Mode: ${report.head.mode}`);
  lines.push(
    `Build: ${
      report.head.build === null
        ? (report.head.buildLogged ?? 'unknown')
        : report.head.buildLogged !== null && report.head.buildLogged !== report.head.build
          ? `${report.head.build}  (newest logged row: ${report.head.buildLogged})`
          : report.head.build
    }`,
  );
  lines.push(`Policy: ${report.head.policy === null ? 'unknown' : `v${report.head.policy}`}`);
  lines.push(`Task state: ${report.head.taskState === null ? 'unknown' : `v${report.head.taskState}`}`);
  lines.push(`Jev model: ${report.head.jevModel ?? '(none recorded in this window)'}`);
  lines.push('');

  const win = report.window;
  lines.push(`Last ${win.limit} assessments`);
  lines.push('-'.repeat(19));
  put('Assessments:', String(win.assessments));
  put('Tasks:', String(win.tasks));
  if (win.first !== null && win.last !== null) {
    put('Window:', `${shortTime(win.first)} .. ${shortTime(win.last)}`);
  }

  // Only shown when the window actually spans a change, so the default case stays short. It
  // matters because a mixture is what makes several numbers below partial: `policy_v 1` rows
  // predate `would_steer`, `gray_zone` and `advisory_rule`, and `task_v 1-2` rows went to Jev
  // without the artifact and command-output evidence that later rows carry.
  const mixedParts = [];
  if (report.mixed.policy.length > 1) mixedParts.push(`policy_v ${report.mixed.policy.join(',')}`);
  if (report.mixed.taskState.length > 1) mixedParts.push(`task_v ${report.mixed.taskState.join(',')}`);
  if (report.mixed.logVersion.length > 1) mixedParts.push(`log_v ${report.mixed.logVersion.join(',')}`);
  if (report.mixed.mode.length > 1) {
    mixedParts.push(
      `mode shadow ${win.shadowRows} / intervention ${win.assessments - win.shadowRows}`,
    );
  }
  if (mixedParts.length > 0) put('Mixed in window:', mixedParts.join(' | '));

  put('Jev successes:', String(report.jev.successes));
  put(
    'Jev failures:',
    `${report.jev.failures}${report.jev.failures > 0 ? `  (${describeKinds(report.jev.failureKinds)}; fail-open, the turn ended unsupervised)` : ''}`,
  );
  put('Actual steers:', String(report.steer.actual));
  put(
    'Steer suppressed:',
    `${report.steer.suppressed}${report.steer.suppressed > 0 ? `  (${describeKinds(report.steer.suppressionKinds)})` : ''}`,
  );
  put('Gray-zone cases:', String(report.steer.grayZone));
  put('Advisory P6 hits:', String(report.steer.advisoryP6));
  lines.push('');

  if (report.latency.samples > 0) {
    put(
      'Jev latency:',
      `${report.latency.samples} samples | avg ${report.latency.avg} ms | p50 ${report.latency.p50} ms | p95 ${report.latency.p95} ms | max ${report.latency.max} ms`,
    );
    lines.push('');
  }

  if (report.steer.byRule.size > 0) {
    lines.push('Steers by reason:');
    for (const [label, count] of [...report.steer.byRule.entries()].sort((a, b) => b[1] - a[1])) {
      lines.push(`  ${label.padEnd(40)}${count}`);
    }
    lines.push('');
  }

  if (report.steer.recent.length > 0) {
    lines.push(`Recent steers (${report.steer.recent.length}):`);
    for (const steer of report.steer.recent) {
      lines.push(
        `  ${shortTime(steer.at)} | ${steer.task} | ${steer.rule} | req ${fmt(steer.requirements)} blk ${fmt(steer.blocking)} | gray ${steer.gray ? 'yes' : 'no'} | goal "${steer.goal}"`,
      );
    }
    lines.push('');
  }

  const latest = report.steer.latest;
  if (latest !== null) {
    lines.push('Most recent steer:');
    lines.push(`  time:  ${latest.at ?? 'unknown'}`);
    lines.push(`  task:  ${latest.task}`);
    lines.push(`  rule:  ${latest.rule}`);
    lines.push(
      `  req:   ${fmt(latest.requirements)}   blk: ${fmt(latest.blocking)}   gray_zone: ${latest.gray ? 'true' : 'false'}`,
    );
    lines.push(`  goal:  "${latest.goal}"`);
    lines.push(`  claim: "${latest.claim}"`);
    lines.push('');
  }

  for (const note of report.notes ?? []) {
    lines.push(`note: ${note}`);
    lines.push('');
  }

  if (report.parse.tornTail === true) {
    lines.push('note: the log ends in a partially written line (a write was interrupted); it was ignored, not counted as damage.');
    lines.push('');
  }

  if (report.health === 'OK') {
    lines.push('Health: OK');
  } else {
    lines.push('Health: CHECK');
    for (const check of report.checks) lines.push(`- ${check}`);
  }
  return lines.join('\n');
}

/** `0.28`, or `—` when the row did not carry the probability. */
function fmt(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(2) : '\u2014';
}

/**
 * The single entry point: read the log and build the report.
 *
 * Never throws for a log problem. The caller still wraps this, because the caller is a tool inside
 * a live session and a tool that throws takes down the answer rather than the process.
 *
 * @param {{path?: string, limit?: unknown, runtime?: object, maxBytes?: number}} opts
 * @returns {object}
 */
export function buildReport(opts = {}) {
  const tail = readLogTail(opts.path ?? '', opts.maxBytes === undefined ? {} : { maxBytes: opts.maxBytes });
  return summarise(tail.rows, {
    limit: opts.limit,
    runtime: { ...(opts.runtime ?? {}), path: opts.path ?? null },
    parse: {
      missing: tail.missing,
      unreadable: tail.unreadable,
      badLines: tail.badLines,
      tornTail: tail.tornTail,
      fileBytes: tail.fileBytes,
      scannedAll: tail.scannedAll,
    },
  });
}
