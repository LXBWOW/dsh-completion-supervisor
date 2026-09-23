/**
 * MEASURE which shell command shapes hide a failing exit code from the host.
 *
 * WHY: the plugin treats the shell host's exit code as the verdict on a command. That
 * premise is true for a bare command and FALSE for a wrapper: `$out = npm test; …`
 * exits with the code of the last statement, not of `npm test`. On the first real-Jev
 * round a subagent wrote exactly that wrapper, and a FAILING test suite was recorded
 * as `tests_passed: true` — a fabricated pass, the one error this plugin exists to
 * prevent.
 *
 * Guessing which shapes mask the code would be the same mistake as guessing any other
 * contract. This runs each shape for real, in a child pwsh, and reports the exit code
 * the host would observe next to the true code the command produced.
 *
 * Usage: node tools/measure-exit-shapes.mjs
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const FAILING_DIR = join(process.cwd(), 'test', 'fixtures', 'failing-project');
const PASSING_DIR = process.cwd();

/**
 * Resolve the shell the SAME WAY DSH does, because measuring a different shell would
 * measure the wrong contract.
 *
 * `dsh-pwsh-local/lib/index.js` tries, in order: `$ProgramFiles\PowerShell\7\pwsh.exe`,
 * a configured directory, then `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe`,
 * and only falls back to PATH. On this machine PowerShell 7 is NOT INSTALLED, so DSH is
 * running Windows PowerShell 5.1 — a detail worth knowing, because 5.1's exit-code and
 * parsing behaviour is what the plugin actually has to live with.
 */
function resolveShell() {
  const candidates = [
    join(process.env.ProgramFiles ?? 'C:\\Program Files', 'PowerShell', '7', 'pwsh.exe'),
    join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
  ];
  for (const candidate of candidates) if (existsSync(candidate)) return candidate;
  return 'pwsh';
}

const SHELL = resolveShell();

// A failing suite and a passing one, so each shape is measured in BOTH directions —
// a shape that reports 0 for a failure and 0 for a success is masking, while one that
// reports 1 and 0 respectively is faithful.
const SHAPES = [
  ['bare (failing)', `npm test`, FAILING_DIR],
  ['bare (passing)', `npm test`, PASSING_DIR],
  ['piped to Select-Object', `npm test 2>&1 | Select-Object -Last 3`, FAILING_DIR],
  ['piped to Out-String', `npm test 2>&1 | Out-String`, FAILING_DIR],
  ['capture then print (the real case)', `$out = npm test 2>&1; $code = $LASTEXITCODE; Write-Output "x"; Write-Output "code=$code"`, FAILING_DIR],
  ['capture piping Out-String then print', `$out = npm test 2>&1 | Out-String; $tmp = Join-Path $env:TEMP 'x.txt'; $out | Set-Content -Path $tmp; Write-Output "done"`, FAILING_DIR],
  ['cmd /c', `cmd /c "npm test"`, FAILING_DIR],
  ['two native statements, test last', `cd "${FAILING_DIR}"; npm test`, FAILING_DIR],
  ['two native statements, test first', `npm test; Write-Output "after"`, FAILING_DIR],
  ['redirect to $null then print', `npm test > $null 2>&1; Write-Output "after"`, FAILING_DIR],
  ['exit $LASTEXITCODE passthrough', `npm test; exit $LASTEXITCODE`, FAILING_DIR],
];

/** Run one shape in a child shell and return the exit code the parent observes. */
function observe(shape, cwd) {
  try {
    execFileSync(SHELL, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', shape], {
      cwd,
      stdio: 'pipe',
      timeout: 120000,
    });
    return 0;
  } catch (error) {
    if (typeof error.status === 'number') return error.status;
    return `error:${error.code ?? 'unknown'}`;
  }
}

const scratch = mkdtempSync(join(tmpdir(), 'exit-shape-'));
process.env.TEMP = scratch;

console.log(`shell: ${SHELL}`);
console.log('');
console.log('shape'.padEnd(42) + 'observed'.padStart(10) + 'faithful?'.padStart(12));
console.log('-'.repeat(64));

const rows = [];
for (const [label, shape, cwd] of SHAPES) {
  const observed = observe(shape, cwd);
  // Only the failing runs can prove masking: a passing run legitimately exits 0.
  const failing = cwd === FAILING_DIR;
  const faithful = failing ? observed !== 0 : observed === 0;
  rows.push({ label, observed, failing, faithful });
  console.log(`${label.padEnd(42)}${String(observed).padStart(10)}${(faithful ? 'yes' : 'NO — MASKED').padStart(14)}`);
}

try {
  rmSync(scratch, { recursive: true, force: true });
} catch {
  // Best effort.
}

const masked = rows.filter((row) => !row.faithful);
console.log('');
console.log(`${masked.length} of ${rows.length} shapes mask the exit code:`);
for (const row of masked) console.log(`  - ${row.label}`);

// The distinguishing feature, stated as data rather than as a theory.
console.log('');
console.log('what the faithful and masking shapes differ in:');
for (const row of rows) {
  const hasSemicolon = SHAPES.find(([l]) => l === row.label)[1].includes(';');
  console.log(`  ${row.faithful ? 'faithful' : 'MASKED  '}  semicolon=${String(hasSemicolon).padEnd(5)}  ${row.label}`);
}
