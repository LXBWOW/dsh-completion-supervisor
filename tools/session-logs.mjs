/**
 * Reading DSH session logs, shared by the offline tools.
 *
 * WHY A MODULE
 * ------------
 * Three tools now need this: `decode-session` (report message sources and block shapes),
 * `scan-tool-schemas` (survey tool argument shapes), and `verify-artifacts` (replay a real
 * session through the supervisor's reader). Three copies of a decompressor is how one of them
 * quietly drifts and starts reporting something the others do not.
 *
 * THE ONE FACT THAT MAKES THIS NECESSARY
 * --------------------------------------
 * A session log is `session.v3.jsonl.zstd` written as MANY CONCATENATED zstd frames. Node's
 * `zstdDecompressSync` reads the FIRST frame and stops, silently — no error, no warning, just
 * a small fraction of the session. Every frame begins with the magic bytes `28 b5 2f fd`, so
 * this walks them and decodes each in turn.
 *
 * The same trap shows up twice in this project's history in other forms: a prefix-truncated
 * tool result losing the exit marker, and a `startsWith` without a separator boundary. In all
 * three cases the wrong answer looks like a plausible answer.
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/** The DSH sessions root for the current user. */
export function sessionsRoot() {
  return join(process.env.USERPROFILE ?? '', '.dsh', 'sessions');
}

/**
 * Split a concatenated-zstd buffer into its individual frames.
 * @param {Buffer} buffer
 * @returns {Buffer[]}
 */
export function splitFrames(buffer) {
  const offsets = [];
  let index = buffer.indexOf(ZSTD_MAGIC, 0);
  while (index !== -1) {
    offsets.push(index);
    index = buffer.indexOf(ZSTD_MAGIC, index + 4);
  }
  return offsets.map((start, i) => buffer.subarray(start, offsets[i + 1] ?? buffer.length));
}

/**
 * Decode every frame and concatenate the plaintext.
 *
 * A frame that fails to decode is skipped rather than fatal: a torn tail is normal for a
 * session that is still being written, and a survey should not refuse to run because of it.
 *
 * @param {Buffer} buffer
 * @returns {string}
 */
export function decodeAll(buffer) {
  const parts = [];
  for (const frame of splitFrames(buffer)) {
    try {
      parts.push(zstdDecompressSync(frame).toString('utf8'));
    } catch {
      // Skip; see above.
    }
  }
  return parts.join('');
}

/**
 * Every session log on disk, with its mtime and size.
 * @returns {Array<{path: string, mtimeMs: number, size: number}>}
 */
export function allSessions() {
  const root = sessionsRoot();
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
  return found;
}

/**
 * Find a session log by a substring of its full path, newest first.
 *
 * WHY NOT JUST PASS A PATH
 * ------------------------
 * The workspace directory name DSH derives contains characters that do not survive a trip
 * through a Windows shell's argument handling, and a hand-typed path can miss them entirely —
 * observed as `Test-Path: False` for a directory that `Get-ChildItem` had just listed.
 * Resolving the name here, from `readdirSync`, removes the shell from the loop.
 *
 * @param {string|null} needle - substring to match, or null for the newest overall.
 * @returns {{path: string, mtimeMs: number, size: number}|null}
 */
export function findSession(needle = null) {
  const matches = allSessions().filter((entry) => needle === null || entry.path.includes(needle));
  if (matches.length === 0) return null;
  return matches.sort((a, b) => b.mtimeMs - a.mtimeMs)[0];
}

/**
 * Read a session log and return its JSONL events.
 *
 * @param {string} path
 * @returns {object[]} parsed events; unparsable lines are dropped.
 */
export function readSessionEvents(path) {
  const text = decodeAll(readFileSync(path));
  const events = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed !== null && typeof parsed === 'object') events.push(parsed);
    } catch {
      // A torn tail from a crash mid-write; ignore and keep reading.
    }
  }
  return events;
}
