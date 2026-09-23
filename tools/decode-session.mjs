/**
 * Decode a DSH session log and report how each user-role message was sourced.
 *
 * WHY: the supervisor treats "a user-authored message" as a task boundary that
 * resets the per-task assessment budget, and it must NOT treat its own injected
 * steering as one. The only way to know which is which is the message's
 * `source.kind`, and the only trustworthy source for that is a real session log.
 *
 * Session logs are `session.v3.jsonl.zstd` written as MANY CONCATENATED zstd
 * frames. A single decompressor reads only the first frame and silently stops, so
 * this walks the `28 b5 2f fd` magic bytes and decodes each frame in turn.
 *
 * Usage: node tools/decode-session.mjs [path-to-session-dir-or-file] [--sources]
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
    } catch (error) {
      parts.push(`\n<<frame failed: ${error.message}>>\n`);
    }
  }
  return parts.join('');
}

/** Find the newest session log under the DSH sessions directory. */
function defaultPath() {
  return findSession(null)?.path ?? null;
}

/**
 * Find a session log by a substring of its directory name, newest first.
 *
 * WHY NOT JUST PASS THE PATH
 * --------------------------
 * The sessions directory name DSH derives from a working directory contains characters
 * that do not survive a trip through a Windows shell's argument handling, and the session
 * directory name itself may contain characters that a hand-typed path misses. Resolving
 * the name here — from `readdirSync`, which returns the real bytes — removes the shell
 * from the loop entirely, so `--match <id>` works where a literal path silently does not.
 *
 * @param {string|null} needle
 * @returns {{path: string, mtimeMs: number}|null}
 */
function findSession(needle) {
  const root = join(process.env.USERPROFILE ?? '', '.dsh', 'sessions');
  if (!existsSync(root)) return null;
  let best = null;
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const stat = statSync(full);
      if (stat.isDirectory()) {
        walk(full);
      } else if (entry.endsWith('.zstd')) {
        if (needle !== null && !full.includes(needle)) continue;
        if (best === null || stat.mtimeMs > best.mtimeMs) best = { path: full, mtimeMs: stat.mtimeMs };
      }
    }
  };
  walk(root);
  return best;
}

const args = process.argv.slice(2);
const matchIndex = args.indexOf('--match');
const match = matchIndex === -1 ? null : (args[matchIndex + 1] ?? null);
const explicit = args.find((a, i) => !a.startsWith('--') && i !== matchIndex + 1);
const target = explicit ?? findSession(match)?.path ?? (match === null ? defaultPath() : null);

if (target === null || !existsSync(target)) {
  console.log('no session log found; pass a path explicitly');
  process.exit(0);
}

const buffer = readFileSync(target);
const text = decodeAll(buffer);
const lines = text.split('\n').filter((line) => line.trim().length > 0);

console.log(`file: ${target}`);
console.log(`bytes: ${buffer.length}   frames: ${splitFrames(buffer).length}   jsonl lines: ${lines.length}`);
console.log('');

/** Count how each user-role message was sourced. */
const sources = new Map();
const samples = [];
let sessionId = null;

for (const line of lines) {
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    continue;
  }
  if (sessionId === null) {
    sessionId = event?.session_id ?? event?.data?.sessionId ?? null;
  }
  if (event?.type !== 'user/message') continue;
  const msg = event.data;
  if (msg === null || typeof msg !== 'object') continue;
  const kind = msg.source?.kind ?? '(none)';
  const plugin = msg.source?.plugin ?? msg.source?.rpcId ?? '';
  const key = plugin === '' ? kind : `${kind} (${plugin})`;
  sources.set(key, (sources.get(key) ?? 0) + 1);

  const blocks = Array.isArray(msg.content) ? msg.content : [];
  const preview = blocks
    .filter((b) => b?.type === 'text')
    .map((b) => String(b.text).replace(/\s+/g, ' ').slice(0, 70))
    .join(' / ');
  samples.push({ key, preview });
}

