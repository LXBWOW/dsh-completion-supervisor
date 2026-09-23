/**
 * Completion Supervisor — TaskState construction.
 *
 * This module turns a DSH session into the compact, mostly-deterministic object
 * that Jev is asked to judge. It is the heart of the "code decides facts, Jev
 * judges sufficiency" split.
 *
 * WHY THIS SHAPE
 * --------------
 * Foreman sends Jev a huge observation (git diff up to 20k chars, worker history,
 * 30 events) and asks nine semantic questions. Its own `ObservationBuilder` then
 * hard-codes `test_results=[]` — it never actually collects test outcomes, so Jev
 * has to infer "tests pass" from the sound of the agent's stdout. That is the
 * clearest weakness in an otherwise excellent design, and it is the one we fix:
 *
 *   - EVERY deterministic fact is computed here, in code: which files changed, how
 *     many lines, which commands ran, what they exited with, which tool results
 *     were errors, and whether the agent's claim contradicts the evidence.
 *   - Jev receives those facts as ground truth and answers only the part code
 *     cannot: "given this evidence, is the user's request actually satisfied?"
 *
 * The most valuable field is `unverified_claims`: the agent says "tests pass" and
 * no test command appears in the turn. Code detects that contradiction with total
 * certainty and for free. No amount of prompt engineering makes an LLM as reliable
 * at it as a string comparison against the recorded commands.
 *
 * SIZING
 * ------
 * State targets ~12k estimated tokens (see tokens.js), well under Jev's 32k
 * state+question ceiling. `fitState` compresses in stages, cheapest first, and
 * only escalates when the previous stage was not enough. If even the last stage
 * does not fit, we do NOT send a partial state — the caller skips Jev and fails
 * open, because a truncated state would produce a confidently wrong answer.
 */

import { estimateJsonTokens, estimateTokens } from './tokens.js';
import { deriveArtifacts } from './artifacts.js';
import { hash32 } from './fingerprint.js';
import { redactSecret } from './redact.js';

/**
 * Whether a `user/message` event was actually authored by the human.
 *
 * MEASURED, NOT ASSUMED — and the first version of this plugin got it wrong in the
 * expensive direction, twice, in two different modules.
 *
 * A real session log shows that a `user/message` carries one of MANY source kinds,
 * and only one of them is the human:
 *
 *   user (rpcId, clientTimeZone)                      <- the human. The ONLY task boundary.
 *   subagent-settled      13 in one measured session  <- a child agent finishing
 *   plugin (hindsight)     9 in the same session      <- memory injection
 *   agent-instructions, skill-catalog, agent-message,
 *   plugin (@deepseek-ai/dsh-system-prompt), plugin (compact),
 *   plugin (agent-mailbox), model, tool, goal, session-reference, ...
 *
 * Both original call sites were deny-lists that excluded only `plugin` and `tool`
 * and accepted EVERYTHING else as the human. Consequences on the measured session:
 *
 *   1. The per-task assessment budget reset several times per real task, because
 *      every `subagent-settled` and every `hindsight` injection counted as a new
 *      user task. The cap silently stopped existing — a reset is not an error and
 *      writes no row, so the log looked healthy throughout.
 *   2. `goal` was taken from whichever user-role message arrived first, and the
 *      second one in that session is an `agent-instructions` block. Jev would have
 *      been asked whether a SYSTEM REMINDER had been completed — text the human
 *      never wrote.
 *
 * So this is an ALLOW-LIST on `kind === 'user'`. A future DSH version that adds
 * another synthetic source then defaults to "not the human", which fails toward
 * assessing less rather than toward an unbounded budget or a fabricated goal. The
 * opposite default is what produced both bugs above.
 *
 * DSH's own `MessageSourceMap` maps `user-rpc` to `kind: 'user'`, so a message
 * sent through the RPC path is still recognised as human-authored.
 *
 * @param {object} source - `message.source`
 * @returns {boolean}
 */
export function isUserAuthored(source) {
  return source?.kind === 'user';
}

/**
 * Bump when the TaskState shape changes; the log records it.
 *
 * v2: commands carry exit_attributable, and tests_passed / build_ok / lint_ok
 *     became genuinely tri-state — a wrapped command whose host exit code belongs to a
 *     later statement now yields null (unknown) instead of a fabricated true. Rows
 *     written under v1 must not be pooled with v2 rows in a threshold analysis: the
 *     same turn could be recorded as a pass under v1 and as unknown under v2.
 *
 * v3: `activity` gained the deterministic artifact facts — `created_or_written_paths`,
 *     `touched_paths`, `material_actions` and `verified_artifacts` — read from STRUCTURED
 *     tool arguments (`write.file_path`, `edit.file_path`, `present.files[].path`). Before
 *     this, a turn in a directory that is not a git repository reached Jev carrying no
 *     evidence that it had produced anything at all, because `repo.changed_files` is empty
 *     there. Jev then scored `requirements_satisfied` low (measured: 0.26-0.48 on every
 *     real turn), which tripped the P4 block rule on turns that were in fact complete.
 *
 *     The QUESTION SET is unchanged, so `question_set_hash` is unchanged: v2 and v3 rows
 *     stay comparable on WHAT WAS ASKED and differ only in what Jev was SHOWN. That is
 *     exactly why this bumps `task_v` and not `prompt_v`.
 *
 * v4: each recorded command gained `output_tail`, `output_truncated` and `output_chars`.
 *
 *     MOTIVATED BY A MEASURED FALSE BLOCK, not by tidiness. In the task_v 3 sample every
 *     completed turn that was blocked was blocked by `P6_evidence_mismatch`, with
 *     `evidence_matches_claim` at 0.40-0.47 against a 0.50 threshold — C1 0.42, C2 0.47,
 *     N2 0.40. In all three the claim quoted something a command had PRINTED ("output
 *     hello, world", "12 files, 4078 lines") while the state carried only the command text
 *     and its exit code. Jev answered that the claim was unsupported by the recorded items,
 *     and it was right: the evidence genuinely was not there. The wording was not too
 *     strict and the threshold was not too low — a fact the agent's own words referred to
 *     had never been put in front of the judge.
 *
 *     So this adds the missing evidence rather than relaxing the test, and it adds exactly
 *     the part of a result that carries a completion signal: the END. Test summaries,
 *     counts, totals and DSH's own exit marker are all at the bottom of an output, which is
 *     the same reason `readToolResult` has always read from the tail.
 *
 *     Still versioned as `task_v` and not `prompt_v`: what Jev is ASKED is untouched, only
 *     what it is SHOWN changed.
 */
