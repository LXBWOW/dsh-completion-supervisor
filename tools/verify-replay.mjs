// Temporary diagnostic #5: replay the REAL session event stream through the
// plugin's pure evidence derivation, so we can see what the supervisor would
// compute from a genuine DSH turn — before and after the `arguments` fix.
//
// This is the check that could not be done from the log alone: the log records
// only the derived summary, so a silent parse failure looks like "no commands",
// which is indistinguishable from "the agent ran nothing".
import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

function decodeSession(path) {
  const buf = readFileSync(path)
  const starts = []
  for (let i = 0; i + 4 <= buf.length; i += 1) {
    if (buf.compare(MAGIC, 0, 4, i, i + 4) === 0) starts.push(i)
  }
  const parts = []
  for (let n = 0; n < starts.length; n += 1) {
    const from = starts[n]
    const to = n + 1 < starts.length ? starts[n + 1] : buf.length
    try {
      parts.push(zstdDecompressSync(buf.subarray(from, to)))
    } catch {
      let done = false
      for (let m = n + 2; m <= starts.length && !done; m += 1) {
        const end = m < starts.length ? starts[m] : buf.length
        try {
          parts.push(zstdDecompressSync(buf.subarray(from, end)))
          done = true
          n = m - 1
        } catch {
          /* widen */
        }
      }
    }
  }
  return Buffer.concat(parts)
    .toString('utf8')
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .flatMap((l) => {
      try {
        return [JSON.parse(l)]
      } catch {
        return []
      }
    })
}

const SESSIONS = 'C:/Users/lxb-tuf/.dsh/sessions/--C-Users-lxb-tuf-Desktop-git~0020cloud--'

// The smoke-test subagent: 3 shell commands, one of which exits 3.
const FILE = process.argv[2]
const events = decodeSession(FILE)

// Import the local source directly: the package's `exports` deliberately exposes
// only "." so DSH's loader sees a single entry point, and the live profile copy is
// the same file via symlink anyway.
const ts = await import(
  new URL('../lib/taskstate.js', import.meta.url).href
)

console.log(`events: ${events.length}`)
const counts = new Map()
for (const e of events) counts.set(e.type, (counts.get(e.type) ?? 0) + 1)
console.log(
  'types:',
  [...counts.entries()].map(([t, n]) => `${t}=${n}`).join(' '),
)

// Find the turn that stopped (the last complete one).
const turns = [...new Set(events.filter((e) => e.data?.turn).map((e) => e.data.turn))]
console.log('turns present:', turns.join(', '))

for (const turn of turns) {
  const derived = ts.deriveEvidence(events, turn)
  console.log(`\n===== turn ${turn} =====`)
  console.log('goal        :', JSON.stringify(derived.goal?.slice(0, 100)))
  console.log('claim       :', JSON.stringify(derived.claim?.slice(0, 100)))
  console.log('tool_calls  :', derived.activity.tool_calls_this_turn)
  console.log('tools_used  :', derived.activity.tools_used.join(', '))
  console.log('commands    :', derived.commands.length)
  for (const c of derived.commands) {
    console.log(`    [${c.kind}] exit=${c.exit}  ${c.cmd.slice(0, 90)}`)
  }
  console.log('tests_run   :', derived.evidence.tests_run)
  console.log('tests_passed:', derived.evidence.tests_passed)
  console.log('errors      :', derived.evidence.error_results.length)
  for (const e of derived.evidence.error_results) {
    console.log(`    ${e.tool}: ${e.msg.slice(0, 90)}`)
  }
  console.log('unverified  :', derived.evidence.unverified_claims.length)
  for (const u of derived.evidence.unverified_claims) console.log(`    ${u}`)
}

// --- what the OLD (buggy) reader would have seen ---------------------------
console.log('\n===== counterfactual: pre-fix reader (arguments as object only) =====')
function oldRead(call) {
  return call?.data?.arguments !== null &&
    typeof call?.data?.arguments === 'object'
    ? call.data.arguments
    : {}
}
const calls = events.filter((e) => e.type === 'tool/call')
for (const c of calls) {
  const oldArgs = oldRead(c)
  const newArgs = ts.readToolArguments(c.data.arguments)
  console.log(
    `${c.data.name.padEnd(14)} old=${JSON.stringify(oldArgs).slice(0, 40).padEnd(42)} new=${JSON.stringify(newArgs).slice(0, 60)}`,
  )
}
