/**
 * Completion Supervisor — deterministic policy.
 *
 * `decide()` is a PURE FUNCTION: (facts, probabilities, config) -> action. No
 * clock, no I/O, no randomness, no DSH. That is a hard requirement, not a style
 * preference: it is what lets an offline script replay a batch of logged
 * assessments under different thresholds and count how many turns each threshold
 * combination would have blocked. `jev-codex-router` does exactly this with its
 * `gate_scenarios_usd` table, and it is the only honest way to tune thresholds
 * without shipping a guess.
 *
 * THE ASYMMETRY THAT DRIVES EVERYTHING
 * ------------------------------------
 *   false block  -> interrupt a working agent, burn a turn, show the user an
 *                   unexpected message, and risk repeating it
 *   false pass   -> the user notices the work is unfinished, same as if the
 *                   plugin were not installed at all
 *
 * A false pass is strictly cheaper. So the thresholds are deliberately asymmetric:
 * the bar to PASS is HIGH (0.70-0.75) while the bar to BLOCK is LOW (0.40-0.65),
 * which leaves a wide middle band that defaults to passing.
 *
 * This is the opposite of Foreman's stance, and on purpose. Foreman is an
 * unattended factory scheduler: when its assessment fails it must stop and page a
 * human, because continuing blind could corrupt a repository. We are an assistant
 * enhancement: when our judgement fails the correct outcome is that DSH behaves
 * exactly as it would without us.
 *
 * ORDER IS PRIORITY
 * -----------------
 * Rules run top to bottom and the first match wins. Deterministic contradictions
 * come first (they are certain), semantic judgments second (they are probabilistic),
 * and the default is always pass.
 *
 * EVERY THRESHOLD IN ONE PLACE
 * ----------------------------
 * Thresholds live in the config object so a replay can vary them per run, and
 * every decision records which rule fired (`rule`) plus the thresholds in force
 * (`policy_v`), so a log from last week stays interpretable after tuning.
 */

/**
 * Bump when thresholds or rule order change; every logged decision records it.
 *
 * v2: THE INTERVENTION BOUNDARY MOVED AWAY FROM THE OBSERVATION BOUNDARY, and the two are now
 *     reported separately.
 *
 *     v1 used ONE set of thresholds for both deciding and recording. Twelve labelled samples
 *     showed what that costs: `P6_evidence_mismatch` fired four times and EVERY one was a false
 *     block — a completed turn interrupted — while it never once fired on a task that was
 *     genuinely unfinished. Once P6 was silenced, `P7_needs_verification` would have taken over
 *     the same turn and produced the same false block, so silencing P6 alone was not enough.
 *
 *     So the two jobs are separated:
 *       - the ORIGINAL thresholds still decide what the shadow log calls a would-be block, which
 *         is what keeps the rows already on disk and every future row directly comparable;
 *       - a much narrower guard band decides what may ACTUALLY steer: requirements below 0.30 or
 *         blocking at or above 0.75. Between the two bands nothing happens, which is the desired
 *         outcome — DSH behaves exactly as it would with no plugin installed.
 *
 *     P5, P6 and P7 became ADVISORY: still evaluated, still recorded in `advisory_rule`, no longer
 *     able to steer on their own. P1/P2/P3 still steer directly, because they compare against
 *     code-computed facts rather than against a probability.
 *
 * v3: NO PROBABILITY MAY STEER. P4 joined the advisory set, so the last semantic rule with the power
 *     to interrupt a turn gave it up. The plugin is now deterministic enforcement plus Jev
 *     observation: P1/P2/P3 compare recorded facts and may steer, everything derived from the seven
 *     probabilities is recorded and nothing else.
 *
 *     WHAT THE 141 LOGGED ROWS SAID, and the reason this is a contraction rather than a tuning:
 *
 *       - `good_block` samples: ZERO. The path exists in the logger and no row has ever taken it.
 *       - The 11 turns where a probability-driven P4 rule fired were re-read by hand against what
 *         the user did next: not one was confirmed necessary.
 *       - The single steer that actually reached a user (`applied=true`, 09-20T17:36) is recorded
 *         as a `false_block` — the user's own note calls the steer's premise defensible and the
 *         experience of being steered undesirable.
 *       - `needs_more_verification` never once fell below 0.64 across 68 calls (min 0.64, median
 *         0.78, max 0.87), and repeated sampling of ONE state spread 0.04-0.11 — wider than several
 *         of the gaps between the thresholds it was being compared against.
 *
 *     So there was nothing left for a probability to contribute. A signal with no confirmed true
 *     positive, a measured noise band as wide as its decision gap, and a failure mode (interrupting
 *     a working agent) that costs strictly more than the status quo it was trying to improve.
 *
 *     WHY P4 IS STILL COMPUTED AND STILL LOGGED. The observation is the only thing that could ever
 *     justify bringing it back, and it is free: the probabilities are already in the row. Deleting
 *     the rule would delete the evidence. Under v3 a row whose `advisory_rule` is `P4_...` is
 *     exactly a row this plugin WOULD have interrupted before v3 — which makes that field the count
 *     of removed steers, and the number to watch if anyone wants to argue for reinstating them.
 *
 *     WHAT DID NOT CHANGE: the question set, every threshold value, the scoring scale, and the
 *     test suite's size. A contraction of this kind is only trustworthy if it moves one thing.
 */
