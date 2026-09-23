// Verify the tail-read fix: a long failing test run must still report failure.
import { deriveEvidence, parseExitCode } from '../lib/taskstate.js'

const noise = Array.from({ length: 900 }, (_, i) => `not ok ${i} - some assertion failed`).join('\n')

function events(text, name = 'pwsh', command = 'npm test') {
  return [
    {
      type: 'tool/call',
      data: { turn: 1, step: 1, callId: 'c1', name, arguments: JSON.stringify({ command }) },
    },
    {
      type: 'tool/result',
      data: {
        turn: 1,
        step: 1,
        message: {
          content: [
            { type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text }], isError: false },
          ],
        },
      },
    },
    {
      type: 'assistant/message',
      data: { turn: 1, step: 2, message: { content: [{ type: 'text', text: 'Tests pass.' }] } },
    },
  ]
}

let failures = 0
function check(label, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail === undefined ? '' : `  — ${detail}`}`)
  if (!ok) failures += 1
}

// 1. long failing output, marker at the very end
const longFail = `${noise}\n[exit code: 1]`
const d1 = deriveEvidence(events(longFail), 1)
check('long failing run: command visible', d1.commands.length === 1)
check('long failing run: exit read as 1', d1.commands[0]?.exit === 1, String(d1.commands[0]?.exit))
check('long failing run: tests_passed false', d1.evidence.tests_passed === false, String(d1.evidence.tests_passed))
check('long failing run: claim flagged', d1.evidence.unverified_claims.length === 1, JSON.stringify(d1.evidence.unverified_claims))

// 2. long SUCCESSFUL output: no marker means exit 0
const longOk = noise
const d2 = deriveEvidence(events(longOk), 1)
check('long passing run: exit 0', d2.commands[0]?.exit === 0, String(d2.commands[0]?.exit))
check('long passing run: tests_passed true', d2.evidence.tests_passed === true, String(d2.evidence.tests_passed))
check('long passing run: no false accusation', d2.evidence.unverified_claims.length === 0, JSON.stringify(d2.evidence.unverified_claims))

// 3. the marker must survive even when total text exceeds the limit
const huge = `${'x'.repeat(60000)}\n[exit code: 2]`
const d3 = deriveEvidence(events(huge), 1)
check('huge output: marker survives the cap', d3.commands[0]?.exit === 2, String(d3.commands[0]?.exit))

// 4. an explicitly captured raw check
check('parseExitCode on the raw long text', parseExitCode(longFail) === 1)

console.log(`\n=== ${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' FAILED'} ===`)
process.exitCode = failures === 0 ? 0 : 1
