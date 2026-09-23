/**
 * Tests that FAIL ON PURPOSE.
 *
 * WHY A WHOLE PROJECT IS NEEDED FOR THIS
 * --------------------------------------
 * The supervisor's most valuable check is "the agent claimed passing tests that
 * never ran". Verifying the opposite direction — that a REAL failure is recorded as
 * a failure — needs a command whose FINAL exit status is non-zero, and that is
 * harder to produce than it looks. Two attempts got it wrong:
 *
 *   1. `node -e "process.exit(3)"; Write-Output "EXIT=$LASTEXITCODE"`
 *      The `;`-separated second command SUCCEEDS, so it becomes the shell's final
 *      status. DSH faithfully recorded exit 0 and the "failing command" test proved
 *      nothing at all — the probe was measuring the reporter, not the failure.
 *
 *   2. `node -e "process.exit(3)"` on its own
 *      Exits 3 for real, but pwsh normalises a non-zero child status to 1 at the
 *      host level, so the marker reads `[exit code: 1]`. Fine for a zero/non-zero
 *      check, and it is why the exact number must never be quoted as the child's.
 *
 * A real failing test run avoids both traps: the exit status is genuinely non-zero,
 * it comes from the command under test rather than a trailing statement, and it is
 * also the realistic case — a long output where the status marker sits at the very
 * end (see `TOOL_RESULT_TEXT_LIMIT` and the tail-read rule in lib/taskstate.js).
 *
 * HOW TO USE IT (the smoke step in the README)
 *   cd test/fixtures/failing-project && npm test
 * Expect: `[exit code: 1]`, and a log row with tests_run=true, tests_passed=false.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('deliberately failing assertion', () => {
  // Two mismatched values: the plainest possible failure.
  assert.equal(1, 2, 'this assertion is designed to fail');
});

test('deliberately failing async rejection', async () => {
  // A rejection whose message does not match the expectation, so the failure is a
  // comparison failure rather than a thrown error — a different code path in the
  // runner, and a longer stack trace in the output.
  await assert.rejects(
    async () => {
      throw new Error('expected-value-mismatch');
    },
    /this pattern does not match/,
  );
});

test('a passing test, so the run is mixed rather than uniformly red', () => {
  // Keeps the output realistic: real suites are usually part-green, and a run where
  // EVERYTHING fails could be misread as a runner failure rather than a test failure.
  assert.equal(1 + 1, 2);
});
