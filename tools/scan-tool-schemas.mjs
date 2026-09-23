/**
 * SCAN real session logs for the tool schemas this machine actually uses.
 *
 * WHY THIS EXISTS
 * ---------------
 * The completion supervisor has to tell Jev what a turn PRODUCED. In a directory that is
 * not a git repository, `repo.changed_files` is empty, so a turn that created a file
 * currently reaches Jev with no evidence of it at all — and Jev then answers
 * `requirements_satisfied` low, which trips the P4 block rule.
 *
 * The fix is to read produced paths out of the tool calls, which requires knowing the real
 * argument names. Guessing them is the mistake this repository keeps having to unwind:
 * `tool/call.data.arguments` was assumed to be an object and was a JSON string, and the
 * assistant `reasoning` block was assumed to be user-facing prose. So this scans the logs
 * instead of asserting from memory.
 *
 * It reports, per tool: how often it was called, the UNION of its argument keys, and one
 * raw sample. It also reports what shape a `tool/result` body takes, because a structured
 * result would be a deterministic source for "the artifact exists" while plain prose is not.
 *
 * Usage: node tools/scan-tool-schemas.mjs [--sessions 10] [--json]
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/** Split a concatenated-zstd buffer into its individual frames. */
function splitFrames(buffer) {
  const offsets = [];
  let index = buffer.indexOf(ZSTD_MAGIC, 0);
  while (index !== -1) {
    offsets.push(index);
    index = buffer.indexOf(ZSTD_MAGIC, index + 4);
  }
  return offsets.map((start, i) => buffer.subarray(start, offsets[i + 1] ?? buffer.length));
}

/** Decode every frame and concatenate the plaintext. */
function decodeAll(buffer) {
  const parts = [];
  for (const frame of splitFrames(buffer)) {
    try {
      parts.push(zstdDecompressSync(frame).toString('utf8'));
    } catch {
      // A torn frame is not fatal for a survey; skip it and keep going.
    }
  }
  return parts.join('');
}

/** The most recently modified session logs, newest first. */
function recentSessions(limit) {
  const root = join(process.env.USERPROFILE ?? '', '.dsh', 'sessions');
  if (!existsSync(root)) return [];
  const found = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const stat = statSync(full);
      if (stat.isDirectory()) walk(full);
      else if (entry.endsWith('.zstd')) found.push({ path: full, mtimeMs: stat.mtimeMs, size: stat.size });
    }
  };
  walk(root);
  return found.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, limit);
}

const args = process.argv.slice(2);
const sessionIndex = args.indexOf('--sessions');
const limit = sessionIndex === -1 ? 10 : Number(args[sessionIndex + 1] ?? 10) || 10;
const asJson = args.includes('--json');

const sessions = recentSessions(limit);
if (sessions.length === 0) {
  console.log('no session logs found');
  process.exit(0);
}

/** tool name -> { calls, keys:Set, sample } */
const tools = new Map();
/** tool name -> { resultContentTypes:Set, sample } */
const results = new Map();
let sessionsScanned = 0;
let eventsScanned = 0;

for (const session of sessions) {
  let text;
  try {
    text = decodeAll(readFileSync(session.path));
  } catch {
    continue;
  }
  sessionsScanned += 1;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let event;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue;
    }
    eventsScanned += 1;

    if (event?.type === 'tool/call') {
      const data = event.data ?? {};
      const name = typeof data.name === 'string' ? data.name : '(unnamed)';
      let entry = tools.get(name);
      if (entry === undefined) {
        entry = { calls: 0, keys: new Set(), sample: null };
        tools.set(name, entry);
      }
      entry.calls += 1;
      let parsed = null;
      try {
        parsed = JSON.parse(data.arguments);
      } catch {
        parsed = null;
      }
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        for (const key of Object.keys(parsed)) entry.keys.add(key);
      }
      if (entry.sample === null) {
        entry.sample = typeof data.arguments === 'string' ? data.arguments.slice(0, 200) : String(data.arguments);
      }
    }

    if (event?.type === 'tool/result') {
      const callId = event.data?.message?.source?.callId ?? '(unknown)';
      const blocks = event.data?.message?.content ?? [];
      for (const block of blocks) {
        if (block?.type !== 'tool-result') continue;
        let entry = results.get(callId);
        if (entry === undefined) {
          // Key results by their inner content shape, not by call id, when reporting.
          entry = { types: new Set(), sample: null, blocks: 0 };
        }
        const inner = Array.isArray(block.content) ? block.content : [];
        for (const item of inner) entry.types.add(item?.type ?? '?');
        entry.blocks += 1;
        if (entry.sample === null) {
          // Record the KEY NAMES of a structured block, if there is one. A text-only body
          // means "the result is prose", which is exactly the case that must NOT be parsed
          // with regexes to guess what a command did.
          entry.sample = inner
            .map((item) => (item?.type === 'text' ? `text(${String(item.text).length} chars)` : `object{${Object.keys(item ?? {}).join(',')}}`))
            .join(', ');
        }
        results.set(callId, entry);
      }
    }
  }
}

if (asJson) {
  console.log(
    JSON.stringify(
      {
        sessionsScanned,
        eventsScanned,
        tools: Object.fromEntries(
          [...tools.entries()].map(([name, entry]) => [
            name,
            { calls: entry.calls, keys: [...entry.keys].sort(), sample: entry.sample },
          ]),
        ),
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

console.log(`scanned ${sessionsScanned} session log(s), ${eventsScanned} events`);
console.log('');

const sorted = [...tools.entries()].sort((a, b) => b[1].calls - a[1].calls);
console.log('tool'.padEnd(24) + 'calls'.padStart(7) + '  argument keys');
console.log('-'.repeat(100));
for (const [name, entry] of sorted) {
  const keys = [...entry.keys].sort().join(', ');
  console.log(name.padEnd(24) + String(entry.calls).padStart(7) + '  ' + keys);
}

// A path-BEARING argument is the only deterministic source of "what did this turn produce".
// Flagged by NAME against a fixed vocabulary rather than by guessing which tools write: a
// new tool with a `file_path` argument must show up here without this script knowing it.
const PATH_HINTS = ['file_path', 'path', 'paths', 'output', 'target', 'dest', 'destination', 'filename', 'file'];
console.log('');
console.log('arguments whose NAME looks like a filesystem path (candidates for artifact extraction):');
let anyCandidate = false;
for (const [name, entry] of sorted) {
  const hits = [...entry.keys].filter((key) => PATH_HINTS.includes(key.toLowerCase()));
  if (hits.length === 0) continue;
  anyCandidate = true;
  console.log(`  ${name.padEnd(22)} ${hits.join(', ')}`);
  console.log(`    sample: ${String(entry.sample).replace(/\s+/g, ' ').slice(0, 140)}`);
}
if (!anyCandidate) console.log('  (none)');

// What shape do results take? Prose-only results cannot support "the artifact exists"
// without regex guessing, which is excluded by design.
console.log('');
const resultShapes = new Map();
for (const entry of results.values()) {
  const key = [...entry.types].sort().join(', ');
  resultShapes.set(key, (resultShapes.get(key) ?? 0) + 1);
}
console.log('tool/result inner content shapes:');
for (const [shape, count] of [...resultShapes.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(count).padStart(5)}  [${shape}]`);
}
console.log('');
console.log('A shape of [text] means the result body is prose: the supervisor must NOT parse it');
console.log('to guess what a command produced. Only a structured block would be a deterministic');
console.log('source for artifact existence.');