export const POLICY_VERSION = 3;

/** The actions the policy can return. */
export const ACTIONS = Object.freeze({
  FINISH: 'finish',
  VERIFY_MORE: 'verify_more',
  CONTINUE: 'continue',
  /**
   * No rule produces this as of POLICY_VERSION 3 — it belonged to P4b, which was deleted with P4's
   * demotion. Kept, with its wording in `renderSteerMessage`, because the action list is a
   * vocabulary the log and the renderer share; a name removed here would make an old row's
   * `decision.action` unreadable to the code that reads rows.
   */
  RETRY: 'retry',
  /** Not a decision: used when assessment was skipped or failed. */
  PASS: 'pass',
});

/**
 * Default thresholds. Every value is justified in
 * `../jev-supervisor/02-supervisor-mvp-design.md` — a SIBLING project directory, not this
 * package, which is why the path is spelled out. The design docs were written while the
 * supervisor was still a command gate, so read them for the reasoning and not as a
 * description of the current mount point.
 * @type {Readonly<object>}
 */
export const DEFAULT_THRESHOLDS = Object.freeze({
  // Deterministic gates (compare against code-computed facts, not probabilities).
  /** A recorded test run that did not pass always blocks. */
  blockOnFailingTests: true,
  /** An unsupported verification claim always asks for verification. */
  blockOnUnverifiedClaim: true,
  /** Unresolved tool errors block unless tests passed cleanly. */
  blockOnUnresolvedErrors: true,

  // ── semantic gates: the OBSERVATION thresholds ─────────────────────────────
  //
  // These decide what the shadow log reports. They are deliberately NOT what decides whether a
  // turn is actually interrupted — see the guard band below for that.
  /**
   * Below this, requirements look unmet.
   *
   * Held at its v1 value on purpose. This is what every row already on disk recorded as a
   * would-be block, and the whole reason those rows exist is to be compared against what comes
   * next; moving it would silently re-label history.
   */
  requirementsUnsatisfiedBelow: 0.40,
  /** Below this, implementation looks unfinished. Advisory only since POLICY_VERSION 2. */
  implementationIncompleteBelow: 0.40,
  /** At or above this, something still blocks — the observation half of the pair above. */
  blockingIssueAtOrAbove: 0.65,
  /** Below this, the claim is not backed by the evidence. Advisory only since POLICY_VERSION 2. */
  evidenceMismatchBelow: 0.50,
  /** At or above this, independent verification is warranted. Advisory only since POLICY_VERSION 2. */
  needsVerificationAtOrAbove: 0.65,

  // ── the intervention band: retained as the P4 advisory boundary ─────────────
  //
  // THESE TWO VALUES GRANT NOBODY ANYTHING AS OF POLICY_VERSION 3. They are kept, at the same names
  // and the same numbers, for two reasons that both matter:
  //
  //   1. Every logged row carries its own `thresholds` object, and replay reads that object back
  //      through `resolveThresholds`, which SKIPS unknown keys silently. A renamed key would leave
  //      the comparison below reading `undefined`, every test false, and history quietly re-scored.
  //      The v2 note about not re-labelling rows on disk applies with more force here.
  //   2. They still name the exact boundary P4's advisory firing is measured against, so a row asks
  //      "would the guard band have interrupted this?" directly. That comparison is
  //      `< steerRequirementsBelow` / `>= steerBlockingAtOrAbove`, which is what it always was.
  //
  // Measured on the 12 labelled samples: at 0.40/0.65 the policy blocked one completed turn in four
  // (N2 — a task that counted lib lines into a file with `pwsh`, whose printed output the state
  // carries but whose PRODUCT it cannot see, because parsing shell side effects is the guess this
  // plugin refuses to make). At 0.30/0.75 it blocked none of them. Twelve samples cannot justify a
  // boundary fitted exactly to them, which is why the band was set wider than the data required —
  // and v3 is the honest conclusion of the same doubt: a band that can only be defended by a dozen
  // samples should not be spending a real interruption on it.
  /**
   * Below this, requirements are CLEARLY unmet. Named for the steer it no longer performs; as of v3
   * it selects P4's ADVISORY firing, which is recorded and never acted on.
   */
  steerRequirementsBelow: 0.30,
  /** At or above this, a blocker is CLEARLY present — the other half of that same advisory signal. */
  steerBlockingAtOrAbove: 0.75,
  /**
   * Below this, the recorded verification is too thin to support the claim.
   *
   * Renamed from `testsInsufficientBelow` alongside the probability it compares against, which is
   * now `verification_sufficient` — the question no longer asks about tests, so a threshold named
   * after them would misread. THE VALUE IS UNCHANGED (0.60): this round isolates the wording, and
   * a renamed threshold that also changed value would be two variables at once.
   */
  verificationInsufficientBelow: 0.60,
  /** At or above this, the turn is ready to finish. */
  readyToFinishAtOrAbove: 0.75,
  /** At or above this, requirements are considered satisfied for finishing. */
  requirementsSatisfiedAtOrAbove: 0.70,
});

