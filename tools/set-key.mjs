#!/usr/bin/env node
/**
 * Place the TypeSafe key where the completion supervisor reads it.
 *
 * WHY A PROMPT RATHER THAN A FILE THE USER EDITS BY HAND
 * -----------------------------------------------------
 * Three ways to get a secret into place, and this one is chosen deliberately:
 *
 *   1. Paste it into a chat with an agent — it lands in the transcript, which is
 *      persisted, summarised, and possibly ingested into long-term memory. Never.
 *   2. `TYPESAFE_API_KEY=… node …` or `setx` — the value is captured by the shell's
 *      history file, and on Windows by the registry, in plaintext, for every process
 *      to read.
 *   3. Type it at a hidden prompt — it is never echoed, never in a process argument
 *      list, never in history. This script.
 *
 * The file it writes lives in the DSH home, outside every repository, so it cannot be
 * committed and `git status` in a project can never show it.
 *
 * Writing is done with Node rather than PowerShell on purpose: PowerShell 5.1's
 * `Set-Content -Encoding UTF8` re-reads a file as ANSI and has already corrupted
 * non-ASCII text in this project twice.
 *
 * USAGE
 *   node tools/set-key.mjs            # prompt for the key and write it
 *   node tools/set-key.mjs --status   # say whether a key is in place, never print it
 *   node tools/set-key.mjs --remove   # delete the file
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

/** Must match `defaultKeyFilePath()` in lib/jev.js. */
const KEY_PATH = process.env.DSH_TYPESAFE_KEY_FILE?.trim()
  || join(homedir(), '.dsh', 'completion-supervisor', '.env');

const args = process.argv.slice(2);

/**
 * Show enough of a key to recognise it, never enough to use it.
 *
 * Deliberately not the common `first10…last4` shape: TypeSafe keys begin with a fixed
 * `apikey_` prefix, so the first ten characters are mostly boilerplate and the visible
 * tail is what identifies the key. Length plus the last four is enough to answer "is
 * this the one I just created?" without exposing a usable fragment.
 */
function mask(key) {
  if (key.length <= 8) return `<${key.length} chars>`;
  return `…${key.slice(-4)} (${key.length} chars)`;
}

/** Read the key currently on disk, or '' when there is none. */
function currentKey() {
  if (!existsSync(KEY_PATH)) return '';
  const text = readFileSync(KEY_PATH, 'utf8');
  const match = /^\s*(?:export\s+)?TYPESAFE_API_KEY\s*=\s*(.+?)\s*$/m.exec(text);
  if (match === null) return '';
  return match[1].replace(/^["']|["']$/g, '').trim();
}

if (args.includes('--status')) {
  const key = currentKey();
  console.log(`key file: ${KEY_PATH}`);
  console.log(`exists  : ${existsSync(KEY_PATH)}`);
  console.log(`key     : ${key.length > 0 ? mask(key) : '(none)'}`);
  console.log(`env var : ${process.env.TYPESAFE_API_KEY ? 'set (takes precedence over the file)' : 'not set'}`);
  process.exit(key.length > 0 ? 0 : 1);
}

if (args.includes('--remove')) {
  if (existsSync(KEY_PATH)) {
    rmSync(KEY_PATH);
    console.log(`removed ${KEY_PATH}`);
  } else {
    console.log('nothing to remove');
  }
  process.exit(0);
}

/**
 * Ask for the key without echoing it.
 *
 * Raw mode plus a keypress loop, using only public API. The `rl._writeToOutput`
 * override is the more common trick, but it reaches into a private field and changes
 * behaviour between Node versions; this does not.
 *
 * A non-TTY stdin is refused outright rather than read. A piped key is a key that is
 * already in a file or a command line somewhere else, so accepting it here would give
 * a false sense of having avoided that — and it would hide the fact that the value is
 * now sitting in whatever pipe fed it.
 *
 * @param {string} question
 * @returns {Promise<string>}
 */
function promptHidden(question) {
  return new Promise((resolve, reject) => {
    const input = process.stdin;
    const output = process.stdout;

    if (input.isTTY !== true) {
      reject(new Error('stdin is not a terminal; refusing to read a secret from a pipe'));
      return;
    }

    output.write(question);
    input.setRawMode(true);
    input.resume();
    input.setEncoding('utf8');

    let value = '';
    let settled = false;

    const cleanup = () => {
      input.removeListener('data', onData);
      input.setRawMode(false);
      input.pause();
    };
    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      cleanup();
      output.write('\n');
      fn(arg);
    };

    function onData(char) {
      // Enter finishes; Ctrl-D also finishes (and yields whatever was typed).
      if (char === '\r' || char === '\n' || char === '\u0004') {
        finish(resolve, value);
        return;
      }
      // Ctrl-C cancels without writing anything.
      if (char === '\u0003') {
        finish(reject, new Error('cancelled'));
        return;
      }
      // Backspace. Terminals send DEL (0x7f) for the main key, or BS.
      if (char === '\u007f' || char === '\b') {
        value = value.slice(0, -1);
        return;
      }
      // Ignore control characters; keep everything printable, including non-ASCII.
      if (char >= ' ') value += char;
    }

    input.on('data', onData);
  });
}

console.log('TypeSafe key setup for dsh-completion-supervisor');
console.log(`target: ${KEY_PATH}`);
console.log('');

let key;
try {
  key = (await promptHidden('Paste the key, then press Enter (input is hidden): ')).trim();
} catch (error) {
  console.error(`\n${error.message}`);
  process.exit(1);
}

if (key.length === 0) {
  console.error('empty input — nothing written');
  process.exit(1);
}

// A bare key, or a whole `NAME=value` line pasted from somewhere. Both are common,
// and silently storing the wrong one produces a confusing 401 later.
if (/^[A-Za-z_][A-Za-z0-9_]*\s*=/.test(key)) {
  const after = key.slice(key.indexOf('=') + 1).trim();
  console.log('input looked like a NAME=value line; keeping only the value');
  key = after;
}
key = key.replace(/^["']|["']$/g, '').trim();

if (key.length < 16) {
  console.error(`that is only ${key.length} characters — too short for a real key; nothing written`);
  process.exit(1);
}

mkdirSync(dirname(KEY_PATH), { recursive: true });
writeFileSync(KEY_PATH, `TYPESAFE_API_KEY=${key}\n`, { encoding: 'utf8', mode: 0o600 });
try {
  // On Windows this is mostly a no-op, but it matters if the home directory is on a
  // filesystem where the mode is honoured.
  chmodSync(KEY_PATH, 0o600);
} catch {
  // Not fatal.
}

console.log('');
console.log(`written: ${mask(key)}`);
console.log('the key was not echoed, and is not in your shell history');
console.log('');
console.log('NEXT: restart DSH, then ask the agent for completion_supervisor_status.');
console.log('      It should read "TYPESAFE_API_KEY present: true (file …)".');