export const TASK_STATE_VERSION = 4;

/** Default state budget in estimated tokens. */
export const DEFAULT_STATE_TOKEN_BUDGET = 12000;

/** Command classification patterns, checked in order. */
const COMMAND_KINDS = [
  [/\b(vitest|jest|mocha|pytest|phpunit|rspec|go\s+test|cargo\s+test|dotnet\s+test|npm\s+(run\s+)?test|yarn\s+test|pnpm\s+(run\s+)?test|npx\s+vitest|npx\s+jest)\b/i, 'test'],
  [/\b(tsc|typecheck|type-check|mypy|pyright|flow)\b/i, 'typecheck'],
  [/\b(eslint|oxlint|ruff|flake8|pylint|stylelint|clippy)\b/i, 'lint'],
  [/\b(npm\s+run\s+build|yarn\s+build|pnpm\s+(run\s+)?build|cargo\s+build|go\s+build|dotnet\s+build|make|vite\s+build|webpack|tsup|rollup)\b/i, 'build'],
];

/**
 * Classify a shell command into the evidence categories we care about.
 * Pure and deliberately conservative: an unknown command is 'other', never
 * guessed into a category it might not belong to.
 * @param {string} command
 * @returns {'test'|'typecheck'|'lint'|'build'|'other'}
 */
export function classifyCommand(command) {
  const text = typeof command === 'string' ? command : '';
  if (text.length === 0) return 'other';
  for (const [pattern, kind] of COMMAND_KINDS) {
    if (pattern.test(text)) return kind;
  }
  return 'other';
}

/**
 * How much of one tool result to keep. Larger than the prose limit because this is
 * where the exit marker and the error tail live.
 */
const TOOL_RESULT_TEXT_LIMIT = 20000;

/**
 * Flatten a message's content blocks into plain text (bounded).
 *
 * `from` selects which end survives truncation, and it is not cosmetic: DSH puts
 * its `[exit code: N]` marker at the END of a shell result, so a head read silently
 * converts a failure into a success on any long output. Prose (a claim, a goal)
 * reads from the head; tool results read from the tail.
 *
 * `userFacingOnly` EXCLUDES REASONING BLOCKS, AND THAT IS NOT A NICETY
 * -------------------------------------------------------------------
 * A real `assistant/message` carries `[reasoning, text, tool-call]` — measured on a live
 * session log, that is the most common shape (11 occurrences in one 160-line session,
 * versus 3 for `[reasoning, text]`). BOTH `reasoning` and `text` blocks have a `.text`
 * string, so a reader that concatenates every block with a `.text` produces the model's
 * private thinking followed by its reply, and on a 4000-character head read the thinking
 * fills the budget and the reply is cut off entirely.
 *
 * The consequence was visible in the numbers before the cause was: `evidence_matches_claim`
 * sat at 0.10-0.34 across every real assessment, because Jev was being asked whether the
 * agent's final summary was supported by the recorded evidence while being shown a DRAFT —
 * the model deliberating about which browser to download. A low probability there is the
 * correct answer to the question that was actually asked, which makes it the most
 * expensive kind of defect: the score looks like a calibration problem, so the instinct is
 * to move a threshold, and moving thresholds cannot fix reading the wrong text.
 *
 * An ALLOW-list (`type === 'text'`) rather than a deny-list of `reasoning`, for the same
 * reason `isUserAuthored` is an allow-list: a new private block type must not silently
 * become user-facing prose. The cost of being wrong here is asymmetric — missing a block
 * loses a little context, while admitting one puts thinking into the claim and can block
 * an honest turn.
 *
 * @param {unknown} content
 * @param {number} limit
 * @param {'head'|'tail'} from
 * @param {{userFacingOnly?: boolean}} [opts]
 * @returns {string}
 */
function blocksToText(content, limit = 4000, from = 'head', opts = {}) {
  const cut = (text) => (from === 'tail' ? text.slice(-limit) : text.slice(0, limit));
  if (typeof content === 'string') return cut(content);
  if (!Array.isArray(content)) return '';
  const parts = [];
  // For a tail read we must collect from the END of the block list too: a result
  // split across blocks puts the marker in the last one.
  const blocks = from === 'tail' ? [...content].reverse() : content;
  for (const block of blocks) {
    if (block === null || typeof block !== 'object') continue;
    if (opts.userFacingOnly === true && block.type !== 'text') continue;
    if (typeof block.text === 'string') parts.push(block.text);
    else if (typeof block.content === 'string') parts.push(block.content);
    if (parts.join('\n').length > limit) break;
  }
  const joined = (from === 'tail' ? parts.reverse() : parts).join('\n');
  return cut(joined);
}