console.log('user-role messages by source:');
for (const [key, count] of [...sources.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(count).padStart(4)}  ${key}`);
}

if (args.includes('--sources')) {
  console.log('');
  console.log('every user-role message in order:');
  for (const s of samples) console.log(`  [${s.key}] ${s.preview}`);
}

if (args.includes('--tools')) {
  // WHAT ARGUMENTS DO THE FILE TOOLS ACTUALLY TAKE?
  //
  // TaskState records only the tool NAMES (`activity.tools_used`) plus a shell-command
  // list, so a file created by the `write` tool leaves no trace of WHICH file — and in a
  // directory that is not a git repository, `repo.changed_files` is empty, so Jev cannot
  // see that anything was created at all. Reading a path out of the arguments is the fix,
  // but the field name has to come from a real call rather than from memory.
  const byTool = new Map();
  const samples = new Map();
  for (const line of lines) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event?.type !== 'tool/call') continue;
    const data = event.data ?? {};
    const name = data.name ?? '(unnamed)';
    byTool.set(name, (byTool.get(name) ?? 0) + 1);
    if (!samples.has(name)) {
      // `arguments` is a JSON STRING on the log; parse defensively and report the KEY
      // NAMES, which is the fact this probe exists to establish.
      let parsed = null;
      try {
        parsed = JSON.parse(data.arguments);
      } catch {
        parsed = null;
      }
      samples.set(name, {
        raw: typeof data.arguments === 'string' ? data.arguments.slice(0, 150) : String(data.arguments),
        keys: parsed !== null && typeof parsed === 'object' ? Object.keys(parsed) : null,
      });
    }
  }

  console.log('');
  console.log('tool calls by name:');
  for (const [name, count] of [...byTool.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(count).padStart(5)}  ${name}`);
  }
  console.log('');
  console.log('one sample argument shape per tool (the KEY NAMES are the point):');
  for (const [name, sample] of samples) {
    console.log(`  ${name}`);
    console.log(`    keys: ${sample.keys === null ? '(arguments did not parse as an object)' : `[${sample.keys.join(', ')}]`}`);
    console.log(`    raw:  ${sample.raw.replace(/\s+/g, ' ')}`);
  }
}

if (args.includes('--blocks')) {
  // WHICH CONTENT-BLOCK TYPES DOES EACH EVENT CARRY?
  //
  // The supervisor builds `claim` by concatenating every block of the turn's last
  // assistant message that has a `.text` string — it does not look at `block.type`. That
  // is only correct if an assistant message contains nothing but user-facing prose. If it
  // can also carry a reasoning/thinking block, then "the completion claim" is really a
  // draft followed by a reply, and Jev is asked whether a DRAFT is supported by the
  // evidence. Nothing in a probability would reveal that; this does.
  const shapes = new Map();
  const assistantSamples = [];
  let assistantMessages = 0;
  let contaminated = 0;
  let reasoningOnly = 0;
  for (const line of lines) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    const content = event?.data?.message?.content ?? event?.data?.content;
    if (!Array.isArray(content)) continue;
    const types = content.map((block) => block?.type ?? '?');
    const key = `${event.type} -> [${types.join(', ')}]`;
    shapes.set(key, (shapes.get(key) ?? 0) + 1);

    if (event.type === 'assistant/message') {
      // Compare the two claim rules on real data. OLD: every block with a `.text` (what
      // the reader did). NEW: only `type === 'text'` blocks (the reply the user sees).
      const oldText = content
        .filter((block) => typeof block?.text === 'string')
        .map((block) => block.text)
        .join('\n')
        .trim();
      const newText = content
        .filter((block) => block?.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text)
        .join('\n')
        .trim();
      assistantMessages += 1;
      if (oldText !== newText) contaminated += 1;
      if (newText.length === 0) reasoningOnly += 1;

      if (assistantSamples.length < 4) {
        assistantSamples.push({
          blocks: content.map((block) => ({
            type: block?.type ?? '?',
            fields: Object.keys(block ?? {}).join(','),
            preview: String(block?.text ?? '').replace(/\s+/g, ' ').slice(0, 78),
          })),
          oldText: oldText.replace(/\s+/g, ' ').slice(0, 96),
          newText: newText.replace(/\s+/g, ' ').slice(0, 96),
        });
      }
    }
  }

  console.log('');
  console.log('content-block shapes per event type:');
  for (const [shape, count] of [...shapes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20)) {
    console.log(`  ${String(count).padStart(5)}  ${shape}`);
  }

  console.log('');
  console.log('claim extraction, OLD rule (every block with .text) vs NEW rule (type=text only):');
  console.log(`  assistant messages: ${assistantMessages}`);
  console.log(`  the two rules disagree on: ${contaminated}`);
  console.log(`  messages with NO user-facing text at all (reasoning-only steps): ${reasoningOnly}`);
  if (assistantMessages > 0 && contaminated > 0) {
    console.log(
      `  -> ${Math.round((contaminated / assistantMessages) * 100)}% of assistant messages carried private`,
    );
    console.log('     reasoning into the claim. Jev was asked whether a DRAFT was supported by the');
    console.log('     evidence, which is a question whose low probability is the correct answer.');
  }

  console.log('');
  console.log('sample assistant/message blocks (what `claim` would concatenate):');
  for (const [index, sample] of assistantSamples.entries()) {
    console.log(`  message ${index + 1}: ${sample.blocks.length} block(s)`);
    for (const block of sample.blocks) {
      console.log(`    type=${block.type}  fields=[${block.fields}]`);
      console.log(`      "${block.preview}"`);
    }
    console.log(`    OLD claim: ${sample.oldText}`);
    console.log(`    NEW claim: ${sample.newText}`);
  }
  if (assistantSamples.length === 0) {
    console.log('  (this log has no assistant/message event with an array content field)');
  }
}