/**
 * Build the effective threshold set, overriding defaults with configured values.
 * @param {object} [overrides]
 * @returns {object}
 */
export function resolveThresholds(overrides = {}) {
  const resolved = { ...DEFAULT_THRESHOLDS };
  for (const [key, value] of Object.entries(overrides ?? {})) {
    if (!(key in resolved)) continue;
    const expected = typeof resolved[key];
    if (typeof value === expected && (expected !== 'number' || Number.isFinite(value))) {
      resolved[key] = value;
    }
  }
  return resolved;
}

/**
 * The deterministic rules, evaluated before any probability is consulted.
 *
 * These run first because they are not opinions: a failing test exit code or a
 * claim contradicted by the recorded commands is a fact. Asking Jev about a fact
 * we already know would waste a call and risk it being wrong.
 *
 * @returns {{action: string, reason: string, rule: string}|null}
 */
function decideFromFacts(evidence, thresholds) {
  const facts = evidence ?? {};

  // P1. Unresolved tool errors, unless a clean test run overrides them.
  if (
    thresholds.blockOnUnresolvedErrors &&
    Array.isArray(facts.error_results) &&
    facts.error_results.length > 0 &&
    facts.tests_passed !== true
  ) {
    const first = facts.error_results[0];
    const tool = typeof first?.tool === 'string' ? first.tool : 'a tool';
    return {
      action: ACTIONS.CONTINUE,
      reason: `${facts.error_results.length} unresolved tool error(s), the first from ${tool}`,
      rule: 'P1_unresolved_errors',
    };
  }

  // P2. The agent claims verification it never performed. This is the check the
  // plugin exists for: certain, free, and invisible to a summarising model.
  if (thresholds.blockOnUnverifiedClaim && Array.isArray(facts.unverified_claims) && facts.unverified_claims.length > 0) {
    return {
      action: ACTIONS.VERIFY_MORE,
      reason: facts.unverified_claims[0],
      rule: 'P2_unverified_claim',
    };
  }

  // P3. Tests ran and did not pass.
  if (thresholds.blockOnFailingTests && facts.tests_run === true && facts.tests_passed === false) {
    return {
      action: ACTIONS.CONTINUE,
      reason: 'the recorded test run did not pass',
      rule: 'P3_failing_tests',
    };
  }

  return null;
}

/**
 * The advisory rules: evaluated and recorded, never able to steer.
 *
 * Ordered as they always were, and only the FIRST match is reported — the same one-per-cycle
 * discipline the old rules had, so `advisory_rule` in the log reads like the `rule` column did.
 *
 * P4 ENTERED THIS LIST IN POLICY_VERSION 3, and the band it is measured against is deliberately
 * NOT the observation band that `shadowVerdict` reports. Requirements are genuinely low on most
 * real turns (median 0.27 across the logged rows), so judging the advisory against 0.40 would fire
 * on roughly half of them and hide P5/P6/P7 behind it — the opposite of what keeping advisories is
 * for. Judged against the intervention band instead, a P4 advisory means precisely "this row would
 * have been interrupted before v3", which is the count worth having.
 *
 * @returns {{rule: string, reason: string}|null}
 */