/**
 * Extract the tool-call id, name, and arguments from a `tool/call` event.
 *
 * ARGUMENTS ARE A JSON STRING, NOT AN OBJECT (verified against a real session log)
 * ------------------------------------------------------------------------------
 * `appendToolCall` writes the model's raw argument text straight through
 * (`dsh-agent-loop/lib/index.js:687-695`: `arguments: block.arguments`), and
 * `block.arguments` is the raw string the model produced. The parsed form exists
 * only on the EXECUTION path (`parseArguments` at `:520`), which never reaches the
 * session log. A real recorded event therefore looks like:
 *
 *   {"type":"tool/call","data":{"callId":"call_00_..","name":"pwsh",
 *    "arguments":"{\"command\":\"npm test\"}"}}
 *
 * Treating `arguments` as an object yields `{}` for every real call, which makes
 * every shell command invisible — and that is not a harmless information loss: it
 * turns "the agent ran the tests and they passed" into "the agent claimed tests it
 * never ran", i.e. a fabricated contradiction that would produce a spurious
 * intervention. So accept all three shapes seen in practice: a JSON string, an
 * already-parsed object (hand-built events, tests), and unparseable text (kept as
 * `{}` because a half-parsed command is worse than none).
 *
 * @param {object} event
 * @returns {{callId: string, name: string, args: object, turn: number|null}|null}
 */
function readToolCall(event) {
  const data = event?.data;
  if (data === null || typeof data !== 'object') return null;
  return {
    callId: typeof data.callId === 'string' ? data.callId : '',
    name: typeof data.name === 'string' ? data.name : '',
    args: readToolArguments(data.arguments),
    turn: typeof data.turn === 'number' ? data.turn : null,
  };
}

/**
 * Normalize a tool call's `arguments` field to an object.
 * @param {unknown} raw
 * @returns {object}
 */
export function readToolArguments(raw) {
  if (raw !== null && typeof raw === 'object') return raw;
  if (typeof raw !== 'string') return {};
  const text = raw.trim();
  if (text.length === 0) return {};
  try {
    const parsed = JSON.parse(text);
    return parsed !== null && typeof parsed === 'object' ? parsed : {};
  } catch {
    // Invalid JSON is preserved as source text by `parseArguments`, so the call
    // still happened but carries no readable argument. Treat it as argumentless.
    return {};
  }
}

/**
 * Extract the result of a `tool/result` event.
 * Shape verified against a real session log and against
 * `dsh-agent-loop/lib/index.js:697-713`: the data wraps a tool-result message in
 * `{turn, step, message, error?, meta?}`.
 *
 * THE TEXT IS KEPT FROM THE TAIL, AND THAT IS LOAD-BEARING
 * -------------------------------------------------------
 * DSH appends its status markers AFTER the output — `renderPwshResult`
 * (`dsh-tool-pwsh/lib/index.js:59-79`) returns the body and then pushes
 * `[exit code: N]` as the final line. A prefix-preserving truncation therefore
 * throws away exactly the one token that says whether the command succeeded.
 *
 * Measured on a realistic failing test run (900 lines, 31k chars): the prefix cut
 * to 4000 chars ended mid-assertion, `parseExitCode` saw no marker and returned its
 * "absent marker means 0" default, and a FAILING test suite was recorded as a
 * passing one. That inverts the plugin's whole purpose — it would have reported
 * green on the single most important signal it claims to check.
 *
 * So tool results use a tail read. `blocksToText` still defaults to the head for
 * prose (a claim reads from the start), and the distinction is why this function
 * asks for the tail explicitly rather than relying on the shared default.
 */
/**
 * Count the characters of a tool result WITHOUT materialising all of them.
 *
 * Needed only to answer one boolean: "is the text we kept the whole thing?". It
 * deliberately does not call `blocksToText` to find out, because that would allocate the
 * entire output just to measure it — a command that dumps a megabyte would then cost a
 * megabyte of memory per stopping to learn a flag.
 *
 * The separator term mirrors `blocksToText`, which joins blocks with `\n`. The result is a
 * size reading behind a boolean, so an off-by-one here cannot change any judgement.
 *
 * @param {unknown} content
 * @returns {number}
 */
function contentTextLength(content) {
  if (typeof content === 'string') return content.length;
  if (!Array.isArray(content)) return 0;
  let total = 0;
  let counted = 0;
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue;
    if (typeof block.text === 'string') {
      total += block.text.length;
      counted += 1;
    } else if (typeof block.content === 'string') {
      total += block.content.length;
      counted += 1;
    }
  }
  return counted > 1 ? total + (counted - 1) : total;
}

function readToolResult(event) {
  const data = event?.data;
  if (data === null || typeof data !== 'object') return null;
  const message = data.message;
  const block = Array.isArray(message?.content)
    ? message.content.find((item) => item?.type === 'tool-result')
    : undefined;
  return {
    callId: typeof block?.toolCallId === 'string' ? block.toolCallId : '',
    text: blocksToText(block?.content, TOOL_RESULT_TEXT_LIMIT, 'tail'),
    // The FULL length, before the tail window cut it. `text` above is the last 20k chars,
    // so a comparison against `text.length` would report a 31k output as "not truncated"
    // exactly when the truncation is largest. See `commandOutputEntry`.
    textChars: contentTextLength(block?.content),
    isError: block?.isError === true,
    turn: typeof data.turn === 'number' ? data.turn : null,
  };
}

/**
 * Read the exit code a shell tool encoded in its rendered result.
 *
 * DSH's shell tools append `\n[exit code: N]` (or `[killed by signal: X]`) to the
 * text the model sees, and `dsh-shell` exports the exact inverse parser. We
 * reimplement only the narrow part we need here so this module needs no DSH
 * import and stays unit-testable; the marker contract is quoted in the source
 * (`dsh-shell/lib/index.js:31-46`).
 *
 * Absent marker means a clean exit 0 — that is the contract, not a guess.
 *
 * @param {string} text
 * @returns {number|null} exit code, or null when only a signal is known.
 */
