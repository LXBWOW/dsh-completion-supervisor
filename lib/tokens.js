/**
 * Completion Supervisor — token estimation.
 *
 * Jev has a hard request ceiling: 64k tokens per request, and state plus the
 * longest question must stay under 32k. We target ~12k for state, leaving room
 * for questions and the response. To stay under it we must be able to size a
 * state BEFORE sending it, which means estimating tokens without a tokenizer.
 *
 * ALGORITHM AND CALIBRATION
 * -------------------------
 * Taken from `tamaratran/fast-jev-compaction` (src/state.ts `estimateTokens`),
 * which calibrated it against real transcripts:
 *   - a run of letters costs 1 token per 6 characters
 *   - a digit costs half a token
 *   - any other symbol costs 0.9 tokens
 *
 * Its measured behaviour, which is why we copy it rather than invent our own:
 * this estimator lands 2-18% ABOVE the usage Jev actually reports, while a plain
 * characters-per-token ratio UNDERCOUNTS JSON-heavy states by up to 40%.
 *
 * The direction of the error matters. Over-estimating costs us an extra
 * compression stage (cheap, slightly lossier state). Under-estimating costs a
 * 400 from the API and a failed assessment (the whole turn's supervision is
 * lost). So we deliberately prefer to over-estimate.
 */

/** One token per six letters, half a token per digit, 0.9 per other symbol. */
const TOKEN_PIECES = /[A-Za-z]+|\d+|[^\sA-Za-z\d]/g;

/**
 * Estimate the token count of a string without a tokenizer.
 * @param {string} text
 * @returns {number}
 */
export function estimateTokens(text) {
  if (typeof text !== 'string' || text.length === 0) return 0;
  let tokens = 0;
  for (const [piece] of text.matchAll(TOKEN_PIECES)) {
    const first = piece.charCodeAt(0);
    if (first >= 48 && first <= 57) {
      tokens += piece.length / 2;
    } else if ((first >= 65 && first <= 90) || (first >= 97 && first <= 122)) {
      tokens += 1 + Math.floor((piece.length - 1) / 6);
    } else {
      tokens += 0.9;
    }
  }
  return Math.ceil(tokens);
}

/**
 * Estimate the tokens a JSON-serialisable value will occupy in the request body.
 * Returns Infinity for values that cannot be serialised, so a cyclic state is
 * treated as "too large" and the caller skips Jev instead of throwing mid-send.
 * @param {unknown} value
 * @returns {number}
 */
export function estimateJsonTokens(value) {
  let json;
  try {
    json = JSON.stringify(value);
  } catch {
    return Number.POSITIVE_INFINITY;
  }
  if (typeof json !== 'string') return Number.POSITIVE_INFINITY;
  return estimateTokens(json);
}
