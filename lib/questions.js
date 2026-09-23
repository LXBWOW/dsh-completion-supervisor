/**
 * Completion Supervisor — Jev question set.
 *
 * Seven `noul` (yes/no probability) questions, asked in ONE batched request. This is the single
 * most important design decision in the plugin: batching turns the cost of supervision from "one
 * API call per tool call" (the abandoned command-gate approach) into "one API call per completion
 * claim".
 *
 * HOW THESE WERE WRITTEN
 * ----------------------
 * Each `instructions` string is (a) one proposition that can be true or false, (b) phrased so that
 * a HIGH probability means "YES, this holds", and (c) scoped so it does NOT duplicate what
 * deterministic code already decided.
 *
 * Rules we follow:
 *   - Never ask what code can compute. "Did the tests pass?" is answered by reading exit codes. We
 *     ask whether the EVIDENCE SUFFICES, which is the part code cannot judge.
 *   - Never ask two things at once. "Is it done and tested?" gives an uninterpretable probability.
 *   - Name the evidence explicitly ("as recorded", "the recorded artifacts") so Jev grounds its
 *     answer in the state we sent rather than in what a coding agent usually says.
 *
 * v2 — WHY THE QUESTIONS ARE NOW TASK-TYPE-AGNOSTIC
 * -------------------------------------------------
 * v1 was written as if every task were a code change, and three of the seven questions said so out
 * loud: `requirements_satisfied` asked whether "the repository state" met the request,
 * `implementation_complete` presupposed an implementation, and `tests_sufficient` required coverage
 * "for what was changed" with passing tests visible in the commands.
 *
 * Measured consequence, across 22 real assessments: `requirements_satisfied` never exceeded 0.54
 * and had a median of 0.26, so the P4 block rule (`req < 0.40`) fired on turns that were complete.
 * Every one of those turns was a real task — run a command and report, download a browser, answer a
 * question — and NOT ONE modified a repository. For those tasks the honest answer to "does the
 * repository state satisfy the request" is low, which makes the low score a CORRECT ANSWER TO THE
 * WRONG QUESTION. That failure mode is expensive precisely because it looks like a calibration
 * problem: the instinct is to move a threshold, and no threshold can fix a question about something
 * that does not exist.
 *
 * The artifacts layer (task_v 3) closed half the gap. The file-creating task moved
 * `requirements_satisfied` from 0.26 to 0.53 — past the 0.40 boundary — and that was the only
 * change in that round larger than the measured sampling noise (see `probe-determinism`). Tasks
 * that produce no file stayed low, and they always will while the question asks about a repository.
 *
 * So v2 asks about the REQUEST and the EVIDENCE and lets the task type decide what evidence means.
 * The policy is untouched: the same seven names are read by the same rules with the same numbers,
 * so this round isolates exactly one variable — the wording.
 *
 * `PROMPT_VERSION` and `QUESTION_SET_HASH` both change, keeping v1 rows identifiable as a baseline
 * rather than pooled with these by accident.
 *
 * All seven are required: a response missing any one is rejected outright, so a partial answer can
 * never be silently interpreted as "fine, finish".
 */

import { createHash } from 'node:crypto';

/** Bump when any instruction string changes; the log records this value. */
export const PROMPT_VERSION = 2;

/** Question name -> instructions. Order is the order they are declared here. */
export const JEV_QUESTIONS = Object.freeze({
  requirements_satisfied: Object.freeze({
    type: 'noul',
    instructions:
      'The outcome the request asked for has actually been achieved, judged from the recorded ' +
      'execution evidence and the recorded artifacts. Answer about what the request asked for, ' +
      'not merely about the part the assistant chose to describe in its summary.',
  }),

  implementation_complete: Object.freeze({
    type: 'noul',
    instructions:
      'The substantive work the request requires is complete, with nothing left half-done, ' +
      'deferred, or waiting on a step that was never taken. What counts as substantive depends ' +
      'on the task: it may be a code change, a generated file, a download, or an answer.',
  }),

  /**
   * Renamed from `tests_sufficient`. This is a pure rename plus rewording — it is read by the same
   * P7 rule with the same threshold — and it is done because a field called `tests_sufficient` that
   * no longer asks about tests is exactly the kind of name/semantics mismatch this project keeps
   * paying for. A future reader would trust the name and misread every row.
   */
  verification_sufficient: Object.freeze({
    type: 'noul',
    instructions:
      'The evidence recorded for this turn is sufficient, for a task of this kind, to support the ' +
      'claim that it is finished. A code change may be evidenced by tests or a build; a download, ' +
      'a generated file, or an answered question is not made weaker by having no tests.',
  }),

  blocking_issue_remaining: Object.freeze({
    type: 'noul',
    instructions:
      "A known problem still stands that would prevent the request from being met. Answer yes if " +
      'anything recorded still blocks it.',
  }),

  evidence_matches_claim: Object.freeze({
    type: 'noul',
    instructions:
      'The user-visible final claim is supported by the deterministic facts and the artifacts ' +
      'recorded in this state. Compare the claim against those recorded items only, and not ' +
      'against what a task of this kind would usually involve.',
  }),

  needs_more_verification: Object.freeze({
    type: 'noul',
    instructions:
      'An independent check would materially reduce the chance that the completion claim is ' +
      'wrong. This is about the risk of being wrong, and not about whether tests exist.',
  }),

  ready_to_finish: Object.freeze({
    type: 'noul',
    instructions:
      'Given the evidence above, ending the task now and returning this result to the user is ' +
      'reasonable.',
  }),
});

