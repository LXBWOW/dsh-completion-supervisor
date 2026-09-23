/**
 * Completion Supervisor — per-session supervisor state.
 *
 * SCOPE DECISION (read this before "fixing" it)
 * --------------------------------------------
 * This is an in-process `Map<sessionId, state>`, NOT a `sessionProjections`
 * entry. That is deliberate, and the reasoning matters because the audit report
 * recommends projections.
 *
 * The audit's hard constraint is: never persist plugin state through a custom
 * `session.append(...)` event. Writing one succeeds on disk but the read side is
 * fail-closed (`dsh-session-persistence/lib/index.js:182-197`), so the entire
 * session log becomes unloadable. Projections are the supported alternative for
 * state that must survive a restart. We obey the prohibition absolutely — this
 * plugin appends nothing to the session log.
 *
 * But projections are not free: they require a zod `stateSchema`, a
 * `stateVersion`, and an `apply(state, event)` reducer that is driven by every
 * committed session event. And the state we actually need is:
 *
 *   - how many assessments this turn has already used   (resets every turn)
 *   - the fingerprint of the last assessed state        (meaningless once the state moves on)
 *   - the id of the last assessment awaiting an outcome (only useful for seconds-to-minutes)
 *
 * None of that has meaning across a DSH restart. A restart leaves every agent
 * idle; the next turn starts fresh and re-assessing once costs one API call and
 * gains a correct answer. So persistence would buy us nothing and cost a schema
 * plus a reducer that must correctly interpret every event type in the log.
 *
 * If a future version needs cross-restart history (for example "how many times
 * has this session been blocked?"), that is a real reason to switch, and the
 * switch is local to this file. The upgrade path is documented, not foreclosed.
 *
 * BOUNDING
 * --------
 * The map is keyed by session id and never grows unbounded in practice: DSH
 * sessions are long-lived and there are few. A `MAX_TRACKED_SESSIONS` guard drops
 * the oldest entry if that ever stops being true, so a pathological case degrades
 * to "re-assess once" rather than a memory leak.
 */

/** How many sessions to track before evicting the oldest. */
const MAX_TRACKED_SESSIONS = 64;

/**
 * Create the session-state store.
 * @param {{maxTracked?: number}} [opts]
 */