function firstAdvisory(p, thresholds) {
  // P4. Requirements clearly unmet, or a blocker clearly present.
  //
  // WAS the semantic rule that steered; advisory as of POLICY_VERSION 3, for the reasons in the
  // POLICY_VERSION note. The reason strings keep the word "clearly" from its steering days: it
  // describes the band the value crossed, and nothing about confidence in the value itself.
  if (p.requirements_satisfied < thresholds.steerRequirementsBelow) {
    return {
      rule: 'P4_requirements_unmet',
      reason: `requirements clearly unmet (${fmt(p.requirements_satisfied)})`,
    };
  }
  if (p.blocking_issue_remaining >= thresholds.steerBlockingAtOrAbove) {
    return {
      rule: 'P4_requirements_unmet',
      reason: `blocking issue clearly present (${fmt(p.blocking_issue_remaining)})`,
    };
  }

  // P5. Implementation incomplete.
  if (p.implementation_complete < thresholds.implementationIncompleteBelow) {
    return {
      rule: 'P5_implementation_incomplete',
      reason: `implementation appears incomplete (${fmt(p.implementation_complete)})`,
    };
  }

  // P6. The claim outruns the evidence.
  //
  // FOUR FIRINGS, FOUR FALSE BLOCKS, ZERO TRUE ONES — that is the measured record behind demoting
  // this rule, and it is worth stating precisely because it does NOT mean the rule was reading
  // noise. Each firing was a completed turn whose claim quoted a command's printed output while
  // the state carried none of it (C1 0.42, C2 0.47, N2 0.40 against 0.50). The task_v 4 change put
  // that output into the state and two of the three moved (C1 0.79, C2 0.55); the third did not,
  // because its file was created by `pwsh`, and a shell's side effects are the one thing this
  // plugin refuses to guess at.
  //
  // So the rule was reading a real gap in the evidence and then reporting it as a problem with the
  // agent. It stays here, still computed and still logged, because a claim that outruns its
  // evidence is exactly what this plugin exists to notice — it just does not get to interrupt
  // anyone on the strength of it yet.
  if (p.evidence_matches_claim < thresholds.evidenceMismatchBelow) {
    return {
      rule: 'P6_evidence_mismatch',
      reason: `the summary is not supported by the recorded evidence (${fmt(p.evidence_matches_claim)})`,
    };
  }

  // P7. Verification warranted, and the RECORDED verification thin.
  //
  // Advisory for the same reason as P6, and it is the reason silencing P6 ALONE would not have
  // been enough: on the v4 N2 row (`needs` 0.78, `sufficient` 0.59) this rule fires and produces
  // the identical false block under a different name.
  if (
    p.needs_more_verification >= thresholds.needsVerificationAtOrAbove &&
    p.verification_sufficient < thresholds.verificationInsufficientBelow
  ) {
    return {
      rule: 'P7_needs_verification',
      reason: `verification warranted (${fmt(p.needs_more_verification)}) and recorded verification thin (${fmt(p.verification_sufficient)})`,
    };
  }

  return null;
}

/**
 * What the OBSERVATION thresholds would have said. Recorded, never acted on.
 *
 * Kept because those are the thresholds every row already on disk was written under. A reader
 * asking "did the guard band change this turn?" needs both halves in the same row, and this is the
 * half that must not move.
 *
 * @returns {{rule: string, reason: string}|null}
 */
function shadowVerdict(p, thresholds) {
  if (
    p.requirements_satisfied < thresholds.requirementsUnsatisfiedBelow ||
    p.blocking_issue_remaining >= thresholds.blockingIssueAtOrAbove
  ) {
    const blocked = p.blocking_issue_remaining >= thresholds.blockingIssueAtOrAbove;
    return {
      rule: 'P4_requirements_unmet',
      reason: blocked
        ? `blocking issue still present (${fmt(p.blocking_issue_remaining)})`
        : `requirements appear unmet (${fmt(p.requirements_satisfied)})`,
    };
  }
  return null;
}