export function parseExitCode(text) {
  if (typeof text !== 'string') return null;
  const signal = /\n\[killed by signal: ([^\]\n]+)\]$/.exec(text);
  if (signal !== null) return null;
  const exit = /\n\[exit code: (\d+)\]$/.exec(text);
  if (exit !== null) return Number(exit[1]);
  return 0;
}

/** Extract the command string a tool call carried, whatever the tool is. */
function commandOf(call) {
  const args = call?.args ?? {};
  for (const key of ['command', 'cmd', 'script']) {
    if (typeof args[key] === 'string' && args[key].trim().length > 0) return args[key];
  }
  return '';
}

/** Tools whose calls count as "the agent ran something". */
const SHELL_TOOLS = new Set(['pwsh', 'bash', 'shell', 'pwsh_persistent', 'bash_persistent']);

/** A trailing `exit $LASTEXITCODE` / `exit $?` that deliberately forwards the code. */
const PASSTHROUGH_EXIT = /^exit\s+(?:\$LASTEXITCODE|\$\?)\s*$/i;

/**
 * Split a shell command into its top-level statements.
 *
 * `;` and a newline separate statements, but only OUTSIDE quotes and OUTSIDE brackets,
 * so `Write-Output "a; b"` stays one statement and `$(...)` contents do not split their
 * container. A line ending in a continuation character (`|`, `,`, `+`, an opening
 * bracket, or a backtick) continues onto the next line rather than ending a statement.
 *
 * @param {string} command
 * @returns {string[]} trimmed, non-empty statements in order.
 */
export function topLevelStatements(command) {
  const text = typeof command === 'string' ? command : '';
  const statements = [];
  let current = '';
  let quote = null;
  let depth = 0;

  const flush = () => {
    const trimmed = current.trim();
    if (trimmed.length > 0) statements.push(trimmed);
    current = '';
  };

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];

    if (quote !== null) {
      current += ch;
      if (quote === "'") {
        // Inside single quotes PowerShell escapes a quote by doubling it.
        if (ch === "'") {
          if (text[i + 1] === "'") { current += text[i + 1]; i += 1; }
          else quote = null;
        }
      } else if (quote === '"') {
        if (ch === '`') {
          // Backtick escapes the next character, including a quote.
          if (i + 1 < text.length) { current += text[i + 1]; i += 1; }
        } else if (ch === '"') {
          if (text[i + 1] === '"') { current += text[i + 1]; i += 1; }
          else quote = null;
        }
      }
      continue;
    }

    if (ch === "'" || ch === '"') { quote = ch; current += ch; continue; }
    if (ch === '(' || ch === '{' || ch === '[') { depth += 1; current += ch; continue; }
    if (ch === ')' || ch === '}' || ch === ']') { depth = Math.max(0, depth - 1); current += ch; continue; }

    if (depth === 0 && (ch === ';' || ch === '\n' || ch === '\r')) {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      // A continuation character means the statement is not finished yet.
      const tail = current.trimEnd();
      if (tail.length > 0 && '|,+({`'.includes(tail[tail.length - 1])) {
        current += ' ';
        continue;
      }
      flush();
      continue;
    }

    current += ch;
  }

  flush();
  return statements;
}

/**
 * Whether a shell invocation's exit code can be attributed to the classified command.
 *
 * MEASURED, AND IT IS NOT ALWAYS TRUE — this is the second fabricated-pass bug found
 * on real data, and it is subtler than the truncation one.
 *
 * DSH's `[exit code: N]` marker carries the exit code of the SHELL HOST, which in
 * Windows PowerShell is the code of the LAST STATEMENT. When an agent wraps a command
 * to capture its output — `$out = npm test 2>&1; $code = $LASTEXITCODE; Write-Output …`
 * — the last statement is the `Write-Output`, so the host exits 0 no matter what the
 * tests did. `tools/measure-exit-shapes.mjs` runs each shape for real:
 *
 *   npm test                                      -> 1   faithful
 *   npm test 2>&1 | Select-Object -Last 3         -> 1   faithful
 *   cd <dir>; npm test                            -> 1   faithful
 *   npm test; exit $LASTEXITCODE                  -> 1   faithful
 *   npm test; Write-Output "after"                -> 0   MASKED
 *   npm test > $null 2>&1; Write-Output "after"   -> 0   MASKED
 *   $out = npm test 2>&1; …; Write-Output "…"     -> 0   MASKED
 *
 * On the first real-Jev round a subagent wrote the last shape, and a test suite that
 * really failed (npm exit 1) was recorded as `tests_passed: true`. That is the exact
 * fabrication this plugin exists to catch: the agent's claim was honest, and the
 * plugin's own evidence was wrong.
 *
 * The rule that matches every measured shape: with one statement the marker is the
 * command's own code; with several, the code belongs to the last one unless that last
 * statement is an explicit `exit $LASTEXITCODE` passthrough.
 *
 * @param {string} command
 * @param {string} [kind] - the classification the caller acted on.
 * @returns {boolean}
 */
export function exitCodeIsAttributable(command, kind) {
  const statements = topLevelStatements(command);
  if (statements.length <= 1) return true;
  if (kind === undefined || kind === 'other') return true;
  const last = statements[statements.length - 1];
  if (PASSTHROUGH_EXIT.test(last)) return true;
  return classifyCommand(last) === kind;
}

