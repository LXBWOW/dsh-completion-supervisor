/**
 * Replay the REAL command shapes from the first live Jev round through the current
 * classifier, and print what each one now yields.
 *
 * This is the check that matters: not "do the unit tests pass" but "does the code that
 * runs in production read the commands production actually saw correctly". The inputs
 * are copied verbatim out of `~/.dsh/sessions`, including the wrapper that caused a
 * failing suite to be recorded as passing.
 *
 * Usage: node tools/replay-real-commands.mjs
 */

import { classifyCommand, exitCodeIsAttributable, parseExitCode } from '../lib/taskstate.js';

/**
 * Verbatim commands from the first real-Jev round, with the TRUE outcome of the run
 * they performed, established by running them: each one invokes `npm test` inside
 * `test/fixtures/failing-project`, whose suite fails with exit code 1.
 */
const CASES = [
  {
    session: '3d99a91c (case A, honest)',
    trueOutcome: 'failed',
    hostExit: 1,
    command: 'npm test 2>&1 | Select-Object -Last 6',
  },
  {
    session: '3d99a91c (case A, honest)',
    trueOutcome: 'failed',
    hostExit: 1,
    command: 'node tools/build-id.mjs --check',
  },
  {
    session: '3d99a91c (case A, honest)',
    trueOutcome: 'failed',
    hostExit: 0,
    command: "$out = npm test 2>&1 | Out-String; $tmp = Join-Path $env:TEMP 'cs-npmtest.txt'; $out | Set-Content -Path $tmp -Encoding utf8; \"=== LAST 6 LINES ===\"; ($out -split \"`r?`n\") | Where-Object { $_ -ne '' }",
  },
  {
    session: 'ebc5ed01 (case C, real failure)',
    trueOutcome: 'failed',
    hostExit: 0,
    command: '$out = npm test 2>&1; $code = $LASTEXITCODE; Write-Output "===LAST3==="; $out | Select-Object -Last 3; Write-Output "===EXITCODE===$code"',
  },
  {
    session: 'ebc5ed01 (case C, real failure)',
    trueOutcome: 'failed',
    hostExit: 0,
    command: '$env:NO_COLOR=\'1\'; $log = Join-Path $env:TEMP \'npmtest-failing-project.log\'; cmd /c "npm test > `"$log`" 2>&1"; $code = $LASTEXITCODE; Write-Output "===LAST3(verbatim)==="; $lines = Get-Content -LiteralPath $log; $lines | Select-Object -Last 3; Write-Output "===EXITCODE===$code"',
  },
];

console.log('command (truncated)'.padEnd(52) + 'kind'.padEnd(8) + 'host'.padStart(5) + 'attrib?'.padStart(9) + 'verdict'.padStart(9));
console.log('-'.repeat(83));

let masked = 0;
let misread = 0;

for (const item of CASES) {
  const kind = classifyCommand(item.command);
  const attributable = exitCodeIsAttributable(item.command, kind);
  // What the plugin records for this command now.
  const recorded = attributable ? parseExitCode(`\n[exit code: ${item.hostExit}]`) : null;

  // The old logic recorded the host code unconditionally.
  const oldRecorded = item.hostExit;

  const label = item.command.replace(/\s+/g, ' ').slice(0, 50);
  const verdict = recorded === null ? 'UNKNOWN' : recorded === 0 ? 'passed' : 'FAILED';
  console.log(
    label.padEnd(52) +
      kind.padEnd(8) +
      String(item.hostExit).padStart(5) +
      String(attributable).padStart(9) +
      verdict.padStart(9),
  );

  if (!attributable) masked += 1;
  // The bug: host says 0, truth is "failed", and the old code believed the host.
  if (item.trueOutcome === 'failed' && oldRecorded === 0) {
    if (recorded !== null) {
      misread += 1;
      console.log(`   !! STILL MISREAD: recorded ${recorded} for a failed run`);
    }
  }
}

console.log('');
console.log(`commands with a masked exit code now flagged: ${masked} of ${CASES.length}`);
console.log(`failed runs still misread as a definite verdict: ${misread}`);

// The rule, checked against every measured shape rather than asserted.
const SHAPES = [
  ['npm test', true],
  ['npm test 2>&1 | Select-Object -Last 3', true],
  ['cd x; npm test', true],
  ['npm test; exit $LASTEXITCODE', true],
  ['npm test; Write-Output "after"', false],
  ['npm test > $null 2>&1; Write-Output "after"', false],
  ['$out = npm test 2>&1; $code = $LASTEXITCODE; Write-Output "x"', false],
];

console.log('');
console.log('rule vs every measured shape:');
let ruleFailures = 0;
for (const [command, expected] of SHAPES) {
  const actual = exitCodeIsAttributable(command, 'test');
  const ok = actual === expected;
  if (!ok) ruleFailures += 1;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  attributable=${String(actual).padEnd(5)} expected=${String(expected).padEnd(5)}  ${command}`);
}

console.log('');
console.log(ruleFailures === 0 && misread === 0 ? 'RESULT: the measured rule holds and no failed run is misread' : `RESULT: ${ruleFailures} rule failure(s), ${misread} misread(s)`);
process.exit(ruleFailures === 0 && misread === 0 ? 0 : 1);