/**
 * The semantic rules, evaluated only when no deterministic rule fired.
 *
 * NOTHING HERE CAN STEER as of POLICY_VERSION 3. Both branches that remain return `finish`, and the
 * caller treats `finish` as "do not act", so the only difference they make is the NAME a permitted
 * turn is logged under. That name is worth keeping: `P8_finish` is a positive reading of the seven
 * probabilities and `P9_default_pass` is the absence of any reading, and a report unable to tell
 * those apart could not notice Jev going quiet.
 *
 * P4 AND P4b USED TO LIVE HERE.
 *   - P4 moved to the advisory list: still computed, still logged, no longer able to interrupt.
 *   - P4b is deleted rather than demoted. It existed only to make a SECOND steer differ from the
 *     first (escalating a reappearing blocker from `continue` to `retry`); with no first steer
 *     there is nothing left for it to escalate. `ACTIONS.RETRY` and the renderer's retry wording
 *     stay, because a steer message is still renderable — but no rule produces that action now.
 *
 * @returns {{action: string, reason: string, rule: string}|null}
 */
function decideFromAssessment(probabilities, thresholds, advisory) {
  const p = probabilities;

  // P8. Confident completion. Named rather than left to the default, so the log says which path
  // passed — an explicit finish and a no-rule-fired pass-through are different findings.
  if (
    p.ready_to_finish >= thresholds.readyToFinishAtOrAbove &&
    p.requirements_satisfied >= thresholds.requirementsSatisfiedAtOrAbove
  ) {
    return {
      action: ACTIONS.FINISH,
      reason: `completion thresholds satisfied (ready ${fmt(p.ready_to_finish)}, requirements ${fmt(p.requirements_satisfied)})`,
      rule: 'P8_finish',
      enforce: true,
      advisory,
    };
  }

  return null;
}

/**
 * Decide what to do about a completion claim.
 *
 * AS OF POLICY_VERSION 3, ONLY `decideFromFacts` CAN PRODUCE AN ACTION. Everything the caller may
 * act on is a comparison against recorded facts; `probabilities` is now read for the names it gives
 * a permitted turn, and for nothing else. The parameter stays required, because an absent one is a
 * malformed call rather than a policy that passes.
 *
 * @param {object} args
 * @param {object} args.state - the TaskState that was sent to Jev.
 * @param {object} args.probabilities - the seven validated Noul probabilities.
 * @param {object} [args.thresholds] - overrides for replay.
 * @returns {{action: string, reason: string, rule: string, policy_v: number, thresholds: object}}
 */
export function decide({ state, probabilities, thresholds }) {
  const resolved = resolveThresholds(thresholds);
  const evidence = state?.evidence ?? {};
  const p = probabilities ?? {};

  const fromFacts = decideFromFacts(evidence, resolved);

  // Computed OUTSIDE the branch that returns a rule, because an advisory rule has to be recorded even
  // on a turn where nothing acts — that is the entire point of keeping them. Computing it inside
  // `decideFromAssessment` drops every advisory firing that ends in the default pass, which is
  // precisely the population this change was made for: the replay of the 12 labelled rows showed
  // `advisory_rule` empty on all four of the turns P6 used to block.
  //
  // Suppressed when a deterministic rule fired: P1/P2/P3 have already decided that turn, and an
  // advisory beside them would only invite a reader to weigh the two against each other.
  const advisory = fromFacts === null ? firstAdvisory(p, resolved) : null;

  const semantic = fromFacts ?? decideFromAssessment(p, resolved, advisory);
  const decision = semantic ?? {
    // The default is to pass. An unremarkable turn must never be interrupted.
    action: ACTIONS.FINISH,
    reason: 'no threshold crossed; defaulting to pass-through',
    rule: 'P9_default_pass',
    enforce: true,
    advisory,
  };

  // Both bands in one place, so a single row answers "would the OLD thresholds have blocked this,
  // and did the NEW ones?" without re-deriving either from the probabilities.
  const shadow = fromFacts ?? shadowVerdict(p, resolved);

  return {
    ...decision,
    // Kept, and constant: no rule sets `enforce: false` any more, because the advisory set is no
    // longer consulted for actions at all. The field stays in the returned shape and in every log
    // row so that rows written under log_v 2 remain comparable, and so a future rule that does want
    // to record "I fired and must not act" has a field to say it with.
    enforce: decision.enforce !== false,
    advisory_rule: advisory?.rule ?? null,
    shadow_rule: shadow?.rule ?? null,
    shadow_reason: shadow?.reason ?? null,
    // The observation thresholds would have blocked this turn and nothing did. As of POLICY_VERSION 3
    // that is what happens on EVERY turn they flag, so this is no longer a narrow grey middle between
    // two bands — it is the full count of turns the plugin deliberately left alone, which is the only
    // observable cost of the contraction and the field to read if anyone asks what it bought.
    // It stays false when a deterministic rule fired, because then the two bands agree.
    gray_zone: shadow !== null && decision.rule !== shadow.rule,
    policy_v: POLICY_VERSION,
    thresholds: resolved,
  };
}