/** Per-command output budget, in characters, for the state sent to Jev. */
export const COMMAND_OUTPUT_LIMIT = 1500;

/** Total output budget across all commands in one state, in characters. */
export const COMMAND_OUTPUT_TOTAL_LIMIT = 4000;

/**
 * Strip what carries no meaning and keep what does.
 *
 * NOT a whitespace collapse, deliberately. Collapsing every run of whitespace would destroy
 * the line structure of exactly the outputs that matter most: a test summary, a line-count
 * table, or a directory listing is read through its lines, and flattening them makes
 * "12 files, 4078 lines total" indistinguishable from a wall of text. So newlines and inner
 * spacing survive; only trailing blanks, runs of three or more blank lines, carriage returns
 * and ANSI escapes are removed.
 *
 * ANSI earns its place on this machine specifically: the shell is Windows PowerShell 5.1,
 * which writes colour codes into captured output, and those bytes are pure token cost for
 * Jev.
 *
 * @param {string} text
 * @param {string} secret
 * @returns {string}
 */
function tidyCommandOutput(text, secret) {
  const raw = typeof text === 'string' ? text : '';
  const cleaned = raw
    .replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n');
  // Redaction is the LAST step so it also covers anything the transformations above could
  // have re-joined, and so the caller cannot get a redacted-then-reformatted string back.
  return redactSecret(cleaned, secret).trim();
}

/**
 * Shape the raw recorded commands for the TaskState.
 *
 * TWO BUDGETS, AND THEY ARE NOT THE SAME BUDGET
 * ---------------------------------------------
 * `COMMAND_OUTPUT_LIMIT` bounds one command; `COMMAND_OUTPUT_TOTAL_LIMIT` bounds all of them
 * together. Both are needed: a single 200k-character build log would otherwise eat the whole
 * 12k-token state, and `fitState` would then have to degrade the GOAL and the CLAIM — the two
 * texts the judgement is actually about — to make room for a log tail.
 *
 * The shared budget is spent NEWEST FIRST, because the most recent command is the one a
 * closing claim refers to. Earlier commands keep their exit code and lose only their output,
 * which is the right trade: the exit code is what `tests_passed` is derived from, and it is
 * the older commands that a claim is least likely to quote.
 *
 * `output_hash` is computed from the command's own bounded output BEFORE the shared budget is
 * applied, which is what keeps the fingerprint stable. Computing it afterwards would make two
 * identical turns fingerprint differently whenever a later command happened to consume the
 * remaining budget — a `no_material_change` skip lost for no reason.
 *
 * @param {Array<object>} list - raw entries carrying `__text` and `__chars`.
 * @param {string} secret
 * @returns {Array<object>}
 */
function attachCommandOutput(list, secret) {
  const shaped = list.map((entry) => {
    const text = tidyCommandOutput(entry.__text, secret);
    return {
      cmd: entry.cmd,
      exit: entry.exit,
      exit_attributable: entry.exit_attributable,
      kind: entry.kind,
      // The tail, for the same reason `readToolResult` reads from the tail: the conclusion,
      // the totals and DSH's exit marker are all at the end.
      output_tail: text.length <= COMMAND_OUTPUT_LIMIT ? text : text.slice(-COMMAND_OUTPUT_LIMIT),
      // Compared against the ORIGINAL length, not the tail window's, so a 31k output is not
      // reported as "not truncated" merely because the reader had already cut it to 20k.
      output_truncated: (entry.__chars ?? text.length) > COMMAND_OUTPUT_LIMIT,
      output_chars: entry.__chars ?? text.length,
      output_hash: text.length > 0 ? hash32(text) : '',
    };
  });

  let remaining = COMMAND_OUTPUT_TOTAL_LIMIT;
  for (let index = shaped.length - 1; index >= 0; index -= 1) {
    const length = shaped[index].output_tail.length;
    if (length <= remaining) {
      remaining -= length;
      continue;
    }
    shaped[index].output_tail = remaining > 0 ? shaped[index].output_tail.slice(-remaining) : '';
    shaped[index].output_truncated = true;
    remaining = 0;
  }

  return shaped;
}

/**
 * Tools that only move text around, so a turn consisting solely of them did no
 * work on the user's problem.
 *
 * OBSERVED, NOT ASSUMED. This set exists because a real smoke test showed a
 * "purely conversational" subagent turn still reporting one tool call: the harness
 * instructs a subagent to return its result via `send_message`, so message passing
 * counts as a tool call and `requireToolCall` cannot distinguish "did work" from
 * "reported back". That makes `tool_calls_this_turn` a poor proxy for substance.
 *
 * This is a DENY-LIST, deliberately, because it is safe in the direction that
 * matters: an unlisted tool is treated as material, so a new tool (browser, a
 * Codex bridge, a worktree helper) is never silently classified as non-work. The
 * cost of being wrong here is only that a chatty turn gets assessed anyway, which
 * is the status quo. An allow-list would instead start SKIPPING turns as soon as
 * some new tool appeared, and a skipped assessment is invisible — nothing in the
 * log would show the omission.
 *
 * Recorded but NOT acted on: nothing skips on this yet. The distribution has to be
 * observed on real data before it is allowed to save an API call.
 */
const MESSAGE_ONLY_TOOLS = new Set([
  'send_message',
  'agent_send_message',
  'agent_check_mailbox',
  'send_input',
  'mailbox',
  'ask_user_question',
  'todo_write',
]);

/**
 * Classify one tool name as material work or message passing.
 * @param {string} name
 * @returns {'material'|'message'}
 */
export function classifyToolActivity(name) {
  return MESSAGE_ONLY_TOOLS.has(name) ? 'message' : 'material';
}

