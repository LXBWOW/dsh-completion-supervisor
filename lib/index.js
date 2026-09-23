/**
 * dsh-completion-supervisor — is the agent actually finished?
 *
 * THE PROBLEM
 * -----------
 * A coding agent says "done". Sometimes it is. Sometimes the tests were never
 * run, a file was created and never tracked, or a summary describes an outcome
 * that the recorded commands contradict. The user finds out later.
 *
 * THE APPROACH
 * ------------
 * At the one moment a turn is about to close, gather the deterministic evidence,
 * compress it, ask Jev (a fast typed classifier — not an LLM) seven narrow
 * yes/no questions in ONE request, and run a pure policy over the answers.
 *
 *   turn-stopping -> TaskState -> one batched Jev call -> decide() -> shadow log
 *
 * WHAT DECIDES AN ACTION, AND WHAT ONLY OBSERVES
 * ----------------------------------------------
 * As of POLICY_VERSION 3 the split is by KIND OF EVIDENCE, not by rule number. Only P1/P2/P3 may
 * steer, and each compares the turn against a fact this plugin computed itself: an unresolved tool
 * error, a claim of verification with no run behind it, a recorded test run that did not pass.
 * Everything derived from Jev's seven probabilities — P4 through P8 — is recorded and decides
 * nothing.
 *
 * It still does NOT switch workers, does NOT assess periodically, and does NOT route models.
 * `shadowMode: true` by default means that even the deterministic rules only log.
 *
 * The probabilities were retired rather than re-tuned: across 141 logged rows there is no confirmed
 * `good_block`; the 11 turns a probability-driven P4 fired on were re-read one by one and not one was
 * confirmed necessary; the single steer that reached a user is logged as a false block; and repeated
 * sampling of one state spread 0.04-0.11, as wide as several of the gaps the thresholds were being
 * compared against. A signal with no measured true positive and noise of that size should not be
 * spending real interruptions. Jev's numbers are still collected on every turn, because that record
 * is the only thing that could justify bringing them back.
 *
 * THE MOUNT POINT, AND WHY IT IS THE ONLY ONE
 * -------------------------------------------
 * `agent/turn-stopping` is the only seam where a plugin can object to a turn
 * closing. It is `serial` and awaited, and the loop re-reads its inbox afterwards
 * (`dsh-agent-loop/lib/index.js:966-973`) — so a listener that calls
 * `agent.steer(...)` causes another step instead of the turn ending. The official
 * contract states it plainly: "Data decides, so listener order cannot change the
 * outcome."
 *
 * We deliberately do NOT mount `tools/pre-execute`: it is an awaited waterfall on
 * EVERY tool call, so anything slow there taxes the whole session linearly in tool
 * calls. That is precisely why the earlier command-gate design was abandoned.
 *
 * FAIL-OPEN, ALWAYS
 * -----------------
 * Every failure path ends the same way: log it, do not steer, let DSH end the turn
 * natively. A missing key, a timeout, a malformed response, a git failure, an
 * over-budget state, a thrown policy — all of them degrade to "no supervision",
 * never to "broken session". Jev is never a single point of failure.
 */

import z from 'schemastery';
import { randomUUID } from 'node:crypto';

import { assess, resolveApiKey, DEFAULT_TIMEOUT_MS } from './jev.js';
import { PROMPT_VERSION, QUESTION_SET_HASH } from './questions.js';
import {
  assembleTaskState,
  deriveEvidence,
  estimateCostUsd,
  fitState,
  isUserAuthored,
  DEFAULT_STATE_TOKEN_BUDGET,
  TASK_STATE_VERSION,
} from './taskstate.js';
import {
  FINGERPRINT_VERSION,
  changedFields,
  fingerprintState,
  isMaterialChange,
} from './fingerprint.js';
import { ACTIONS, DEFAULT_THRESHOLDS, POLICY_VERSION, decide, decideWithoutJev, renderSteerMessage } from './policy.js';
import {
  DecisionLog,
  LOG_VERSION,
  assessmentRow,
  classifyFollowup,
  judgeOutcome,
  newAssessmentId,
  outcomeRow,
  redactSecret,
  skipRow,
} from './log.js';
import { createStateStore } from './state.js';
import { collectGitFacts } from './git.js';
import { BUILD_AT, BUILD_ID } from './build.js';
import { MAX_HEALTH_LIMIT, buildReport, render as renderHealthReport } from './health.js';

export const name = 'completion-supervisor';
/**
 * Empty on purpose. A hard `inject` list means one absent service stops the whole
 * plugin from loading; we instead acquire each service optionally via
 * `ctx.inject([...], cb)` and degrade per-feature. Every service this plugin
 * wants (`agents`, `shell`, `sessionProjections`, `sandboxPolicy`) is composed by
 * `dsh-base`, but the plugin should not be the thing that breaks if a deployment
 * trims one.
 */