/**
 * Decide WITHOUT probabilities — used when Jev was not called at all.
 * Deterministic contradictions are still checked, because they need no Jev.
 * This is what makes a fail-open path still useful: if the API is down we can
 * still catch "the agent claims tests that never ran".
 *
 * @param {object} args
 * @param {object} args.state
 * @param {object} [args.thresholds]
 * @returns {{action: string, reason: string, rule: string, policy_v: number, thresholds: object}}
 */
export function decideWithoutJev({ state, thresholds }) {
  const resolved = resolveThresholds(thresholds);
  const fromFacts = decideFromFacts(state?.evidence ?? {}, resolved);
  const base = fromFacts ?? {
    action: ACTIONS.PASS,
    reason: 'no deterministic contradiction found and no assessment available',
    rule: 'P0_no_jev',
  };
  return {
    ...base,
    // Only a deterministic contradiction may steer here. That is the whole shape of the fail-open
    // path: if Jev is unreachable there is no probability to argue from, so the only thing left
    // worth acting on is a fact we computed ourselves.
    enforce: fromFacts !== null,
    advisory_rule: null,
    shadow_rule: fromFacts?.rule ?? null,
    shadow_reason: fromFacts?.reason ?? null,
    gray_zone: false,
    policy_v: POLICY_VERSION,
    thresholds: resolved,
  };
}

/** Format a probability for a human-readable reason string. */
function fmt(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(2) : '?';
}

/**
 * Render the message that would be steered into the agent.
 *
 * Requirements that matter more than brevity:
 *   1. Name the SPECIFIC missing item. "Please verify" gives the agent nothing to
 *      act on, and a vague demand is what turns one block into three.
 *   2. Always offer the honest exit: "or state plainly what remains unfinished".
 *      Without it the agent is pushed toward overclaiming, which is the exact
 *      behaviour we are trying to reduce.
 *   3. Say "do not restate the same summary" on a retry, where the failure mode
 *      is the agent repeating itself verbatim.
 *
 * @param {{action: string, reason: string, rule: string}} decision
 * @param {object} state
 * @returns {string} the steer text.
 */
export function renderSteerMessage(decision, state) {
  const lines = ['[Completion check] Before this turn is accepted as done:', ''];

  const evidence = state?.evidence ?? {};
  const repo = state?.repo ?? {};
  const details = [];

  for (const claim of evidence.unverified_claims ?? []) details.push(`- ${claim}`);
  if ((evidence.error_results ?? []).length > 0) {
    for (const error of evidence.error_results.slice(0, 2)) {
      details.push(`- unresolved error from ${error.tool}: ${error.msg.slice(0, 200)}`);
    }
  }
  if (evidence.tests_run === true && evidence.tests_passed === false) {
    details.push('- the recorded test run did not pass');
  }
  if (decision.action === ACTIONS.CONTINUE && details.length === 0) {
    details.push(`- ${decision.reason}`);
  }
  const untracked = Array.isArray(repo.untracked) ? repo.untracked : [];
  if (untracked.length > 0) {
    details.push(`- files created but not tracked by git: ${untracked.slice(0, 5).join(', ')}`);
  }

  if (details.length > 0) lines.push(...details, '');

  if (decision.action === ACTIONS.VERIFY_MORE) {
    lines.push(
      'Run the verification the summary implies and report its ACTUAL result.',
      'If you cannot run it, say so explicitly instead of describing what the result would be.',
    );
  } else if (decision.action === ACTIONS.RETRY) {
    // Unreachable from `decide()` since POLICY_VERSION 3 (P4b was its only producer). Kept because a
    // RETRY decision recorded under an older policy can still be rendered for inspection, and
    // because deleting the wording would silently turn such a row into the generic finish text.
    lines.push(
      'The previous attempt did not resolve this. Try a different approach, or tell the user',
      'plainly what is blocking you and what you need. Do not restate the same summary.',
    );
  } else {
    lines.push(
      'Either finish the missing work, or state plainly what remains unfinished.',
      'Do not restate the same summary.',
    );
  }

  return lines.join('\n');
}
