/**
 * Completion Supervisor — the single secret-redaction primitive.
 *
 * WHY THIS IS ITS OWN MODULE
 * --------------------------
 * It lived in `log.js`, which imports `node:fs`, `node:os` and `node:crypto`. The
 * command-output evidence added in task_v 4 needs the SAME redaction BEFORE the text
 * enters the TaskState, because a shell result can echo a token the agent printed — and
 * the state is both sent to Jev over the network and recorded in the log. Importing the
 * primitive from `log.js` would have dragged file-system machinery into a module that is
 * deliberately pure and unit-testable.
 *
 * `log.js` re-exports it, so every existing caller keeps working and there is still
 * exactly ONE implementation. Two redaction functions would eventually disagree, and the
 * copy that drifted would be the one nobody tested. The failure mode of that drift is not
 * theoretical: it writes an API key to disk.
 *
 * REPLACE A SECRET WHEREVER IT APPEARS
 * ------------------------------------
 * Exported so EVERY sink can use it, not just the JSONL writer. There are two sinks: this
 * plugin's decision log, and DSH's own logger — and the second one is easy to forget
 * because it is not ours. A Jev HTTP error echoes up to 200 characters of the response
 * body (`jev.js`), and an API that quotes the header it rejected would put the key into
 * `jev_error.message`, which is both written to a row AND passed to `ctx.logger.warn`.
 * Guarding only the row would leave the key in DSH's log files.
 *
 * A short needle is ignored: redacting a 3-character string would mangle ordinary words,
 * and no real API key is that short.
 */

/**
 * @param {string} text
 * @param {string} secret
 * @returns {string}
 */
export function redactSecret(text, secret) {
  const value = typeof text === 'string' ? text : String(text ?? '');
  if (typeof secret !== 'string' || secret.length < 16) return value;
  if (!value.includes(secret)) return value;
  return value.split(secret).join('[redacted-key]');
}
