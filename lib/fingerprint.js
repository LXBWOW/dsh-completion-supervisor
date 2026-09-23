/**
 * Completion Supervisor — assessment fingerprint.
 *
 * WHY THIS EXISTS
 * ---------------
 * Without it, every `agent/turn-stopping` would trigger a Jev call. A turned
 * that gets steered reaches `turn-stopping` again, and a polite agent can hit
 * that boundary several times while making no real change. The time-based
 * cooldown from the first design draft was the wrong tool: it is arbitrary
 * (why 20 seconds?) and it can both suppress a genuine re-assessment and allow a
 * pointless one, depending only on wall-clock luck.
 *
 * The fingerprint makes the decision causally instead: assess again only when the
 * MATERIAL FACTS changed. A turn that stops twice with identical evidence is the
 * same situation, and Jev would return the same probabilities for it. Skipping the
 * second call is therefore free — it loses no information and saves a request.
 *
 * WHAT COUNTS AS MATERIAL
 * -----------------------
 * Only facts that could change the answer to "is this really finished":
 *   - the user's goal and constraints
 *   - which files changed, and how much
 *   - test / build / lint outcomes
 *   - unresolved issues (errors, unverified claims)
 *   - the agent's final claim
 *
 * Deliberately EXCLUDED because they churn without meaning anything:
 *   - timestamps, turn numbers, session ids
 *   - elapsed time, token counts, tool-call counts
 *   - the order of unrelated tool calls
 * Including any of those would make the fingerprint change on every stop and
 * defeat the purpose entirely.
 *
 * The hash is a plain FNV-1a over a canonical serialisation: no `node:crypto`,
 * so this module stays pure and unit-testable, and a fingerprint is reproducible
 * across processes and machines, which matters if logs are ever replayed
 * elsewhere.
 */

import { estimateJsonTokens } from './tokens.js';

/**
 * Bump when the set of fingerprinted fields changes; the log records it.
 *
 * v2: artifacts joined the material set (`created_or_written_paths`,
 *     `verified_artifacts`). They are material for exactly the reason `repo_available` is:
 *     in a directory without git they are the ONLY thing that changes when a turn produces
 *     something, so leaving them out would make "wrote a new file" fingerprint identically
 *     to "did nothing", the second stopping would be skipped as `no_material_change`, and
 *     the improved evidence would never reach Jev.
 *
 * v3: each recorded command contributes `output_hash` and `output_truncated` to the material
 *     set — as a HASH, never as the text itself. (The `task_v 4` state change added the output
 *     tail that this hashes.)
 *
 *     Text would be unusable here for a mechanical reason: `materialFacts` is serialised with
 *     `JSON.stringify` and hashed, so thousands of characters of live command output would make
 *     the fingerprint churn on every unrelated byte a deterministic tool printed — a timestamp
 *     inside a log line, a progress counter, a temp path. Each churn costs a Jev call, and
 *     `no_material_change` is the deduplication this module exists to provide.
 *
 *     It is still material rather than excluded, because a re-run whose output CHANGED is
 *     exactly the re-assessment worth paying for. In a directory without git the output is
 *     often the only thing separating "ran the test, it passes now" from "ran the test, it
 *     fails the same way".
 */
export const FINGERPRINT_VERSION = 3;

/**
 * FNV-1a, 32-bit, rendered as 8 hex chars.
 * Chosen for stability and zero dependencies, not for collision resistance:
 * a collision only costs us one skipped assessment.
 * @param {string} text
 * @returns {string}
 */
export function hash32(text) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    // 32-bit FNV prime multiply, kept in range with Math.imul.
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/** Collapse whitespace and trim, so cosmetic reformatting is not "material". */
function normalizeText(value, limit = 400) {
  if (typeof value !== 'string') return '';
  const collapsed = value.replace(/\s+/g, ' ').trim();
  return collapsed.length <= limit ? collapsed : collapsed.slice(0, limit);
}

/**
 * Build the canonical material-facts object the fingerprint is taken over.
 *
 * Exported because the log records it: when an analysis later asks "why did this
 * turn get assessed twice?", the components (not just the hash) are the answer.
 *
 * @param {object} state - a compressed TaskState.
 * @returns {object} canonical, order-stable facts.
 */