/**
 * That classification applied to a whole turn.
 * @param {Iterable<string>} names
 * @returns {{total: number, material: number, message_only: number, material_names: string[]}}
 */
export function summariseToolActivity(names) {
  const list = [...names];
  const materialNames = list.filter((name) => classifyToolActivity(name) === 'material');
  return {
    total: list.length,
    material: materialNames.length,
    message_only: list.length - materialNames.length,
    // Bounded and sorted so the log line is comparable between rows.
    material_names: [...new Set(materialNames)].sort().slice(0, 20),
  };
}

/**
 * Claim phrases that assert a verification actually happened. Used to detect the
 * case where the agent says it tested but no test command appears in the turn.
 * Deliberately narrow: a false positive here would create a spurious "continue".
 */
const TEST_CLAIM_PATTERNS = [
  /\btests?\s+(?:all\s+)?(?:pass|passed|passing|are\s+green|succeed|succeeded)\b/i,
  /\ball\s+(?:the\s+)?tests?\s+(?:pass|passed|green)\b/i,
  /\bverified\s+by\s+(?:running\s+)?tests?\b/i,
  /\btest\s+suite\s+(?:passes|passed|is\s+green)\b/i,
  /\b(?:build|compile|lint|typecheck|type-check)\s+(?:passes|passed|succeeds|succeeded|is\s+clean)\b/i,
  /\bno\s+(?:test\s+)?failures?\b/i,
];

/**
 * Find assertions in the agent's final claim that the recorded evidence does not
 * support. This is the single highest-value deterministic check in the plugin.
 *
 * Deduplicates by CATEGORY, not by matched phrase: the pattern list deliberately
 * overlaps (a sentence like "all tests pass" is matched by two patterns), and
 * reporting the same missing verification twice in a steer message would just
 * make the message longer without adding information. One line per category is
 * what the agent can act on.
 *
 * @param {string} claim
 * @param {{tests_run: boolean, build_ok: boolean|null, lint_ok: boolean|null}} evidence
 * @returns {string[]} short descriptions of unsupported claims, one per category.
 */
export function detectUnverifiedClaims(claim, evidence) {
  const text = typeof claim === 'string' ? claim : '';
  if (text.length === 0) return [];

  const unsupported = [];
  const reported = new Set();

  for (const pattern of TEST_CLAIM_PATTERNS) {
    const match = pattern.exec(text);
    if (match === null) continue;
    const phrase = match[0].trim();

    // Which category does this pattern's match claim, and is it actually backed?
    let category = null;
    let description = null;

    if (/\btests?\b|\btest\s+suite\b/i.test(phrase)) {
      if (!evidence.tests_run) {
        category = 'test';
        description = `claims "${phrase}" but no test command was recorded this turn`;
      } else if (evidence.tests_passed !== true) {
        category = 'test';
        description = `claims "${phrase}" but the recorded test run did not pass`;
      }
    } else if (/\bbuild\b|\bcompile\b/i.test(phrase)) {
      if (evidence.build_ok === false) {
        category = 'build';
        description = `claims "${phrase}" but the recorded build failed`;
      } else if (evidence.build_ok === null && !evidence.tests_run) {
        category = 'build';
        description = `claims "${phrase}" but no build command was recorded this turn`;
      }
    } else if (/\blint\b|\btypecheck\b|\btype-check\b/i.test(phrase)) {
      if (evidence.lint_ok === false) {
        category = 'lint';
        description = `claims "${phrase}" but the recorded lint/typecheck did not pass`;
      } else if (evidence.lint_ok === null) {
        category = 'lint';
        description = `claims "${phrase}" but no lint/typecheck command was recorded this turn`;
      }
    }

    if (category !== null && !reported.has(category)) {
      reported.add(category);
      unsupported.push(description);
    }
  }

  return unsupported.slice(0, 5);
}

/**
 * Derive deterministic evidence from the session events of one turn.
 *
 * PURE: takes an array of events, returns facts. No DSH, no I/O, no clock. This
 * is the function the tests exercise hardest, because a bug here silently
 * corrupts every judgement the plugin makes.
 *
 * @param {Array<{type: string, data: unknown, seq?: number}>} events
 * @param {number} turn
 * @param {{cwd?: string|null, secret?: string}} [opts] - `cwd` is the session working
 *   directory, used ONLY to shorten artifact paths (see `artifacts.js`); it never affects
 *   which facts are derived. `secret` is scrubbed out of recorded command output before that
 *   text can enter the state (see `redact.js`); it never affects which facts are derived
 *   either. Both are presentation inputs only.
 * @returns {object} evidence + the command list + the artifact facts + the final claim.
 */