/** The seven names, in declaration order. Used for validation and logging. */
export const JEV_QUESTION_NAMES = Object.freeze(Object.keys(JEV_QUESTIONS));

/**
 * A content hash of the question set, computed at load time.
 *
 * WHY BOTH A VERSION NUMBER AND A HASH
 * ------------------------------------
 * `PROMPT_VERSION` is hand-maintained, and its failure mode is a silent one: edit an
 * instruction, forget to bump, and the log then claims two different question sets
 * produced the same `prompt_v`. Every probability comparison an analysis makes across
 * that boundary is wrong, and nothing in the data reveals it.
 *
 * A hash cannot be forgotten, because it is derived rather than declared. So the two
 * serve different readers:
 *   - `prompt_v` is the human label — short, ordered, comfortable to reason about.
 *   - `question_set_hash` is the machine check — it changes iff the questions change,
 *     so grouping rows by it is always correct even if a bump was missed.
 *
 * What it covers: each question's NAME and its `instructions`, in declaration order. Order is
 * included because reordering changes which answer belongs to which index in a batched request —
 * and this is also why the v2 rename of `tests_sufficient` shows up in the hash rather than hiding
 * behind an unchanged instruction: the ANSWER for that key now means something else, so rows
 * carrying the old key must never be read as if they carried the new one.
 *
 * What it deliberately does NOT cover: `POSITIVE_QUESTIONS` / `NEGATIVE_QUESTIONS`. Those are the
 * policy's reading of the answers, not part of what Jev was asked, and they belong to `policy_v`
 * instead — folding them in here would make a policy-only edit look like a prompt change.
 *
 * Separators are NUL and SOH rather than `:` or `,` so that adjacent strings cannot
 * be re-split into a different set with the same digest. Truncated to 16 hex chars:
 * ample to distinguish the handful of question sets this plugin will ever have, and
 * short enough to read in a log row.
 */
export const QUESTION_SET_HASH = createHash('sha256')
  .update(
    JEV_QUESTION_NAMES.map((name) => `${name}\u0000${JEV_QUESTIONS[name].instructions}`).join('\u0001'),
  )
  .digest('hex')
  .slice(0, 16);

/**
 * Questions whose HIGH probability argues FOR finishing.
 * The rest argue AGAINST. The policy module uses this split to stay readable.
 */
export const POSITIVE_QUESTIONS = Object.freeze([
  'requirements_satisfied',
  'implementation_complete',
  'verification_sufficient',
  'evidence_matches_claim',
  'ready_to_finish',
]);

/** Questions whose HIGH probability is a warning sign. */
export const NEGATIVE_QUESTIONS = Object.freeze([
  'blocking_issue_remaining',
  'needs_more_verification',
]);

/**
 * Question names that were RENAMED between prompt versions.
 *
 * v1 asked `tests_sufficient`; v2 asks `verification_sufficient`, because the question no longer
 * mentions tests and a field named after them would be misread. The ANSWER means the same thing in
 * both — "the recorded verification is adequate for this task, and for a code task that comes from
 * tests or a build" — so a reader that wants one column across both versions has to look under both
 * keys.
 *
 * This lives here, next to the questions, rather than in the tool that first needed it: it is
 * knowledge about the question set, it has to stay in step with the renames, and the alternative —
 * an analysis showing em dashes for every v1 row — reads as "Jev did not answer" when the real
 * explanation is "the field was called something else then". That is the same absent-versus-null
 * confusion this project has already been bitten by twice.
 */
export const RENAMED_QUESTIONS = Object.freeze({ verification_sufficient: 'tests_sufficient' });

/**
 * Read one probability from a logged row, tolerating a rename between prompt versions.
 *
 * @param {Record<string, number>|undefined} probabilities - `jev.probabilities` from a log row.
 * @param {string} name - the CURRENT question name.
 * @returns {number|undefined} the probability, or undefined when the row carries neither key.
 */
export function readProbability(probabilities, name) {
  if (probabilities === null || typeof probabilities !== 'object') return undefined;
  const current = probabilities[name];
  if (typeof current === 'number') return current;
  const previous = RENAMED_QUESTIONS[name];
  if (previous !== undefined && typeof probabilities[previous] === 'number') {
    return probabilities[previous];
  }
  return undefined;
}
