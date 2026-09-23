/**
 * VERIFY the three-state test verdict end to end, through the real shell.
 *
 * WHAT THIS IS FOR
 * ----------------
 * `tests_passed` has three honest values, and the whole exit-attribution fix rests on
 * them being distinguishable:
 *
 *   true   — a test run succeeded, and the exit code was genuinely that run's
 *   false  — a test run failed, and the exit code was genuinely that run's
 *   null   — a test run happened and its result could not be read, because the agent
 *            wrapped the call and the host reported a LATER statement's code
 *
 * `null` must not vote in either direction. Recording `true` for a suite that failed is
 * a fabricated pass — the exact error this plugin exists to prevent, and one that reached
 * a real session. Recording `false` for a suite that passed would be equally wrong in the
 * other direction: it accuses an honest turn, and a false block is the most expensive
 * mistake the supervisor can make downstream.
 *
 * WHY IT RUNS REAL COMMANDS
 * -------------------------
 * A unit test that feeds hand-written result text tests the reader against the author's
 * belief about the shell. On the first live round that belief was wrong twice. So this
 * probe does the whole path for real: it resolves the same shell DSH resolves, runs the
 * commands in a child process, shapes the output with DSH's own rendering rules, and
 * only then hands the events to the real `deriveEvidence`.
 *
 * Usage: node tools/verify-exit-tristate.mjs [--verbose]
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { deriveEvidence } from '../lib/taskstate.js';

const ROOT = process.cwd();
const FAILING_DIR = join(ROOT, 'test', 'fixtures', 'failing-project');
const VERBOSE = process.argv.includes('--verbose');

/**
 * Resolve the shell the SAME WAY DSH does.
 *
 * `dsh-pwsh-local/lib/index.js:59-69` tries `$ProgramFiles\PowerShell\7\pwsh.exe`, then a
 * configured directory, then `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe`,
 * and only then PATH. Measuring a different shell than DSH runs would measure the wrong
 * contract. On this machine PowerShell 7 is NOT installed, so the live behaviour is 5.1.
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

/**
 * Reproduce DSH's model-facing result text exactly.
 *
 * Transcribed from `@deepseek-ai/dsh-tool-pwsh/lib/index.js:60-80` (`renderPwshResult`).
 * Two details matter and a hand-rolled "output plus a marker" gets both wrong:
 *
 *   1. A clean exit (0, no signal) produces NO marker at all — the marker's ABSENCE is
 *      the success signal, and `parseExitCode` reads it that way.
 *   2. The marker is separated by a newline only when at least one marker exists.
 *
 * The second detail is why a naive `text.endsWith('[exit code: 0]')`-style reader would
 * have been broken from the start. Keeping the transcription honest is the point: if DSH
 * changes this renderer, this probe must be updated in the same breath.
 */
function renderResult({ stdout, stderr, exitCode, timedOut = false, signal = null, timeoutMs = 0 }) {
  let body = typeof stdout === 'string' ? stdout : '';
  const err = typeof stderr === 'string' ? stderr : '';
  if (err.length > 0) {
    if (body.length > 0 && !body.endsWith('\n')) body += '\n';
    body += `[stderr]\n${err}`;
  }
  if (body.length === 0) body = '(no output)';
  const markers = [];
  if (timedOut) markers.push(`[timed out after ${timeoutMs}ms]`);
  if (signal !== null) markers.push(`[killed by signal: ${signal}]`);
  else if (exitCode !== 0) markers.push(`[exit code: ${exitCode}]`);
  if (markers.length === 0) return body;
  if (!body.endsWith('\n')) body += '\n';
  return body + markers.join('\n');
}

/** Run one command in a child shell and capture what the host would observe. */
function run(command, cwd) {
  try {
    const stdout = execFileSync(SHELL, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], {
      cwd,
      stdio: 'pipe',
      timeout: 180000,
      encoding: 'utf8',
    });
    return { stdout: String(stdout ?? ''), stderr: '', exitCode: 0 };
  } catch (error) {
    return {
      stdout: String(error?.stdout ?? ''),
      stderr: String(error?.stderr ?? ''),
      // A force-killed child settles without a status; treating that as 1 (non-zero) is
      // the conservative reading, since a kill is certainly not a clean pass.
      exitCode: typeof error?.status === 'number' ? error.status : 1,
    };
  }
}

/**
 * Build the two session events DSH appends for one tool call.
 *
 * Both shapes are the REAL ones, taken from a captured session log: `arguments` is a
 * JSON STRING because DSH writes the model's raw argument text through, and the result's
 * text lives at `content[0].content[0].text`, not at a top-level `text` field.
 */
function eventsFor(command, rendered) {
  const callId = 'probe-call-1';
  return [
    {
      type: 'tool/call',
      data: { turn: 1, step: 1, callId, name: 'pwsh', arguments: JSON.stringify({ command }) },
    },
    {
      type: 'tool/result',
      data: {
        turn: 1,
        step: 1,
        message: {
          role: 'tool',
          id: 'probe-message-1',
          source: { kind: 'tool', callId },
          content: [
            {
              type: 'tool-result',
              toolCallId: callId,
              content: [{ type: 'text', text: rendered }],
              isError: false,
            },
          ],
        },
      },
    },
  ];
}