export const inject = [];

const PLUGIN = 'completion-supervisor';

/** Source tag on steered messages: lets us (and the log) tell our own input apart. */
const SUPERVISOR_SOURCE = Object.freeze({ kind: 'plugin', plugin: PLUGIN, form: 'completion-check' });

export const Config = z.object({
  /** Master switch. */
  enabled: z.boolean().default(true),
  /**
   * When true, decisions are logged but never acted on.
   *
   * The default stays `true` so a plugin loaded without explicit configuration observes rather
   * than acts — the safe direction for a component whose mistakes interrupt someone else's work.
   * An installation that wants intervention turns it off explicitly in `cordis.patch.yml`.
   */
  shadowMode: z.boolean().default(true),
  /** Hard cap on assessments per user task. */
  maxAssessments: z.natural().default(3),
  /**
   * Hard cap on ACTUAL steers per user task.
   *
   * Deliberately smaller than `maxAssessments`, and being the tighter of the two is the point. The
   * assessment cap bounds how often we LOOK; this bounds how often we SPEAK. A steered turn reaches
   * `turn-stopping` again, so a second assessment of the same task is expected and fine — a second
   * STEER for the same disagreement is a loop, and a loop is worse than any single missed
   * intervention.
   *
   * 1 for the first intervention deployment, and unchanged by POLICY_VERSION 3. That contraction
   * removed the probability-driven steers, so this budget is now reachable ONLY through the
   * deterministic rules — which is exactly why it is kept rather than removed with them: a failing
   * test run reported twice inside one task is still a loop, and a loop is worse than any single
   * missed intervention. Once the budget is spent, later turns of the same task are recorded with
   * `steer_suppressed: 'per_task_steer_budget'` and allowed to end normally.
   */
  maxSteersPerTask: z.natural().default(1),
  /**
   * Jev request timeout. Keeps a hung socket off the turn-close path.
   *
   * 5000 during calibration, deliberately generous: a timeout is a lost observation,
   * and losing the slow cases is a biased loss if slowness tracks state size or
   * ambiguity. This number must come DOWN before `shadowMode` is turned off — there it
   * sits on the turn-close path and the user waits for it — and the value then has to
   * come from the measured P95/P99 rather than from this default. Recorded per row as
   * `latency_ms`, so the distribution needed to choose it is already accumulating.
   */
  jevTimeoutMs: z.natural().default(DEFAULT_TIMEOUT_MS),
  /** Estimated token ceiling for the TaskState. */
  stateTokenBudget: z.natural().default(DEFAULT_STATE_TOKEN_BUDGET),
  /** Jev model. */
  jevModel: z.string().default('jev-latest'),
  /** Log file; empty = ~/.dsh/completion-supervisor/assessments.jsonl */
  logPath: z.string().default(''),
  /** Set false to disable all logging (not recommended during shadow phase). */
  logEnabled: z.boolean().default(true),
  /** Require at least one tool call in the turn before assessing. */
  requireToolCall: z.boolean().default(true),
  /** Skip assessment when the turn made no repository change at all. */
  requireRepoChange: z.boolean().default(false),
});

/**
 * Plugin entry.
 * @param {object} ctx
 * @param {object} rawConfig - dsh passes the composed row config as the SECOND
 *   argument, not as `ctx.config`. (Same trap `dsh-agent-mailbox` documents.)
 */