export function deriveEvidence(events, turn, opts = {}) {
  const calls = new Map();
  const commands = [];
  const errorResults = [];
  /**
   * Whether each call's result reported an error, keyed by call id.
   *
   * Tracked separately from `calls` because a result arrives in a LATER event than its
   * call, and the artifact facts need both halves: a write whose result reported an error
   * is still an action that happened, but it is not something the turn delivered.
   */
  const okByCallId = new Map();
  let claim = '';
  let goal = '';
  let toolCallsThisTurn = 0;
  const toolsUsed = new Set();

  for (const event of events ?? []) {
    if (event === null || typeof event !== 'object') continue;
    const type = event.type;

    if (type === 'tool/call') {
      const call = readToolCall(event);
      if (call === null) continue;
      if (call.turn !== null && call.turn !== turn) continue;
      calls.set(call.callId, call);
      toolCallsThisTurn += 1;
      if (call.name) toolsUsed.add(call.name);
      continue;
    }

    if (type === 'tool/result') {
      const result = readToolResult(event);
      if (result === null) continue;
      if (result.turn !== null && result.turn !== turn) continue;
      // `isError` is a real structured field on the result block, so this is an observation
      // rather than a reading of the prose. It is the ONLY deterministic success signal
      // available: every one of the 1375 tool results in the sampled logs was plain text.
      okByCallId.set(result.callId, result.isError !== true);
      const call = calls.get(result.callId);

      if (call !== undefined && SHELL_TOOLS.has(call.name)) {
        const cmd = commandOf(call);
        const kind = classifyCommand(cmd);
        // Whether this exit code is about THIS command, or about whatever statement the
        // agent happened to leave last. Both the raw code and the flag are recorded, so
        // a reader can see "the host said 0, but that was the wrapper's code" rather
        // than a bare 0 that looks like a pass.
        const attributable = exitCodeIsAttributable(cmd, kind);
        commands.push({
          cmd: cmd.replace(/\s+/g, ' ').trim().slice(0, 200),
          exit: parseExitCode(result.text),
          exit_attributable: attributable,
          kind,
          // Carried to `attachCommandOutput` and stripped there. Prefixed because these are
          // inputs to shaping rather than facts of the state: `output_tail` may legitimately
          // end up empty under the shared budget, while `__text` is what the command really
          // printed. Nothing downstream may read a `__`-prefixed field.
          __text: result.text,
          __chars: result.textChars,
        });
      }
      if (result.isError) {
        errorResults.push({
          tool: call?.name ?? 'unknown',
          msg: result.text.replace(/\s+/g, ' ').trim().slice(0, 300),
        });
      }
      continue;
    }

    if (type === 'assistant/message') {
      const data = event.data;
      const message = data?.message;
      const messageTurn = typeof data?.turn === 'number' ? data.turn : null;
      if (messageTurn !== null && messageTurn !== turn) continue;
      const text = blocksToText(message?.content, 4000, 'head', { userFacingOnly: true });
      // The LAST USER-FACING assistant text of the turn is the completion claim.
      //
      // A message carrying only reasoning leaves `text` empty and the previous claim
      // stands, which is the correct behaviour: a mid-turn deliberation step is not a
      // completion statement, and letting one overwrite the claim is exactly how the
      // model's private thinking got sent to Jev as "the agent's final summary".
      if (text.trim().length > 0) claim = text;
      continue;
    }

    if (type === 'user/message') {
      // `user/message` appends the message itself as data (no {turn, message} wrapper).
      const message = event.data;
      if (message === null || typeof message !== 'object') continue;
      // ONLY the human's message is the goal. The first version of this excluded
      // `plugin` and `tool` and accepted everything else, which on a real session
      // meant `agent-instructions`, `skill-catalog`, `subagent-settled` and
      // `plugin (hindsight)` were all candidates for "the user's requirement" —
      // and whichever arrived first won, because of the `goal.length === 0` guard
      // below. Measured on one session, the second user-role message is an
      // `agent-instructions` block, so the goal would have been a system reminder
      // that the human never wrote. See `isUserAuthored` in log.js.
      if (!isUserAuthored(message.source)) continue;
      // A user-role message on this machine carries a single `[text]` block, so the
      // user-facing filter changes nothing here today. It is applied anyway so the rule
      // is "prose the reader is meant to see", stated once, rather than two different
      // rules that happen to agree on the current data.
      const text = blocksToText(message.content, 4000, 'head', { userFacingOnly: true });
      if (text.trim().length > 0 && goal.length === 0) goal = text;
    }
  }

  // Keep the most recent commands only; older ones are usually superseded. The output tail
  // is attached here rather than at collection time because the shared budget is spent over
  // the surviving list, newest first.
  const recentCommands = attachCommandOutput(commands.slice(-12), opts.secret ?? '');

  const testCommands = recentCommands.filter((entry) => entry.kind === 'test');
  const buildCommands = recentCommands.filter((entry) => entry.kind === 'build');
  const lintCommands = recentCommands.filter((entry) => entry.kind === 'lint' || entry.kind === 'typecheck');

  // A command whose exit code belongs to a different statement (a wrapper) is recorded
  // with `exit_attributable: false`, and that must NOT be read as either outcome.
  // Treating it as "passed" is the bug that let a failing suite through; treating it as
  // "failed" would manufacture a false accusation against an honest turn. So the verdict
  // is tri-state, and only a DEFINITE failure — or an unbroken run of definite
  // successes — resolves it. For an unattributable command the underlying exit is still
  // visible in `commands[]` for a reader, it just does not vote here.
  const verdict = (list) => {
    if (list.length === 0) return null;
    const votes = list.map((entry) => (entry.exit_attributable === false ? null : entry.exit));
    if (votes.some((code) => code !== null && code !== 0)) return false;
    // Every command we can read passed, but if some could not be read the run as a
    // whole is not a definite pass.
    return votes.every((code) => code === 0) ? true : null;
  };

  const evidence = {
    tests_run: testCommands.length > 0,
    tests_passed: verdict(testCommands),
    build_ok: verdict(buildCommands),
    lint_ok: verdict(lintCommands),
    error_results: errorResults.slice(-5),
    unverified_claims: [],
  };

  evidence.unverified_claims = detectUnverifiedClaims(claim, evidence);

  // The artifact facts, from the STRUCTURED tool arguments only. See `artifacts.js` for the
  // allow-list and for why a shell command is never parsed to guess what it produced.
  const artifacts = deriveArtifacts(
    [...calls.values()].map((call) => ({
      name: call.name,
      args: call.args,
      ok: okByCallId.get(call.callId) !== false,
    })),
    { cwd: opts.cwd ?? null },
  );

  return {
    evidence,
    commands: recentCommands,
    artifacts,
    claim: claim.slice(0, 2000),
    goal: goal.slice(0, 2000),
    activity: {
      tool_calls_this_turn: toolCallsThisTurn,
      tools_used: [...toolsUsed].slice(0, 20),
      // The two-fact split requested after a real smoke test showed that a
      // "conversational" turn still carries a tool call (the harness makes a
      // subagent report back with `send_message`). Recorded only — nothing skips on
      // it yet, so the distribution can be observed on real data before it is
      // trusted to save an API call.
      ...summariseToolActivity(toolsUsed),
      ...artifacts,
    },
  };
}