/** The wrapper a real subagent actually wrote, which is how the defect reached a session. */
const MASKING_WRAPPER =
  '$out = npm test 2>&1; $code = $LASTEXITCODE; Write-Output "captured $($out.Length) chars"; Write-Output "code=$code"';

/** The same wrapper, but faithfully passing the code on — this one IS attributable. */
const FAITHFUL_WRAPPER =
  '$out = npm test 2>&1; $code = $LASTEXITCODE; Write-Output "code=$code"; exit $LASTEXITCODE';

/** A wrapper that passes the code through a VARIABLE, which static analysis cannot follow. */
const VARIABLE_PASSTHROUGH =
  '$out = npm test 2>&1; $code = $LASTEXITCODE; Write-Output "code=$code"; exit $code';

const CASES = [
  {
    name: 'passing suite, unwrapped',
    command: 'npm test',
    cwd: ROOT,
    expect: true,
    attributable: true,
    why: 'the ordinary happy path: a real run, a real zero, no marker',
  },
  {
    name: 'failing suite, unwrapped',
    command: 'npm test',
    cwd: FAILING_DIR,
    expect: false,
    attributable: true,
    why: 'a real non-zero belongs to the command that produced it',
  },
  {
    name: 'failing suite, masked by a wrapper',
    command: MASKING_WRAPPER,
    cwd: FAILING_DIR,
    expect: null,
    attributable: false,
    why: 'THE DEFECT CASE: the host reports the wrapper\'s 0, so the run result is unreadable',
  },
  {
    name: 'failing suite, wrapper passing $LASTEXITCODE on',
    command: FAITHFUL_WRAPPER,
    cwd: FAILING_DIR,
    expect: false,
    attributable: true,
    why: 'a wrapper that ends in `exit $LASTEXITCODE` restores attribution',
  },
  {
    name: 'failing suite, wrapper passing a VARIABLE on',
    command: VARIABLE_PASSTHROUGH,
    cwd: FAILING_DIR,
    expect: null,
    attributable: false,
    why: 'KNOWN CONSERVATIVE LIMIT: the code is correct but static analysis cannot follow a variable, so the probe abstains rather than guess',
  },
];

function main() {
  console.log(`shell: ${SHELL}`);
  console.log(`passing project: ${ROOT}`);
  console.log(`failing project: ${FAILING_DIR}`);
  console.log('');

  const failures = [];
  const observations = [];

  for (const testCase of CASES) {
    const raw = run(testCase.command, testCase.cwd);
    const rendered = renderResult(raw);
    const derived = deriveEvidence(eventsFor(testCase.command, rendered), 1);

    const entry = derived.commands.find((command) => command.cmd === testCase.command) ?? derived.commands[0];
    const observedPassed = derived.evidence.tests_passed;
    const observedRun = derived.evidence.tests_run;
    const observedAttributable = entry?.exit_attributable;

    const passedOk = observedPassed === testCase.expect;
    const ranOk = observedRun === true;
    const attributableOk = observedAttributable === testCase.attributable;
    const ok = passedOk && ranOk && attributableOk;
    if (!ok) failures.push(testCase.name);

    observations.push({
      name: testCase.name,
      hostExit: raw.exitCode,
      marker: /\[exit code: \d+\]/.test(rendered) ? rendered.slice(rendered.lastIndexOf('[exit code:')).trim() : '(none)',
      ran: observedRun,
      passed: observedPassed,
      attributable: observedAttributable,
      expected: testCase.expect,
    });

    console.log(`${ok ? 'PASS' : 'FAIL'}  ${testCase.name}`);
    console.log(`      why: ${testCase.why}`);
    console.log(
      `      host exit ${raw.exitCode}, marker ${observations.at(-1).marker}` +
        ` -> tests_run=${String(observedRun)}, tests_passed=${String(observedPassed)},` +
        ` attributable=${String(observedAttributable)}`,
    );
    console.log(
      `      expected tests_passed=${String(testCase.expect)}, attributable=${String(testCase.attributable)}` +
        `${ok ? '' : '   <-- MISMATCH'}`,
    );
    if (VERBOSE) {
      const tail = rendered.slice(-200).replace(/\n/g, ' | ');
      console.log(`      result tail: ${tail}`);
    }
    console.log('');
  }

  // The rule this probe exists to check, stated as a property rather than as three
  // examples: an unattributable run must produce null, and null must equal neither
  // true nor false. Written this way so it keeps holding if the cases above change.
  const masked = observations.find((entry) => entry.name.startsWith('failing suite, masked'));
  const triStateHolds =
    masked !== undefined && masked.passed === null && masked.passed !== true && masked.passed !== false;

  console.log('-'.repeat(72));
  console.log(`three states exercised: true=${observations.filter((o) => o.passed === true).length}, ` +
    `false=${observations.filter((o) => o.passed === false).length}, ` +
    `null=${observations.filter((o) => o.passed === null).length}`);
  console.log(`null never votes as success: ${triStateHolds ? 'verified' : 'VIOLATED'}`);
  console.log(`cases: ${CASES.length - failures.length}/${CASES.length} as expected`);

  if (failures.length > 0) {
    console.log('');
    console.log(`FAILED: ${failures.join('; ')}`);
    return 1;
  }
  return 0;
}

process.exitCode = main();