export function apply(ctx, rawConfig) {
  // Normalize through our own schema rather than trusting the caller to have done
  // it. DSH's loader does validate against `Config`, but `apply` is also reachable
  // directly (tests, diagnostics), and a missing field here is not cosmetic:
  // an undefined `maxAssessments` makes `used >= maxAssessments` permanently false
  // and the per-task budget silently stops existing. Defaults must not depend on
  // which path called us.
  let config;
  try {
    config = Config(rawConfig ?? ctx?.config ?? {});
  } catch {
    // A caller passing something the schema rejects still gets supervision; it just
    // gets every default. Failing to load would be a worse outcome than a defaulted
    // shadow observer.
    config = Config({});
  }
  const stateStore = createStateStore();

  // Resolve the key BEFORE constructing the log, so the log can be told what must
  // never be written to it. Both orders work, but this one makes the guard's
  // existence visible at the point where the secret enters the plugin.
  const keyInfo = resolveApiKey();
  const apiKey = keyInfo.key;

  const log = new DecisionLog({ path: config.logPath || undefined, secret: apiKey });

  const diagnostics = {
    enabled: config.enabled !== false,
    shadow: config.shadowMode !== false,
    /**
     * When this process loaded the plugin.
     *
     * Read by the health tool to decide whether a log row was written by THIS process: every row we
     * write carries our `BUILD_ID`, so a row older than this instant cannot be ours. That is what
     * separates "restarted, nothing assessed yet" from "another process is writing this log", and
     * the build's own timestamp cannot do it — an old process outlives the build that replaces it.
     */
    startedAt: new Date().toISOString(),
    apiKeyPresent: apiKey.length > 0,
    // WHICH source answered, never the value. This is the field that answers "did the
    // key I just set get picked up, or is this an older one?" after a restart — the
    // question that made the missing `.env` support so hard to notice.
    apiKeySource: keyInfo.source,
    apiKeyFilePath: keyInfo.filePath,
    logEnabled: config.logEnabled !== false,
    logPath: log.path,
    thresholds: null,
    rejected: 0,
    lastError: null,
    /**
     * The most recent successful Jev response, so the status tool can answer the one
     * question calibration depends on: which CONCRETE model is behind the alias?
     *
     * `config.jevModel` only says what we asked for. If the alias moves, every
     * threshold derived before that moment is calibrated against a different model, and
     * nothing in the config would show it. Having the observed id here — and on every
     * log row — means the check is available immediately rather than after an analysis
     * pass over the JSONL.
     */
    lastJev: null,
  };

  /**
   * Scrub the key out of any diagnostic text.
   *
   * Every message that leaves this plugin passes through here, for the same reason the
   * log writer redacts independently: the leak we are defending against is not a
   * deliberate `log(key)` — it is an upstream string that happens to quote the header
   * it rejected. DSH's own log file is a second sink, and it is the one that is easy
   * to forget because it is not ours.
   *
   * @param {unknown} text
   * @returns {string}
   */
  const scrub = (text) => redactSecret(String(text ?? ''), apiKey);

  /** Record a diagnostic without ever letting the key ride along. */
  const noteError = (prefix, error) => {
    diagnostics.lastError = scrub(`${prefix}: ${String(error?.message ?? error)}`);
  };

  if (!diagnostics.enabled) {
    ctx.logger?.info?.(`${PLUGIN}: disabled by config`);
    return;
  }
  if (!diagnostics.apiKeyPresent) {
    // Log once, then run in a deterministic-only mode. We still catch the
    // contradictions that need no Jev (a claim of tests that never ran), which
    // makes a key-less install quietly useful instead of inert.
    ctx.logger?.warn?.(
      `${PLUGIN}: TYPESAFE_API_KEY is not set — assessments will be skipped and only ` +
        'deterministic contradictions will be recorded. Set the key to enable Jev.',
    );
  }
  ctx.logger?.info?.(
    `${PLUGIN}: active (shadow=${diagnostics.shadow}, maxAssessments=${config.maxAssessments}, ` +
      `jev=${config.jevModel}, log=${log.path})`,
  );

  // ── Evidence accumulation ───────────────────────────────────────────────────
  // We keep the turn's events in memory rather than re-reading the session: the
  // session log's surface is compacted and replaced over time, so a turn that has
  // been through compaction no longer has its own events at their original seqs.
  // Accumulating as they arrive is both cheaper and more correct.
  const eventsBySession = new Map();
  const MAX_EVENTS_PER_SESSION = 4000;

  ctx.on('session/event', (session, event) => {
    try {
      if (event?.type !== 'tool/call' && event?.type !== 'tool/result' &&
          event?.type !== 'assistant/message' && event?.type !== 'user/message') {
        return;
      }
      const id = session?.id;
      if (typeof id !== 'string') return;
      let list = eventsBySession.get(id);
      if (list === undefined) {
        list = [];
        eventsBySession.set(id, list);
      }
      list.push(event);
      if (list.length > MAX_EVENTS_PER_SESSION) list.splice(0, list.length - MAX_EVENTS_PER_SESSION);
    } catch (error) {
      noteError('session/event', error);
    }
  });

  ctx.on('session/disposed', (session) => {
    const id = session?.id;
    if (typeof id === 'string') {
      eventsBySession.delete(id);
      stateStore.forget(id);
    }
  });

  // ── Outcome backfill ───────────────────────────────────────────────────────
  // A user message that is NOT our own steering is the ground-truth signal for the
  // previous assessment. Writing it as a second row is what turns the log from
  // "what we decided" into "whether we were right".
  ctx.on('session/event', (session, event) => {
    if (event?.type !== 'user/message') return;
    try {
      const message = event.data;
      if (message === null || typeof message !== 'object') return;
      // Only the human's own message is ground truth about the previous turn.
      // `subagent-settled`, `plugin (hindsight)`, `skill-catalog` and the rest are
      // DSH machinery arriving in a user-role envelope; treating one as a follow-up
      // would attribute a verdict to a user who never said anything. See
      // `isUserAuthored` in log.js for the measured list.
      if (!isUserAuthored(message.source)) return;
      const id = session?.id;
      if (typeof id !== 'string') return;

      // A new user-authored message begins a new task, which resets the
      // assessment budget. This must happen before the outcome backfill below,
      // because that backfill belongs to the PREVIOUS task.
      const taskKey = stateStore.noteUserTask(id);
      stateStore.beginTask(id, taskKey);

      const pending = stateStore.takePending(id);
      if (pending === null) return;
      if (config.logEnabled === false) return;

      const text = extractMessageText(message.content);
      const followup = classifyFollowup(text);
      const outcome = judgeOutcome(pending.decision ?? {}, followup);
      log.write(
        outcomeRow({
          assessmentId: pending.assessmentId,
          sessionId: id,
          actionThatWasDecided: pending.decision?.action ?? null,
          wasShadow: pending.shadow === true,
          userFollowup: text,
          outcome: { ...outcome, followup_matched: followup.matched },
        }),
      );
    } catch (error) {
      noteError('outcome backfill', error);
    }
  });

  // ── The main judgement point ────────────────────────────────────────────────
  ctx.inject(['agents'], () => {
    ctx.on('agent/turn-stopping', async ({ agent, turn, signal }) => {
      try {
        await onTurnStopping({ ctx, config, stateStore, log, eventsBySession, diagnostics, apiKey, agent, turn, signal });
      } catch (error) {
        // The outermost guard. Whatever went wrong, the turn ends normally.
        noteError('turn-stopping', error);
        diagnostics.rejected += 1;
        ctx.logger?.warn?.(`${PLUGIN}: assessment aborted, allowing the turn to end: ${diagnostics.lastError}`);
      }
    });
  });

  // ── Operator surface ────────────────────────────────────────────────────────
  //
  // ONE report builder shared by the agent-facing tool and the human-facing slash command. The two
  // differ only in who reads the output and who pays for it; if they built the report separately,
  // they would eventually disagree, and the disagreement would be discovered by a person trusting
  // one of them.
  const healthReport = (limit) =>
    buildReport({
      path: log.path,
      limit,
      runtime: {
        buildId: BUILD_ID,
        // When THIS process loaded the plugin, so the summary can tell "the log predates us, we
        // have not assessed anything yet" (expected, a note) apart from "something else is writing
        // rows with a different build id" (a check). Deliberately not the build's own timestamp: an
        // old process keeps writing rows after a new build lands, so a row newer than the build
        // proves nothing — that version raised a false alarm on the first run after the very
        // restart it was written for.
        startedAt: diagnostics.startedAt,
        shadow: diagnostics.shadow,
      },
    });

  ctx.inject(['tools'], (scope) => {
    scope.tools.register({
      name: 'completion_supervisor_status',
      description:
        'Report the completion supervisor state: whether it is enabled, whether it is in shadow mode, ' +
        'how many assessments it has made per session, the log file, and the failure counters. Use this ' +
        'to check whether the supervisor is running and where its decision log lives.',
      parameters: { type: 'object', properties: {}, required: [] },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      async execute() {
        const lines = [
          `completion-supervisor`,
          `enabled: ${diagnostics.enabled}`,
          `mode: ${diagnostics.shadow ? 'SHADOW (logs only, never steers)' : 'INTERVENTION (deterministic rules only)'}`,
          // The two bands. As of POLICY_VERSION 3 the difference between them is what gets RECORDED,
          // not what gets acted on: nothing compared against a probability may steer, so both lines
          // are diagnostics now. They stay printed apart because the wide one is what keeps a new row
          // comparable with every row already on disk, while the narrow one is what marks a turn as a
          // steer the contraction removed.
          `  observation band (logged only): req < ${DEFAULT_THRESHOLDS.requirementsUnsatisfiedBelow} or blk >= ${DEFAULT_THRESHOLDS.blockingIssueAtOrAbove}`,
          `  intervention band (advisory only since policy_v ${POLICY_VERSION}): req < ${DEFAULT_THRESHOLDS.steerRequirementsBelow} or blk >= ${DEFAULT_THRESHOLDS.steerBlockingAtOrAbove}`,
          '  may steer (computed facts only): P1, P2, P3',
          '  advisory rules (recorded, never steer): P4, P5, P6, P7',
          `TYPESAFE_API_KEY present: ${diagnostics.apiKeyPresent}`,
          diagnostics.apiKeyPresent
            ? `  resolved from: ${diagnostics.apiKeySource === 'file' ? `file ${diagnostics.apiKeyFilePath}` : 'the environment'}`
            : `  looked in: the environment, then ${diagnostics.apiKeyFilePath}`,
          // The value was read once at plugin load. Re-read it now so the answer to
          // "I just placed the key — did it take?" does not require guessing whether a
          // restart happened. Reporting only the frozen value is what made the missing
          // .env support invisible: present:false looked like a bad key, not like a
          // file that is never read.
          statusKeyLine(apiKey, diagnostics),
          `jev model requested: ${config.jevModel}`,
          // Printed as a separate, indented line rather than folded into the one above,
          // because "we asked for jev-latest" and "what answered was X" are different
          // facts and only the second one can invalidate a calibration.
          diagnostics.lastJev === null
            ? '  no Jev response yet in this process, so the concrete version behind the alias is unknown'
            : `  last response came from model: ${diagnostics.lastJev.model === null ? '(the response did not name one)' : diagnostics.lastJev.model}` +
              `  (${diagnostics.lastJev.latencyMs}ms, at ${diagnostics.lastJev.at})`,
          `max assessments per user task: ${config.maxAssessments}`,
          // The tighter of the two budgets, and the one that decides whether a disagreement turns
          // into a loop. Reported beside the assessment budget because they are read together.
          `max steers per user task: ${config.maxSteersPerTask}`,
          `jev timeout: ${config.jevTimeoutMs}ms`,
          `state token budget: ${config.stateTokenBudget}`,
          `log enabled: ${diagnostics.logEnabled}`,
          `log path: ${diagnostics.logPath}`,
          `versions: log_v=${LOG_VERSION} task_v=${TASK_STATE_VERSION} prompt_v=${PROMPT_VERSION} policy_v=${POLICY_VERSION} fingerprint_v=${FINGERPRINT_VERSION}`,
          `question set: v${PROMPT_VERSION} hash ${QUESTION_SET_HASH}`,
          '  the hash is derived from the question texts, so rows sharing it were asked',
          '  literally the same questions even if a version bump was forgotten.',
          `BUILD_ID: ${BUILD_ID}  (built ${BUILD_AT})`,
          '  compare against `node tools/build-id.mjs --check` in the source tree: a',
          '  mismatch means the running plugin predates the current sources.',
          `tracked sessions: ${stateStore.size}`,
          `assessment errors: ${diagnostics.rejected}`,
          `log write failures: ${log.writeFailures}${log.lastError === null ? '' : ` (${log.lastError})`}`,
          // Non-zero means a secret was travelling inside a row and was caught. Worth
          // seeing: it means some field carries the key and should be found and fixed,
          // even though the log itself stayed clean.
          log.redactions > 0 ? `key redactions: ${log.redactions} (a row tried to record the key)` : '',
          diagnostics.lastError === null ? '' : `last error: ${diagnostics.lastError}`,
        ].filter((line) => line.length > 0);
        return lines.join('\n');
      },
    });

    // ── The read-only summary of the log ──────────────────────────────────────
    //
    // Separate from the status tool because the two answer different questions and read different
    // things. Status describes THIS PROCESS from the values it holds in memory — the mode it is
    // running in, the budgets, the key state — and works on a machine that has never assessed
    // anything. This one describes the LOG, and works in a fresh process with no memory of any
    // turn. Merging them would produce one output whose numbers silently come from two different
    // places, which is the confusion this plugin keeps having to design against.
    //
    // Read-only in the strict sense: it opens the JSONL for reading, writes nothing, calls no
    // model, and touches no state. Running it cannot change a decision.
    scope.tools.register({
      name: 'completion_supervisor_health',
      description:
        'Summarise the completion supervisor decision log: mode, versions, assessment and steer ' +
        'counts, Jev failure rate and latency, and a deterministic OK/CHECK verdict. Use this to ' +
        'tell whether the supervisor has been working recently without reading the raw JSONL. ' +
        'Read-only: it writes no log rows, calls no model, and cannot change any decision. It ' +
        'never claims a steer was a false positive — it reports that one needs review.',
      parameters: {
        type: 'object',
        properties: {
          limit: {
            type: 'integer',
            // No `minimum`/`maximum`: DSH's supported schema subset rejects them, and a rejected
            // schema fails the plugin at load time. The bound is applied in `clampLimit`.
            description:
              'How many recent assessments to summarise. Default 50, clamped to 1..500.',
          },
        },
        required: [],
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      async execute(args) {
        try {
          return renderHealthReport(healthReport(args?.limit));
        } catch (error) {
          // A summary is diagnostic output, so failing to produce one must not surface as a tool
          // error the session has to recover from. State the failure and stop.
          return [
            'Completion Supervisor Health',
            '',
            'Health: UNAVAILABLE',
            `- the log at ${log.path} could not be summarised: ${scrub(String(error?.message ?? error))}`,
          ].join('\n');
        }
      },
    });
  });

  // ── The same summary as a slash command ─────────────────────────────────────
  //
  // A slash command is executed by the command runtime and rendered by the client, so it never
  // enters a turn: no tokens, no model, no chance of the numbers being paraphrased on the way to
  // the reader. That is the whole point of having it beside the tool rather than instead of it —
  // "show me the verdict" is a question the person asks the UI, while the tool exists for the agent
  // to call in the middle of investigating something.
  //
  // Named `/supervisor`, not `/health`: this is a third-party plugin in a shared namespace, and the
  // generic word would collide with the first unrelated thing to want it. The description carries
  // the meaning instead.
  ctx.inject(['commands'], (scope) => {
    scope.commands.register({
      name: 'supervisor',
      description: 'Completion supervisor: recent decision-log health summary',
      input: { hint: '[limit]  e.g. /supervisor 100' },
      handler(invocation) {
        const raw = typeof invocation?.rawInput === 'string' ? invocation.rawInput.trim() : '';
        // Only a bare integer is accepted, so a typo is answered with the usage instead of being
        // silently reinterpreted as "default". `clampLimit` still owns the range, and reports it.
        if (raw.length > 0 && !/^[0-9]+$/.test(raw)) {
          return {
            kind: 'error',
            text:
              'Usage: /supervisor [limit]\n' +
              `  limit is a whole number of recent assessments (1..${MAX_HEALTH_LIMIT}). Example: /supervisor 100`,
          };
        }
        try {
          return { kind: 'success', text: renderHealthReport(healthReport(raw.length === 0 ? undefined : Number(raw))) };
        } catch (error) {
          return {
            kind: 'error',
            text: `The log at ${log.path} could not be summarised: ${scrub(String(error?.message ?? error))}`,
          };
        }
      },
    });
  });
}

/**
 * The one status line that answers "did my key take effect?".
 *
 * The running plugin holds the key it read at load time. If the resolve now disagrees
 * with that, the file changed after the plugin started and a restart is required — a
 * fact the status output should state outright rather than leave to be inferred from
 * a `present: false` that looks like a bad key.
 *
 * Never includes the value.
 *
 * @param {string} loadedKey - what the plugin is actually using.
 * @param {{apiKeyFilePath: string|null}} diagnostics
 * @returns {string}
 */
function statusKeyLine(loadedKey, diagnostics) {
  let current;
  try {
    current = resolveApiKey();
  } catch {
    return '  (the key file could not be re-read; is the path readable?)';
  }
  const loaded = loadedKey.length > 0;
  const now = current.key.length > 0;
  if (loaded === now) {
    return now
      ? `  unchanged since load (${current.source === 'file' ? 'file' : 'environment'})`
      : '  no key at load, and still none — assessments stay deterministic-only';
  }
  if (!loaded && now) {
    return `  a key is NOW available (${current.source === 'file' ? `file ${current.filePath}` : 'environment'}) — RESTART DSH to use it`;
  }
  return '  the key that was loaded is GONE — assessments fall back to deterministic-only after the next restart';
}

/**
 * Flatten a message's content blocks into text.
 *
 * This one does NOT filter on `block.type`, unlike `blocksToText` in taskstate.js — and
 * that asymmetry is deliberate rather than an oversight. It is only ever used on a
 * USER-authored message (the follow-up that backfills ground truth), and a real
 * `user/message` carries a single `[text]` block; private reasoning appears only in
 * `assistant/message`. Keep it that way: if this is ever pointed at assistant content, it
 * needs the same allow-list, because concatenating a reasoning block here would put the
 * model's thinking into the text that classifies the user's reaction.
 */
function extractMessageText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const block of content) {
    if (block !== null && typeof block === 'object' && typeof block.text === 'string') {
      parts.push(block.text);
    }
  }
  return parts.join('\n');
}

