/**
 * The identity of the code that is actually running.
 *
 * WHY THIS EXISTS
 * ---------------
 * During the E2E run it became impossible to answer a basic question from inside a
 * live session: "which revision of the plugin answered that turn?" The log rows
 * carry `policy_v`, `task_v`, `prompt_v` and `fingerprint_v`, but those version the
 * SHAPE of things — they do not change when a read is fixed, a truncation direction
 * is flipped, or a field is added to a row. Two runs with identical version stamps
 * can therefore disagree, and the disagreement looks like flakiness.
 *
 * That confusion is not hypothetical: after the first restart, rows were written
 * with `repo_available` present in `changed_fields` but absent from `facts`, because
 * the writer had been fixed and the reader had not been reloaded. Nothing in the row
 * said so.
 *
 * `BUILD_ID` is a hash of the shipped sources, computed once and baked in here. It
 * changes whenever any module changes, so a row can be attributed to an exact
 * revision. It is reported by the status tool and written on every log row.
 *
 * HOW TO REFRESH IT
 * -----------------
 *   node tools/build-id.mjs --write
 *
 * The hash is a plain FNV-1a over the module sources in a fixed order, matching
 * `lib/fingerprint.js` so the project needs no hashing dependency. It is a change
 * detector, not a security primitive.
 */

/** Hash of the shipped modules at the time this file was last regenerated. */
export const BUILD_ID = '53328bb1360f';

/** When BUILD_ID was generated, for eyeballing staleness. */
export const BUILD_AT = '2026-09-21T12:38:31.890Z';