export function createStateStore({ maxTracked = MAX_TRACKED_SESSIONS } = {}) {
  /** @type {Map<string, object>} */
  const states = new Map();

  function fresh() {
    return {
      /** User-task identity: assessments are counted per task, see noteTurn(). */
      taskKey: null,
      /** Assessments used for the current task. */
      assessmentsUsed: 0,
      /** Fingerprint of the most recently assessed state, or null. */
      lastFingerprint: null,
      /** Material facts behind that fingerprint, for change diagnosis. */
      lastFacts: null,
      /** Assessment id awaiting an outcome row, or null. */
      pendingAssessmentId: null,
      /** Decision of that pending assessment, for the outcome judgement. */
      pendingDecision: null,
      /** Whether that pending assessment was shadow. */
      pendingShadow: null,
      /** Probabilities of the most recent assessment, for the repeat-blocker rule. */
      lastProbabilities: null,
      /** How many user tasks this session has seen; the task key for budgets. */
      taskCount: 0,
      /** Turn numbers in which we already intervened (self-trigger guard). */
      intervenedTurns: new Set(),
      /**
       * How many times we have ACTUALLY steered during the current user task.
       *
       * Separate from `assessmentsUsed`, and reset by the same task boundary. The per-task
       * assessment budget caps how often we LOOK; this caps how often we SPEAK, and the second
       * number has to be the smaller one. A turn we steered reaches `turn-stopping` again, so a
       * second ASSESSMENT of the same task is normal and expected — a second STEER is how one
       * disagreement becomes a loop.
       */
      steersForTask: 0,
      /** Totals, for the status tool. */
      totals: { assessments: 0, skips: 0, failures: 0 },
      /** Last skip reason, for the status tool. */
      lastSkipReason: null,
      /** Epoch ms of the last assessment. */
      lastAssessmentAt: null,
    };
  }

  return {
    /**
     * Get or create the state for a session.
     * @param {string} sessionId
     */
    get(sessionId) {
      let state = states.get(sessionId);
      if (state === undefined) {
        state = fresh();
        states.set(sessionId, state);
        if (states.size > maxTracked) {
          const oldest = states.keys().next();
          if (oldest.done !== true) states.delete(oldest.value);
        }
      }
      return state;
    },

    /**
     * Note a user task boundary and report the task key for the budget.
     *
     * Called for every user-authored message. Returns the key to pass back to
     * `beginTask`, so the caller never has to derive task identity itself.
     *
     * @param {string} sessionId
     * @returns {string} the current task key.
     */
    noteUserTask(sessionId) {
      const state = this.get(sessionId);
      state.taskCount += 1;
      return `${sessionId}#task${state.taskCount}`;
    },

    /**
     * Reset the per-task counters when a new user task begins.
     *
     * A "task" is one user-authored message. MAX_ASSESSMENTS is a budget per task,
     * which is the natural reading of "3 per user task": if the user asks for
     * something new, the supervisor gets a fresh, small budget rather than being
     * permanently exhausted by the session's first problem.
     *
     * @param {string} sessionId
     * @param {string|number} taskKey
     * @returns {boolean} whether this call started a new task.
     */
    beginTask(sessionId, taskKey) {
      const state = this.get(sessionId);
      const key = String(taskKey);
      if (state.taskKey === key) return false;
      state.taskKey = key;
      state.assessmentsUsed = 0;
      // A new user request earns a new steer. Without this reset the session's first task would
      // spend the only intervention and every later task would be silently shadow again while the
      // status tool still reported INTERVENTION.
      state.steersForTask = 0;
      state.lastFingerprint = null;
      state.lastFacts = null;
      state.lastSkipReason = null;
      return true;
    },

    /** Record a completed assessment. */
    recordAssessment(sessionId, { fingerprint, facts, assessmentId, decision, shadow, probabilities }) {
      const state = this.get(sessionId);
      state.assessmentsUsed += 1;
      state.totals.assessments += 1;
      state.lastFingerprint = fingerprint;
      state.lastFacts = facts;
      state.pendingAssessmentId = assessmentId;
      state.pendingDecision = decision ?? null;
      state.pendingShadow = shadow ?? null;
      state.lastProbabilities = probabilities ?? null;
      state.lastAssessmentAt = Date.now();
    },

    /** Record that an assessment was skipped (with a reason for the status tool). */
    recordSkip(sessionId, reason) {
      const state = this.get(sessionId);
      state.totals.skips += 1;
      state.lastSkipReason = reason;
    },

    /** Record an assessment failure (Jev unavailable, malformed, etc.). */
    recordFailure(sessionId, reason) {
      const state = this.get(sessionId);
      state.totals.failures += 1;
      state.lastSkipReason = reason;
    },

    /** Mark that we intervened (steered) during a turn. */
    markIntervened(sessionId, turn) {
      const state = this.get(sessionId);
      state.intervenedTurns.add(turn);
      state.steersForTask += 1;
    },

    /** How many times the current task has already been steered. */
    steersUsed(sessionId) {
      return this.get(sessionId).steersForTask;
    },

    /** Whether we already intervened in a given turn. */
    intervenedIn(sessionId, turn) {
      return this.get(sessionId).intervenedTurns.has(turn);
    },

    /** Take the pending assessment (clearing it) so its outcome can be logged once. */
    takePending(sessionId) {
      const state = this.get(sessionId);
      const pending = state.pendingAssessmentId === null
        ? null
        : {
            assessmentId: state.pendingAssessmentId,
            decision: state.pendingDecision,
            shadow: state.pendingShadow,
          };
      state.pendingAssessmentId = null;
      state.pendingDecision = null;
      state.pendingShadow = null;
      return pending;
    },

    /** Drop all state for a session (on dispose). */
    forget(sessionId) {
      states.delete(sessionId);
    },

    /** Number of tracked sessions, for diagnostics. */
    get size() {
      return states.size;
    },
  };
}