/**
 * The judgement pipeline, extracted so every failure has exactly one place to be
 * caught and converted into a log row plus a native turn end.
 */
async function onTurnStopping({ ctx, config, stateStore, log, eventsBySession, diagnostics, apiKey, agent, turn, signal }) {
  const session = agent?.session;
  const sessionId = session?.id;
  if (typeof sessionId !== 'string') return;

  /**
   * Record a skip in memory AND on disk.
   *
   * The disk half is the point: an unlogged skip makes a mis-firing rule invisible,
   * because the log then contains only the turns we DID assess and looks healthy by
   * construction. `logEnabled` is respected, and a logging failure must never turn a
   * skip into an error, so the write is guarded here rather than at each call site.
   */
  const skip = (reason, activity = null) => {
    stateStore.recordSkip(sessionId, reason);
    if (config.logEnabled === false) return;
    try {
      const current = stateStore.get(sessionId);
      log.write(
        skipRow({
          sessionId,
          turn,
          reason,
          activity,
          taskKey: current.taskKey,
          assessmentsUsed: current.assessmentsUsed,
        }),
      );
    } catch (error) {
      noteError('skip log', error);
    }
  };

  // R1. Self-trigger guard: we already steered in this turn, so this second
  // stopping is the result of our own input. Assessing again would loop.
  if (stateStore.intervenedIn(sessionId, turn)) {
    skip('already_intervened_this_turn');
    return;
  }

  const state = stateStore.get(sessionId);

  // R2. Derive evidence first: it decides whether this turn is even assessable,
  // and a turn we skip should not consume budget.
  // Resolved BEFORE the evidence is derived, because the artifact paths are shortened
  // against it. A path inside the working directory becomes a relative one, which is the
  // same fact in a fraction of the tokens.
  const cwd = session?.header?.cwd ?? process.cwd();
  const events = eventsBySession.get(sessionId) ?? [];
  // `secret` is passed down so a shell result that happened to echo a token is redacted
  // BEFORE it becomes part of the state — see `redact.js`. The state is sent to Jev and is
  // also the object the log records, so both sinks are covered at the source rather than
  // relying on the log writer's last-line-of-defence scrub alone.
  const derived = deriveEvidence(events, turn, { cwd, secret: apiKey });

  if (config.requireToolCall !== false && derived.activity.tool_calls_this_turn === 0) {
    // A conversational turn has nothing to verify. This is the single biggest
    // source of saved API calls: most turns in a session are not coding work.
    skip('no_tool_calls', derived.activity);
    return;
  }

  // R3. Budget. A hard ceiling so a pathological session cannot burn quota.
  // Checked AFTER the cheap filters so a skipped turn never spends the allowance.
  if (state.assessmentsUsed >= config.maxAssessments) {
    skip('budget_exhausted', derived.activity);
    return;
  }

  const git = await collectGitFacts(ctx, agent, cwd, signal);

  if (config.requireRepoChange === true && git.changed_files.length === 0 && git.untracked.length === 0) {
    skip('no_repo_change', derived.activity);
    return;
  }

  const taskState = assembleTaskState({
    sessionId,
    turn,
    cwd,
    derived,
    git,
    // The previous assessment, so the policy can tell "the same blocker came back
    // unchanged" (which calls for a different approach) from "a new problem".
    prior: state.lastProbabilities === null
      ? null
      : {
          assessment: state.lastProbabilities,
          action: state.pendingDecision?.action ?? null,
          assessments_used: state.assessmentsUsed,
          max_assessments: config.maxAssessments,
        },
    at: new Date().toISOString(),
  });

  // R4. Fingerprint. Identical material facts mean Jev would repeat its previous
  // answer, so the call is skipped. See fingerprint.js for what counts as material.
  const print = fingerprintState(taskState);
  if (!isMaterialChange(state.lastFingerprint, print.fingerprint)) {
    // The same material facts, so Jev would return the same answer. Logged with the
    // counters so an analysis can prove this rule never cost a needed assessment.
    skip('no_material_change', derived.activity);
    return;
  }
  const changed = changedFields(state.lastFacts, print.facts);

  // R5. Size the state. A state we cannot fit must not be sent truncated: a
  // confident answer about a state Jev never saw is worse than no answer.
  const fitted = fitState(taskState, config.stateTokenBudget);

  const assessmentId = newAssessmentId();
  const started = Date.now();
  let jev = null;
  let jevError = null;
  let decision = null;

  if (fitted === null) {
    jevError = { kind: 'state_overflow', message: 'state exceeded the token budget after every compression stage' };
    stateStore.recordFailure(sessionId, 'state_overflow');
    decision = decideWithoutJev({ state: taskState });
  } else if (apiKey.length === 0) {
    jevError = { kind: 'no_key', message: 'TYPESAFE_API_KEY is not configured' };
    stateStore.recordFailure(sessionId, 'no_key');
    decision = decideWithoutJev({ state: fitted.state });
  } else {
    try {
      jev = await assess({
        apiKey,
        state: fitted.state,
        timeoutMs: config.jevTimeoutMs,
        model: config.jevModel,
        signal,
      });
      decision = decide({ state: fitted.state, probabilities: jev.probabilities });
    } catch (error) {
      // Fail-open: record the failure, keep the diagnostic, do not steer.
      jevError = { kind: error?.kind ?? 'unknown', message: String(error?.message ?? error) };
      stateStore.recordFailure(sessionId, `jev_${jevError.kind}`);
      decision = decideWithoutJev({ state: fitted.state });
    }
  }

  const latencyMs = Date.now() - started;

  // Remember which model answered, so `completion_supervisor_status` can report it
  // without an analysis pass over the JSONL. Only the response's own latency is kept
  // here — `latencyMs` also covers the git probe, which is not Jev's cost.
  if (jev !== null) {
    diagnostics.lastJev = {
      model: jev.model ?? null,
      requested: jev.modelRequested ?? null,
      latencyMs: jev.latencyMs ?? null,
      at: new Date().toISOString(),
    };
  }

  const shadow = config.shadowMode !== false;

  // Whether the POLICY wants to act at all.
  //
  // Since POLICY_VERSION 3 this is the last gate that matters, and it is now a test on the ACTION
  // alone: only P1/P2/P3 return `continue` or `verify_more`, and every probability-derived path
  // returns `finish`. `enforce` stays in the conjunction for the same reason it is still recorded —
  // a rule that wants to say "I fired and must not act" keeps working — but no rule sets it false.
  const policyWantsToAct = decision.action !== ACTIONS.FINISH && decision.action !== ACTIONS.PASS;
  const wouldSteer = policyWantsToAct && decision.enforce !== false;

  // The per-task steer budget, evaluated BEFORE the row is written so the row can say why nothing
  // happened. `would_steer` and `will_steer` are separate fields on purpose: the first is what the
  // policy wanted, the second is what the run-time limits permitted. Collapsing them would make
  // "the policy is too eager" indistinguishable from "the budget ran out", which are opposite
  // diagnoses of the same quiet log.
  const steersUsed = stateStore.steersUsed(sessionId);
  const steerBudgetLeft = steersUsed < config.maxSteersPerTask;
  const willSteer = wouldSteer && !shadow && steerBudgetLeft;
  const steerSuppressed = shadow
    ? 'shadow_mode'
    : !wouldSteer || steerBudgetLeft
      ? null
      : 'per_task_steer_budget';

  // The state we record is the one Jev actually saw (the fitted form). When the
  // state overflowed there is no fitted form, and the raw one may be enormous —
  // writing a 200k-char row would bloat the log for no analytical gain, since the
  // bounded `facts` field already captures every deterministic input to the
  // decision. So an overflowing state is recorded as null with its stage marked.
  const loggedState = fitted === null ? null : fitted.state;

  if (config.logEnabled !== false) {
    log.write(
      assessmentRow({
        assessmentId,
        sessionId,
        turn,
        cwd,
        shadow,
        trigger: 'turn-stopping',
        fingerprint: print.fingerprint,
        fingerprintVersion: print.version,
        changedFields: changed,
        state: loggedState,
        stateTokens: fitted?.tokens ?? null,
        stateStage: fitted?.stage ?? 'overflow',
        decision,
        jev,
        jevError,
        latency: { total: latencyMs, jev: jev?.latencyMs ?? null },
        costUsd: estimateCostUsd(jev?.usage),
        promptVersion: PROMPT_VERSION,
        questionSetHash: QUESTION_SET_HASH,
        taskStateVersion: TASK_STATE_VERSION,
        // Task attribution, so the per-task budget can be checked from the log
        // alone: the same task_key across rows means one budget, a new key means
        // the reset fired.
        taskKey: state.taskKey,
        assessmentsUsedBefore: state.assessmentsUsed,
        maxAssessments: config.maxAssessments,
        // The intervention record: what the policy wanted, what the limits allowed, and how much of
        // the per-task steer budget was already spent when it decided.
        wouldSteer,
        willSteer,
        steerSuppressed,
        steersUsedBefore: steersUsed,
        maxSteersPerTask: config.maxSteersPerTask,
      }),
    );
  }

  stateStore.recordAssessment(sessionId, {
    fingerprint: print.fingerprint,
    facts: print.facts,
    assessmentId,
    decision,
    shadow,
    probabilities: jev?.probabilities ?? null,
  });

  if (jevError !== null) {
    ctx.logger?.warn?.(
      redactSecret(
        `${PLUGIN}: assessment unavailable (${jevError.kind}), allowing the turn to end: ${jevError.message}`,
        apiKey,
      ),
    );
  }

  // ── Action ─────────────────────────────────────────────────────────────────
  if (!wouldSteer) return;

  if (!willSteer) {
    // Two different reasons to hold back, logged apart because they call for different responses.
    // A shadow hold-back is the configured behaviour. A spent steer budget means this task has
    // already been told once, and repeating the demand is how a disagreement becomes a loop.
    ctx.logger?.info?.(
      `${PLUGIN} [${steerSuppressed}] would ${decision.action}: ${decision.reason} (rule ${decision.rule}) — not steering`,
    );
    return;
  }

  // Intervention. Reachable only when shadowMode is explicitly false, the rule is enforceable, and
  // this task still has steer budget.
  const text = renderSteerMessage(decision, fitted?.state ?? taskState);
  agent.steer(supervisorMessage(text));
  stateStore.markIntervened(sessionId, turn);
  ctx.logger?.info?.(
    `${PLUGIN}: steered (${decision.action}, rule ${decision.rule}, ${steersUsed + 1}/${config.maxSteersPerTask} for this task): ${decision.reason}`,
  );
}

/**
 * Build the user-role message we steer into the agent.
 *
 * Built literally rather than with `createUserMessage` from `@deepseek-ai/dsh-llm`
 * so this plugin keeps ZERO dependencies. The shape is the same one
 * `dsh-agent-mailbox` uses for injected input, and `createUserMessage` itself only
 * adds `id` and `role` (dsh-llm/lib/index.js:48-53), so there is nothing to gain
 * from the import. A dependency-free plugin cannot fail to load because a peer
 * package is missing or version-skewed.
 */
function supervisorMessage(text) {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: SUPERVISOR_SOURCE,
  };
}

export default { name, inject, Config, apply };