export function materialFacts(state) {
  const evidence = state?.evidence ?? {};
  const repo = state?.repo ?? {};
  const activity = state?.activity ?? {};
  const commands = Array.isArray(state?.commands) ? state.commands : [];

  return {
    // The goal and the claim are the two texts the judgement is actually about.
    goal: normalizeText(state?.goal, 400),
    claim: normalizeText(state?.claim, 400),

    // Repository shape. Sorted so file ordering never changes the hash.
    changed_files: Array.isArray(repo.changed_files)
      ? [...repo.changed_files].sort().join('|')
      : '',
    untracked: Array.isArray(repo.untracked) ? [...repo.untracked].sort().join('|') : '',
    insertions: Number.isFinite(repo.insertions) ? repo.insertions : null,
    deletions: Number.isFinite(repo.deletions) ? repo.deletions : null,
    // Whether git was readable. This is material: the same empty file list means
    // "nothing changed" when git works and "we are blind" when it does not, and the
    // two warrant different judgements. Leaving it out would also make a turn that
    // gained repository visibility look unchanged, so the second assessment would
    // be skipped at exactly the moment the evidence improved.
    repo_available: repo.available === true,

    // What the turn PRODUCED, read from structured tool arguments.
    //
    // Material for the same reason as `repo_available`: in a directory that is not a git
    // repository, `changed_files` is always empty, so this pair is the only thing that
    // changes when a turn creates a file. Both are included and they are NOT redundant:
    // `created_or_written_paths` comes from the arguments (what was attempted) while
    // `verified_artifacts` requires a non-error result, so a write that failed and then
    // succeeded differs only in the second — and that is precisely the change worth
    // re-assessing.
    //
    // `touched_paths` (files read) is deliberately EXCLUDED. Reading different files does
    // not change whether the work is finished, and it churns constantly, so including it
    // would defeat the deduplication this fingerprint exists for.
    created_or_written_paths: Array.isArray(activity.created_or_written_paths)
      ? [...activity.created_or_written_paths].sort().join('|')
      : '',
    verified_artifacts: Array.isArray(activity.verified_artifacts)
      ? activity.verified_artifacts.map((entry) => entry?.path ?? '').sort().join('|')
      : '',

    // Deterministic verdicts. These are tri-state on purpose: "not run" (null)
    // and "ran and failed" (false) are materially different situations.
    tests_run: evidence.tests_run === true,
    tests_passed: evidence.tests_passed ?? null,
    build_ok: evidence.build_ok ?? null,
    lint_ok: evidence.lint_ok ?? null,

    // Unresolved issues, normalized so that only their existence and content matter.
    errors: Array.isArray(evidence.error_results)
      ? evidence.error_results.map((item) => `${item.tool}:${normalizeText(item.msg, 120)}`).sort().join('|')
      : '',
    unverified_claims: Array.isArray(evidence.unverified_claims)
      ? [...evidence.unverified_claims].map((text) => normalizeText(text, 120)).sort().join('|')
      : '',

    // Command outcomes: which commands ran and how they exited. The command TEXT
    // is normalized (whitespace collapsed) so a reformatted invocation of the
    // same command is not a change, and the exit code IS included because a
    // flipped exit code is exactly the kind of material change we must catch.
    //
    // `output_hash` stands in for the output text — see FINGERPRINT_VERSION v3 above.
    // `output_truncated` is a separate component rather than folded into the hash because it
    // can flip while the retained tail stays byte-identical: a command that printed 900 chars
    // and then 3000 chars beginning with the same 900 has changed materially (much more was
    // said) with an identical tail. The stored `output_hash` is taken over the command's own
    // bounded output before the shared budget runs, so this pair does not move when an
    // unrelated later command consumes that budget.
    commands: commands
      .map(
        (entry) =>
          `${entry.kind}:${normalizeText(entry.cmd, 120)}:${entry.exit ?? 'null'}:` +
          `${entry.output_hash ?? ''}:${entry.output_truncated === true ? 'T' : 'F'}`,
      )
      .sort()
      .join('|'),
  };
}

/**
 * Compute the fingerprint and its components.
 *
 * @param {object} state - a compressed TaskState.
 * @returns {{fingerprint: string, version: number, facts: object, tokens: number}}
 */
export function fingerprintState(state) {
  const facts = materialFacts(state);
  const canonical = JSON.stringify(facts);
  return {
    fingerprint: hash32(canonical),
    version: FINGERPRINT_VERSION,
    facts,
    tokens: estimateJsonTokens(canonical),
  };
}

/**
 * Decide whether a new state is materially different from the last assessed one.
 *
 * A missing previous fingerprint always counts as changed — the first stopping of
 * a turn must be assessed, that is the entire point of the plugin.
 *
 * @param {string|null|undefined} previous
 * @param {string} next
 * @returns {boolean}
 */
export function isMaterialChange(previous, next) {
  if (typeof previous !== 'string' || previous.length === 0) return true;
  return previous !== next;
}

/**
 * Report which components differ, for logging and offline analysis.
 * Bounded output: we list changed keys, not a diff of values.
 *
 * @param {object|null} previousFacts
 * @param {object} nextFacts
 * @returns {string[]} changed field names.
 */
export function changedFields(previousFacts, nextFacts) {
  if (previousFacts === null || typeof previousFacts !== 'object') return Object.keys(nextFacts ?? {});
  const changed = [];
  for (const key of Object.keys(nextFacts ?? {})) {
    const before = JSON.stringify(previousFacts[key] ?? null);
    const after = JSON.stringify(nextFacts[key] ?? null);
    if (before !== after) changed.push(key);
  }
  return changed;
}
