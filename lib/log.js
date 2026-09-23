/**
 * Completion Supervisor — decision log and ground-truth backfill.
 *
 * WHY GROUND TRUTH IS THE WHOLE POINT
 * -----------------------------------
 * A log of `{probabilities, decision}` can only answer "what WOULD different
 * thresholds have done?" — it re-runs the same inputs through a different policy
 * and reports a different count. That is threshold tuning, and it is necessary but
 * nowhere near sufficient: it cannot tell us whether the JUDGEMENT WAS RIGHT.
 * Blocking 40% of turns looks identical to a correct strict supervisor and to a
 * broken one.
 *
 * So every assessment is written as two rows over its lifetime:
 *
 *   row 1  the assessment    — what we saw, what Jev said, what we decided
 *   row 2  the outcome       — what actually happened next
 *
 * The outcome row is appended LATER, when the next user message arrives, and
 * linked by `assessment_id`. Nothing needs to be held in memory across a restart:
 * the link is the id, and the file is append-only.
 *
 * WHAT THE OUTCOME ROW RECORDS
 * ----------------------------
 *   - whether the user came back with a complaint (the strongest signal that a
 *     `finish` was wrong)
 *   - whether the agent, after a block, actually fixed the thing
 *   - whether the agent just repeated itself (a block whose wording failed)
 *   - whether the user dismissed our block (a false block, and the metric that
 *     matters most)
 *
 * Files are JSONL, one object per line, flushed per write. Append-only means a
 * crash loses at most the in-flight row, and concurrent sessions never corrupt
 * each other because each line is a complete, self-contained record.
 *
 * PRIVACY
 * -------
 * Commands, goals, and claims are agent-authored text from the user's own
 * workspace. They are recorded locally only. Nothing here is sent anywhere;
 * the only outbound network call in this plugin is to Jev, and it receives the
 * compressed TaskState (see taskstate.js).
 */

import { appendFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';

import { BUILD_ID } from './build.js';
import { redactSecret } from './redact.js';

/**
 * Bump when the log row shape changes. Readers must tolerate older rows.
 *
 * v2: rows carry the intervention record — `would_steer`, `will_steer`, `steer_suppressed`,
 *     `steers_used_before` and `max_steers_per_task` — and `decision` gained `enforce`,
 *     `advisory_rule`, `shadow_rule` and `gray_zone`.
 *
 *     v1 rows have no way to say "the policy wanted to act and a limit stopped it", and that becomes
 *     the most important question once steering is on: a quiet log then means either a healthy
 *     policy or an exhausted budget, and those two call for opposite responses.
 */
export const LOG_VERSION = 2;

/**
 * Truncate a string for logging, collapsing whitespace first.
 *
 * The log records texts the agent wrote, and those arrive with newlines and
 * indentation that make a single JSONL line hard to read later. Collapsing first
 * also means the truncation limit counts visible characters.
 *
 * @param {unknown} value
 * @param {number} limit
 * @returns {string|null}
 */
function bounded(value, limit) {
  if (typeof value !== 'string') return null;
  const flat = value.replace(/\s+/g, ' ').trim();
  if (flat.length === 0) return null;
  return flat.length <= limit ? flat : `${flat.slice(0, limit)}…`;
}

/**
 * The same bounding, but keeping the END of the text.
 *
 * For a completion claim the conclusion is at the end — the compression stages in
 * `taskstate.js` already read claims from the tail for that reason. Logging the head
 * instead would show a reader a fragment Jev never saw, which defeats the field's entire
 * purpose: `asked.claim` exists so an offline analysis can check what Jev was asked
 * about, and a field that misreports that is worse than no field.
 *
 * @param {unknown} value
 * @param {number} limit
 * @returns {string|null}
 */
function boundedTail(value, limit) {
  if (typeof value !== 'string') return null;
  const flat = value.replace(/\s+/g, ' ').trim();
  if (flat.length === 0) return null;
  return flat.length <= limit ? flat : `…${flat.slice(-limit)}`;
}

/**
 * Read one artifact list out of the state, as an array.
 *
 * Recorded as FULL LISTS rather than counts on purpose. The question this round of
 * calibration is answering is "what did Jev actually see", and a count cannot answer whether
 * the file the user asked for was in the list. Each list is already bounded inside
 * `artifacts.js`, so this cannot bloat a row.
 *
 * @param {object|null} state
 * @param {string} key
 * @returns {unknown[]}
 */
function artifactList(state, key) {
  const value = state?.activity?.[key];
  return Array.isArray(value) ? value : [];
}

/** Default log location. */
export function defaultLogPath() {
  return join(homedir(), '.dsh', 'completion-supervisor', 'assessments.jsonl');
}

/**
 * Re-exported from `redact.js`, which owns the implementation and documents why it is its
 * own module. Kept on this module's public surface so the guard can be reached from
 * wherever a sink is built, without any caller needing to know it moved.
 */
export { redactSecret };

/**
 * A line-oriented JSONL writer with an injectable sink for tests.
 */
export class DecisionLog {
  /**
   * @param {object} opts
   * @param {string} [opts.path]
   * @param {(line: string) => void} [opts.sink] - test hook; defaults to appending to `path`.
   * @param {string} [opts.secret] - a value that must never be written to the log.
   */
  constructor({ path, sink, secret } = {}) {
    this.path = path ?? defaultLogPath();
    this.sink = sink ?? null;
    this.writeFailures = 0;
    this.lastError = null;
    /**
     * The API key, when one is configured.
     *
     * This is the LAST line of defence and it is deliberately here rather than at the
     * call sites. A key reaches a log row only by accident — inside an error string
     * echoed from a networking layer, a request dump added while debugging, or an
     * upstream message that quotes the header it rejected. Nobody decides to write it.
     * So the guard belongs where every row must pass, not where someone remembered to
     * think about it: if the secret appears anywhere in a serialized row, it is
     * replaced before the row is written, whichever field carried it.
     */
    this.secret = typeof secret === 'string' && secret.length >= 16 ? secret : '';
    this.redactions = 0;
  }

  /** @returns {boolean} whether the log is writable in principle. */
  get enabled() {
    return this.sink !== null || this.path.length > 0;
  }

  /**
   * Replace the configured secret wherever it appears in a serialized row.
   * @param {string} line
   * @returns {string}
   */
  redact(line) {
    if (this.secret.length === 0) return line;
    const out = redactSecret(line, this.secret);
    if (out !== line) this.redactions += 1;
    return out;
  }

  /**
   * Append one row. Never throws: a broken log must not break a turn, so every
   * failure is swallowed and counted for diagnostics.
   * @param {object} row
   * @returns {boolean} whether the row was written.
   */
  write(row) {
    let line;
    try {
      line = this.redact(`${JSON.stringify(row)}\n`);
    } catch (error) {
      this.writeFailures += 1;
      this.lastError = `serialize: ${String(error?.message ?? error)}`;
      return false;
    }
    try {
      if (this.sink !== null) {
        this.sink(line);
        return true;
      }
      mkdirSync(dirname(this.path), { recursive: true });
      appendFileSync(this.path, line, 'utf8');
      return true;
    } catch (error) {
      this.writeFailures += 1;
      this.lastError = `append: ${String(error?.message ?? error)}`;
      return false;
    }
  }
}

/** Generate an id linking an assessment row to its later outcome row. */
export function newAssessmentId() {
  return randomUUID();
}

/**
 * Build the assessment row.
 *
 * `shadow` is recorded per row, not globally: a log spanning the shadow phase and
 * the intervention phase must stay analysable, and mixed rows are exactly what
 * the phase-1 analysis needs to compare.
 *
 * @param {object} args
 * @returns {object}
 */
export function assessmentRow({  assessmentId,
  sessionId,
  turn,
  cwd,
  shadow,
  trigger,
  fingerprint,
  fingerprintVersion,
  changedFields,
  state,
  stateTokens,
  stateStage,
  decision,
  jev,
  jevError,
  latency,
  costUsd,
  promptVersion,
  questionSetHash = null,
  taskStateVersion,
  taskKey = null,
  assessmentsUsedBefore = null,
  maxAssessments = null,
  wouldSteer = null,
  willSteer = null,
  steerSuppressed = null,
  steersUsedBefore = null,
  maxSteersPerTask = null,
}) {
  return {
    log_v: LOG_VERSION,
    build_id: BUILD_ID,
    row: 'assessment',
    assessment_id: assessmentId,
    at: new Date().toISOString(),

    session_id: sessionId,
    turn,
    cwd,
    trigger,
    shadow,

    // WHICH USER TASK THIS ASSESSMENT COUNTS AGAINST, and how much of the budget
    // was already spent when it ran.
    //
    // Without these two fields the per-task budget is unverifiable from the log:
    // a reader can see that N assessments happened, but not whether they were N
    // assessments of ONE task (the ceiling working as intended) or one assessment
    // each across N tasks (the reset working as intended). Those are opposite
    // diagnoses of the same row count, and the skip rows alone cannot separate
    // them, because a task that never tripped a rule writes no skip row at all.
    //
    // `assessments_used_before` is recorded rather than after: it is the value the
    // budget rule compared against, so it is the one that explains the decision.
    task_key: taskKey,
    assessments_used_before: assessmentsUsedBefore,
    max_assessments: maxAssessments,
    // How often we have already SPOKEN about this task, and the ceiling on that. Recorded beside the
    // assessment budget because the two are read together: `assessments_used_before` reaching
    // `max_assessments` means we will stop looking, while `steers_used_before` reaching
    // `max_steers_per_task` means we keep looking and stay quiet.
    steers_used_before: steersUsedBefore,
    max_steers_per_task: maxSteersPerTask,

    // Versioning: rows produced under different wording/thresholds must not be
    // pooled in an analysis, and these fields are how a reader separates them.
    //
    // `question_set_v` is the same value as `prompt_v` under a name that says what it
    // versions. Both are kept: `prompt_v` is what the existing rows already carry, and
    // renaming it would strand them. `question_set_hash` is the derived twin — see
    // questions.js for why a hand-bumped version number is not enough on its own.
    prompt_v: promptVersion,
    question_set_v: promptVersion,
    question_set_hash: questionSetHash ?? null,
    policy_v: decision?.policy_v ?? null,
    task_v: taskStateVersion,
    fingerprint_v: fingerprintVersion,

    fingerprint,
    changed_fields: changedFields,

    state_tokens_est: stateTokens,
    state_stage: stateStage,

    // WHAT WE ACTUALLY ASKED ABOUT: the user's requirement and the agent's own
    // closing claim, bounded.
    //
    // These two strings are the entire subject of the judgement — Jev is asked
    // whether the CLAIM satisfies the GOAL — yet until now neither was written to
    // the log. That made the most consequential defect in this plugin invisible
    // offline: `goal` was extracted from the first non-`plugin`/non-`tool` user-role
    // message, and a real session's second user-role message is an
    // `agent-instructions` block, so Jev could be asked whether a SYSTEM REMINDER
    // had been completed. Nothing in any row would have shown that. The fix
    // (an allow-list on `kind === 'user'`) is only verifiable from the log if the
    // log says what was sent.
    //
    // Bounded at 600 chars each — the same order as the compression stages applied
    // to the state before sending, so the row stays a summary rather than a copy of
    // the conversation. Enough to recognise a fabricated goal on sight.
    //
    // `claim` reads from the TAIL and gets a larger budget, because that is the form Jev
    // receives: the compression stages keep the end of a claim (the conclusion) and the
    // longest form we send is 800 characters. Recording the head at 600 — as this did —
    // would print a fragment that Jev was never shown, and this field exists precisely so
    // an analysis can verify what Jev judged. It did not: the live rows showed the model's
    // private reasoning, which is how a claim-extraction defect stayed invisible until the
    // reasoning blocks were inspected directly.
    asked: state
      ? {
          goal: bounded(state.goal, 600),
          claim: boundedTail(state.claim, 800),
        }
      : null,

    // Deterministic facts, recorded explicitly rather than left inside `state`.
    // They are what an analysis groups by, and re-deriving them later would
    // require replaying the session.
    facts: state?.evidence
      ? {
          changed_files_n: Array.isArray(state.repo?.changed_files) ? state.repo.changed_files.length : 0,
          untracked_n: Array.isArray(state.repo?.untracked) ? state.repo.untracked.length : 0,
          insertions: state.repo?.insertions ?? null,
          deletions: state.repo?.deletions ?? null,
          // Whether git answered at all. MUST be recorded next to the counts: on a
          // non-repository directory every count is 0, and "nothing changed" is a
          // completely different finding from "we could not look". Without this
          // field an offline analysis cannot tell the two apart, and a reviewer
          // would read `changed_files_n: 0` as evidence of a clean tree.
          repo_available: state.repo?.available ?? null,
          tests_run: state.evidence.tests_run ?? null,
          tests_passed: state.evidence.tests_passed ?? null,
          build_ok: state.evidence.build_ok ?? null,
          lint_ok: state.evidence.lint_ok ?? null,
          error_results_n: Array.isArray(state.evidence.error_results) ? state.evidence.error_results.length : 0,
          unverified_claims_n: Array.isArray(state.evidence.unverified_claims)
            ? state.evidence.unverified_claims.length
            : 0,
          // How many recorded commands had an exit code that could NOT be attributed to
          // them, because the agent wrapped the call and the host reported the wrapper's
          // code. Non-zero explains a `tests_passed: null`: the run happened, and we
          // could not honestly read its result. Also the health metric for how often
          // agents write that shape at all.
          unattributable_exits_n: Array.isArray(state.commands)
            ? state.commands.filter((entry) => entry.exit_attributable === false).length
            : 0,
          // How many recorded commands reached Jev WITH output behind them, and how many of
          // those were truncated. This pair is the health metric for the task_v 4 change: if
          // `commands_with_output_n` is 0 on rows whose claims quote command output, the
          // evidence gap behind the P6 false blocks is still open — and that is a fact no
          // threshold change can be blamed for.
          commands_with_output_n: Array.isArray(state.commands)
            ? state.commands.filter(
                (entry) => typeof entry.output_tail === 'string' && entry.output_tail.length > 0,
              ).length
            : 0,
          commands_truncated_n: Array.isArray(state.commands)
            ? state.commands.filter((entry) => entry.output_truncated === true).length
            : 0,
          tool_calls_this_turn: state.activity?.tool_calls_this_turn ?? null,
          // The material/message split. Recorded so the distribution can be measured
          // before anything is allowed to skip on it.
          material_tool_calls: state.activity?.material ?? null,
          message_only_tool_calls: state.activity?.message_only ?? null,

          // WHAT THE TURN PRODUCED, which is the whole subject of the v3 state change.
          //
          // `repo.changed_files_n` above is 0 on every row written on this machine, because
          // the working directory is not a git repository — so without these fields an
          // offline reader would conclude the turns produced nothing. They are the evidence
          // that `requirements_satisfied` is being asked about. Kept as full lists: the
          // calibration question is whether the file the user asked for reached Jev, and a
          // count cannot answer it.
          created_or_written_paths: artifactList(state, 'created_or_written_paths'),
          touched_paths: artifactList(state, 'touched_paths'),
          verified_artifacts: artifactList(state, 'verified_artifacts'),
          material_actions: artifactList(state, 'material_actions'),
        }
      : null,

    // The commands themselves, not just the derived verdicts.
    //
    // The verdicts alone are not auditable: when a later reading of this log asks
    // "why was this called a failing test?", there is no way to check the answer
    // without the command and its exit code. Recording them is also what makes the
    // EXIT-CODE CAVEAT below visible per row instead of a footnote in a README.
    //
    // EXIT-CODE CAVEAT (measured, not assumed): `[exit code: N]` is the shell
    // host's code, and pwsh normalises a non-zero child exit to 1. A bare
    // `node -e "process.exit(7)"` really exits 7 while the marker reads
    // `[exit code: 1]`. This is DSH's own contract — `dsh-shell`'s exported
    // `parseExitStatus` (lib/index.js:31-46) reads exactly this marker and no other
    // — so the honest conclusion is that the codes are trustworthy as ZERO versus
    // NON-ZERO and must not be quoted as a child process's exact status.
    // `output_tail` joined this row with task_v 4, bounded far tighter here than in the state
    // (400 chars against 1500). The row is meant to be a summary, but without SOME of the
    // output the very defect this field was added to fix stays invisible offline: three
    // completed turns were blocked at `evidence_matches_claim` 0.40-0.47 because their claims
    // quoted text a command had printed, while the state carried no output at all. A reader
    // could see the score and the claim and had no way to see that the evidence was simply
    // absent — which is exactly the reading that makes a threshold look like the fix.
    commands: Array.isArray(state?.commands)
      ? state.commands.map((entry) => ({
          kind: entry.kind ?? null,
          exit: entry.exit ?? null,
          // Whether the exit code is about THIS command or about a later statement the
          // agent left behind. Recorded because the raw code alone misleads: a wrapped
          // `npm test` that failed still reports exit 0, from the wrapper.
          exit_attributable: entry.exit_attributable !== false,
          cmd: typeof entry.cmd === 'string' ? entry.cmd.slice(0, 200) : '',
          output_tail: boundedTail(entry.output_tail, 400),
          output_truncated: entry.output_truncated === true,
          output_chars: Number.isFinite(entry.output_chars) ? entry.output_chars : null,
          output_hash: typeof entry.output_hash === 'string' ? entry.output_hash : '',
        }))
      : null,

    // The probabilities are the replay input for threshold tuning.
    //
    // `model` and `model_requested` are recorded together and for one reason: a
    // threshold is only valid for the model that produced the probabilities it was
    // derived from. `jev-latest` is a moving alias, so a log that records only the
    // alias cannot answer the question that decides whether calibration is still
    // valid — "has the thing behind the alias changed since these rows were written?"
    // The requested alias says what we asked for; the returned id says what answered.
    // When the returned id is a concrete version, calibration binds to THAT, and any
    // later change of the alias shows up as a changed `model` on new rows.
    jev: jev
      ? {
          probabilities: jev.probabilities,
          request_id: jev.requestId ?? null,
          model: jev.model ?? null,
          model_requested: jev.modelRequested ?? null,
          usage: jev.usage ?? null,
        }
      : null,
    jev_error: jevError ?? null,

    decision: decision
      ? {
          action: decision.action,
          reason: decision.reason,
          rule: decision.rule,
          // Whether the rule that fired is ALLOWED to steer. False for the advisory rules
          // (P5/P6/P7), which are computed and logged but cannot interrupt a turn.
          enforce: decision.enforce !== false,
          // The first advisory rule that fired, if any. This is where a claim that outruns its
          // evidence now lands: recorded every time it happens, acted on never.
          advisory_rule: decision.advisory_rule ?? null,
          // What the OBSERVATION thresholds (0.40 / 0.65) would have said. Kept beside `rule` so one
          // row answers "would the old policy have blocked this, and did the new one?" — the only way
          // to compare a new turn against the rows already on disk.
          shadow_rule: decision.shadow_rule ?? null,
          shadow_reason: decision.shadow_reason ?? null,
          // The guard band doing its job: the observation thresholds would have blocked this turn
          // and the intervention band did not. A band that never reports a grey zone is either too
          // wide or not being exercised, and both are worth knowing.
          gray_zone: decision.gray_zone === true,
          // What actually happened, taken from the caller rather than re-derived here: "the policy
          // wanted to act" and "we acted" differ by two run-time limits — shadow mode and the
          // per-task steer budget — that this module cannot see.
          would_steer: wouldSteer === true,
          will_steer: willSteer === true,
          steer_suppressed: steerSuppressed ?? null,
          // Whether the policy disagreed with the deterministic facts is a key health metric: a
          // high rate means the config is mis-tuned.
          applied: willSteer === true,
        }
      : null,

    latency_ms: latency ?? null,
    cost_usd_est: costUsd ?? null,

    // Filled in later by `outcomeRow`; present from the start so readers can
    // filter without checking for the key's existence.
    ground_truth: null,
  };
}

/**
 * Build the outcome row, appended when the NEXT user message arrives.
 *
 * This is the field set that makes the difference between "we logged decisions"
 * and "we can evaluate whether the decisions were right".
 *
 * @param {object} args
 * @returns {object}
 */
export function outcomeRow({
  assessmentId,
  sessionId,
  actionThatWasDecided,
  wasShadow,
  userFollowup,
  outcome,
}) {
  return {
    log_v: LOG_VERSION,
    build_id: BUILD_ID,
    row: 'outcome',
    assessment_id: assessmentId,
    at: new Date().toISOString(),
    session_id: sessionId,
    decision_action: actionThatWasDecided,
    decision_was_shadow: wasShadow,
    user_followup_excerpt: typeof userFollowup === 'string' ? userFollowup.slice(0, 200) : null,
    ground_truth: outcome,
  };
}

/**
 * A row recording that a turn was deliberately NOT assessed, and why.
 *
 * WHY SKIPS ARE LOGGED AT ALL
 * ---------------------------
 * Without this, the log answers "what did we assess?" and silently omits every
 * turn we chose to ignore. That is the more dangerous half of the record: a rule
 * that skips too much is invisible, and the resulting analysis looks healthy
 * precisely BECAUSE the cases that would have failed never appear. A shadow phase
 * exists to measure the rules, and a rule whose rejections are unlogged cannot be
 * measured at all.
 *
 * It also makes the two behaviours asked about directly checkable in the log:
 *   - the same material state stopping twice must produce `no_material_change`
 *   - a new user task must produce a fresh budget, so the next assessment is not
 *     preceded by `budget_exhausted`
 *
 * Bounded on purpose: no state, no commands, no fingerprints — a skip is a single
 * fact, and the rule name plus the counters are enough to see whether the rule is
 * firing at the intended rate.
 *
 * @param {object} args
 * @returns {object}
 */
export function skipRow({ sessionId, turn, reason, activity = null, taskKey = null, assessmentsUsed = null }) {
  return {
    log_v: LOG_VERSION,
    build_id: BUILD_ID,
    row: 'skip',
    at: new Date().toISOString(),
    session_id: sessionId,
    turn: typeof turn === 'number' ? turn : null,
    reason,
    // Recorded beside the rule so a reader can tell a genuine "no work happened"
    // from a rule that misfired. The material/message split is the field that will
    // eventually decide this rule, so its value at the moment of skipping matters.
    task_key: taskKey === null || taskKey === undefined ? null : String(taskKey),
    assessments_used: assessmentsUsed,
    tool_calls_total: activity?.tool_calls_this_turn ?? null,
    material_tool_calls: activity?.material ?? null,
    message_only_tool_calls: activity?.message_only ?? null,
  };
}

/**
 * Signals in a user's next message that indicate the previous turn was NOT
 * actually finished.
 *
 * Deliberately conservative: these are corrections and complaints, not mere
 * continuation. A user who says "now also do X" is satisfied with the last turn;
 * a user who says "that's not working" is not. Conflating the two would make the
 * false-pass rate look far worse than it is and push us into over-blocking.
 *
 * Both English and Chinese, because the operator works in both.
 */
const CORRECTION_PATTERNS = [
  /\bnot\s+work(?:ing|ed)?\b/i,
  /\b(?:still|yet)\s+(?:not|broken|failing|fails|wrong|error)/i,
  /\bdoes(?:n't| not)\s+work\b/i,
  /\bdid(?:n't| not)\s+(?:work|fix|change)\b/i,
  /\bthat(?:'s| is)\s+(?:wrong|broken|incorrect)\b/i,
  /\b(?:you\s+)?(?:forgot|missed|skipped)\b/i,
  /\berror(?:s)?\s+(?:again|still)\b/i,
  /\bnot\s+(?:done|finished|complete)\b/i,
  /\b(?:revert|undo|rollback)\b/i,
  /\b(?:try\s+again|redo)\b/i,
  /没有(?:用|效|成功|解决)/,
  /还是(?:不|没|报错|失败|错)/,
  /(?:报错|出错|失败)了/,
  /不(?:对|行|能|好使)/,
  /(?:漏|忘)了/,
  /(?:重新|再来|回滚|撤回)/,
];

/** Phrases showing the user is dismissing our intervention rather than the work. */
const DISMISSAL_PATTERNS = [
  /\b(?:don'?t|no)\s+(?:worry|need|bother)\b/i,
  /\b(?:stop|never\s+mind|forget\s+it)\b/i,
  /\b(?:just\s+)?(?:leave|ignore)\s+it\b/i,
  /\b(?:that'?s|it'?s)\s+fine\b/i,
  /不用(?:了|管|在意)/,
  /算了/,
  /没关系/,
  /(?:忽略|别管)/,
];

/**
 * Classify a user follow-up into a ground-truth outcome.
 *
 * @param {string} text - the user's next message.
 * @returns {{kind: string, matched: string|null}}
 */
export function classifyFollowup(text) {
  const value = typeof text === 'string' ? text.replace(/\s+/g, ' ').trim() : '';
  if (value.length === 0) return { kind: 'no_followup', matched: null };

  for (const pattern of DISMISSAL_PATTERNS) {
    const match = pattern.exec(value);
    if (match !== null) return { kind: 'user_dismissed', matched: match[0] };
  }
  for (const pattern of CORRECTION_PATTERNS) {
    const match = pattern.exec(value);
    if (match !== null) return { kind: 'user_reported_problem', matched: match[0] };
  }
  return { kind: 'user_moved_on', matched: null };
}

/**
 * Decide the ground-truth verdict for one assessment, given what the user did next.
 *
 * The interesting cells are the disagreements:
 *   we said finish + user complained  -> FALSE PASS (we missed an incomplete turn)
 *   we said block  + user dismissed   -> FALSE BLOCK (our most expensive error)
 *   we said block  + agent then fixed -> GOOD BLOCK
 *
 * @param {{action: string}} decision
 * @param {{kind: string}} followup
 * @param {{fixedAfterBlock?: boolean}} [signals]
 * @returns {object}
 */
export function judgeOutcome(decision, followup, signals = {}) {
  const action = decision?.action ?? 'unknown';
  const kind = followup?.kind ?? 'unknown';
  const blocked = action === 'continue' || action === 'verify_more' || action === 'retry';
  const passed = action === 'finish' || action === 'pass';

  let verdict;
  if (passed && kind === 'user_reported_problem') verdict = 'false_pass';
  else if (passed && kind === 'user_moved_on') verdict = 'true_pass';
  else if (passed && kind === 'no_followup') verdict = 'pass_unobserved';
  else if (blocked && kind === 'user_dismissed') verdict = 'false_block';
  else if (blocked && signals.fixedAfterBlock === true) verdict = 'good_block';
  else if (blocked && kind === 'user_reported_problem') verdict = 'block_insufficient';
  else if (blocked && kind === 'user_moved_on') verdict = 'block_moot';
  else verdict = 'unclassified';

  return { verdict, action, followup_kind: kind, blocked, passed };
}

/**
 * Read back every row of a log file, skipping unparsable lines.
 * Tolerates older row shapes so a log spanning a schema change stays readable.
 *
 * @param {string} path
 * @returns {object[]}
 */
export function readLog(path) {
  if (!existsSync(path)) return [];
  const rows = [];
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return [];
  }
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed !== null && typeof parsed === 'object') rows.push(parsed);
    } catch {
      // A torn tail from a crash mid-write; ignore and keep reading.
    }
  }
  return rows;
}

/**
 * Join assessment rows with their outcome rows.
 * @param {object[]} rows
 * @returns {Array<object>} assessments, each with `outcome` attached when known.
 */
export function joinOutcomes(rows) {
  const outcomes = new Map();
  for (const row of rows) {
    if (row?.row === 'outcome' && typeof row.assessment_id === 'string') {
      outcomes.set(row.assessment_id, row);
    }
  }
  const joined = [];
  for (const row of rows) {
    if (row?.row !== 'assessment') continue;
    const outcome = outcomes.get(row.assessment_id) ?? null;
    joined.push({ ...row, outcome, ground_truth: outcome?.ground_truth ?? null });
  }
  return joined;
}
