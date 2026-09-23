// Decode DSH's session.v3.jsonl.zstd, which is written as MANY concatenated
// zstd frames (one per flush). A single createZstdDecompress() stops after the
// first frame, so we walk the buffer frame by frame using the magic number.
import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

const FILE = process.argv[2]
const buf = readFileSync(FILE)

const starts = []
for (let i = 0; i + 4 <= buf.length; i += 1) {
  if (buf.compare(MAGIC, 0, 4, i, i + 4) === 0) starts.push(i)
}

const parts = []
let skipped = 0
for (let n = 0; n < starts.length; n += 1) {
  const from = starts[n]
  const to = n + 1 < starts.length ? starts[n + 1] : buf.length
  try {
    parts.push(zstdDecompressSync(buf.subarray(from, to)))
  } catch {
    // A frame boundary can be a false positive (the magic bytes appear inside
    // compressed payload data). Retry with the next boundary as the end.
    let done = false
    for (let m = n + 2; m <= starts.length && !done; m += 1) {
      const end = m < starts.length ? starts[m] : buf.length
      try {
        parts.push(zstdDecompressSync(buf.subarray(from, end)))
        done = true
        n = m - 1
      } catch {
        /* keep widening */
      }
    }
    if (!done) skipped += 1
  }
}

const text = Buffer.concat(parts).toString('utf8')
const lines = text.split('\n').filter((l) => l.trim().length > 0)
console.log(
  `frames=${starts.length} skipped=${skipped} decoded=${text.length} chars lines=${lines.length}\n`,
)

const events = []
for (const line of lines) {
  try {
    const parsed = JSON.parse(line)
    // The file holds one `session` header object possibly repeated; keep objects
    // that look like events.
    events.push(parsed)
  } catch {
    /* partial line */
  }
}

const counts = new Map()
for (const e of events) counts.set(e.type, (counts.get(e.type) ?? 0) + 1)
console.log('--- type counts ---')
for (const [t, n] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(n).padStart(5)}  ${t}`)
}

function shape(label, type) {
  const list = events.filter((e) => e.type === type)
  console.log(`\n=== ${type} (${list.length}) ===`)
  if (list.length === 0) return
  const sets = new Set()
  for (const e of list) {
    sets.add(Object.keys(e).sort().join('|') + '  ::  ' + (e.data === undefined ? '(no data)' : Object.keys(e.data).sort().join('|')))
  }
  for (const s of sets) console.log('   ', s)
  const first = list[0]
  console.log('    sample:', JSON.stringify(first).slice(0, 700))
}

for (const t of ['tool/call', 'tool/result', 'assistant/message', 'user/message', 'turn/end', 'step/end']) {
  shape(t, t)
}

const srcs = new Set()
for (const e of events.filter((x) => x.type === 'user/message')) {
  srcs.add(JSON.stringify(e.data?.source ?? null))
}
console.log('\n=== user/message source values ===')
for (const s of srcs) console.log('   ', s)