/**
 * Assemble a TaskState from derived evidence plus git facts.
 * @returns {object} the state sent to Jev.
 */
export function assembleTaskState({ sessionId, turn, cwd, derived, git, prior, at }) {
  return {
    task_v: TASK_STATE_VERSION,
    session_id: sessionId,
    turn,
    cwd,
    at,

    goal: derived.goal,
    claim: derived.claim,

    repo: {
      changed_files: git.changed_files,
      untracked: git.untracked,
      insertions: git.insertions,
      deletions: git.deletions,
      // Whether git could be read at all. Without this, "no files changed" and
      // "git was unreachable" produce byte-identical states — and this machine's
      // default working directory is NOT a git repository, so the second case is
      // the common one here. A judgement made with no repository visibility must be
      // distinguishable from one made with a clean repository, both by Jev and by
      // whoever reads the log afterwards.
      available: git.available === true,
    },

    commands: derived.commands,
    evidence: derived.evidence,
    activity: derived.activity,

    prior: prior ?? null,
  };
}

/**
 * Compress a TaskState until it fits the token budget.
 *
 * Stages escalate cheapest-first. Every stage is a strict information reduction,
 * and the stage name is returned so the log records how much we had to degrade —
 * a judgement made from a heavily compressed state deserves less trust, and
 * knowing which stage ran is what lets a later analysis tell them apart.
 *
 * Returns null when even the last stage does not fit. The caller must then skip
 * Jev entirely: sending a truncated state would produce a confident answer about
 * a situation Jev never actually saw, which is worse than no answer at all.
 *
 * @param {object} state
 * @param {number} budget - estimated token ceiling.
 * @returns {{state: object, tokens: number, stage: string}|null}
 */
export function fitState(state, budget = DEFAULT_STATE_TOKEN_BUDGET) {
  const measure = (candidate) => estimateJsonTokens(candidate);

  let current = state;
  let tokens = measure(current);
  if (tokens <= budget) return { state: current, tokens, stage: 'full' };

  const stages = [
    // Cheapest loss first. Shrinking output costs Jev detail; halving the command LIST would
    // drop whole commands together with the exit codes `tests_passed` is derived from. So the
    // output shrinks before the list does.
    [
      'command output<=300',
      (s) => ({
        ...s,
        // Defensive on the field's TYPE, not just its length. `fitState` is also reached by
        // callers that assemble a state by hand, and a compression stage that throws would turn
        // an oversized state into a crashed turn instead of a smaller state — the wrong failure
        // in both directions.
        commands: s.commands.map((entry) =>
          typeof entry.output_tail === 'string' && entry.output_tail.length > 300
            ? { ...entry, output_tail: entry.output_tail.slice(-300), output_truncated: true }
            : entry,
        ),
      }),
    ],
    ['commands<=6', (s) => ({ ...s, commands: s.commands.slice(-6) })],
    ['claim<=800', (s) => ({ ...s, claim: tail(s.claim, 800) })],
    ['goal<=800', (s) => ({ ...s, goal: head(s.goal, 800) })],
    [
      'files<=30',
      (s) => ({
        ...s,
        repo: { ...s.repo, changed_files: s.repo.changed_files.slice(0, 30), untracked: s.repo.untracked.slice(0, 10) },
      }),
    ],
    ['repo counts only', (s) => ({ ...s, repo: { changed_files: [], untracked: [], insertions: s.repo.insertions, deletions: s.repo.deletions, available: s.repo.available } })],
    ['evidence errors<=2', (s) => ({ ...s, evidence: { ...s.evidence, error_results: s.evidence.error_results.slice(-2) } })],
    ['prior dropped', (s) => ({ ...s, prior: null })],
    ['activity dropped', (s) => ({ ...s, activity: { tool_calls_this_turn: s.activity.tool_calls_this_turn, tools_used: [] } })],
  ];

  for (const [stage, transform] of stages) {
    current = transform(current);
    tokens = measure(current);
    if (tokens <= budget) return { state: current, tokens, stage };
  }

  return null;
}

/** Keep the head of a string (for goals: the request comes first). */
function head(text, limit) {
  const value = typeof text === 'string' ? text : '';
  return value.length <= limit ? value : `${value.slice(0, limit)}…`;
}

/** Keep the tail of a string (for claims: the conclusion comes last). */
function tail(text, limit) {
  const value = typeof text === 'string' ? text : '';
  return value.length <= limit ? value : `…${value.slice(-limit)}`;
}

/**
 * Compute the cost of one assessment from Jev's reported usage.
 * Jev input costs $0.042/M tokens and output is free; measured latency on the
 * official API was 566-850ms per call.
 * @param {object|null} usage
 * @returns {number} dollars, or 0 when usage is unavailable.
 */
export function estimateCostUsd(usage) {
  const inputTokens = Number(usage?.input_tokens ?? usage?.inputTokens ?? 0);
  if (!Number.isFinite(inputTokens) || inputTokens <= 0) return 0;
  return (inputTokens / 1_000_000) * 0.042;
}

/** Re-export for callers that only need the size of a text blob. */
export { estimateTokens };
