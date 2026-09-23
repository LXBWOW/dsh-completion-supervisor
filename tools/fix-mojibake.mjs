/**
 * Repair characters that a PowerShell 5.1 round-trip decoded as GBK.
 *
 * WHY THIS EXISTS
 *
 * `Set-Content -Encoding UTF8` on PowerShell 5.1 reads the existing file as if it
 * were ANSI (code page 936 on this machine) and then re-encodes what it read. Any
 * non-ASCII byte sequence that is valid GBK is silently replaced by the wrong
 * characters; the damage is invisible to the shell that caused it.
 *
 * This bit us twice:
 *   1. Chinese regex literals in this file's neighbours became `SyntaxError:
 *      Invalid regular expression: Unterminated group` -- a loud failure.
 *   2. Em dashes in comments became U+9225 + U+FFFD -- a silent one, which is
 *      worse: the code still runs, and only a human reading the file notices.
 *
 * The damaged characters are written as `\uXXXX` escapes below on purpose. A
 * literal sample in this file would be "repaired" by the first run, and the
 * repair table would then have nothing to match.
 *
 * Node is the safe writer here: it reads and writes UTF-8 without consulting a
 * system code page at all. Run with `--check` to report without changing anything.
 *
 * Usage:
 *   node tools/fix-mojibake.mjs [--check] [--dir .]
 */

import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * This script is excluded from its own scan: the repair table below has to spell
 * the damaged sequences out, and repairing those definitions would delete the
 * table itself. The first run of this tool rewrote its own comments for exactly
 * that reason.
 */
const SELF = fileURLToPath(import.meta.url);

/** File types worth scanning: source, docs, and data. */
const SCAN_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.md', '.json', '.yml', '.yaml', '.txt']);

/** Directories that never contain our source. */
const SKIP_DIRS = new Set(['node_modules', '.git', 'coverage', '.cache']);

/**
 * Damaged sequences, longest first so a longer run is rewritten before a shorter
 * one consumes part of it.
 *
 * Keys are the literal characters to find; values are what they should have been.
 * U+FFFD is the replacement character the decoder emits for a byte it cannot map.
 * U+9225 (\u9225) is what the GBK decode produced for the first two bytes of an em dash.
 */
const REPAIRS = [
  // Em dash `—` (E2 80 94) decoded as GBK: U+9225 followed by a replacement char.
  ['\u9225\uFFFD', '\u2014'],
  ['\u9225?', '\u2014'],
  ['\u9225', '\u2014'],

  // En dash `–` (E2 80 93) decoded as GBK.
  ['\u93c8\uFFFD', '\u2013'],
  ['\u93c8?', '\u2013'],

  // Right single quote `’` (E2 80 99) decoded as GBK.
  ['\u934f\uFFFD', '\u2019'],
  ['\u934f?', '\u2019'],

  // Left/right double quotes (E2 80 9C / E2 80 9D).
  ['\u93c1\uFFFD', '\u201C'],
  ['\u93c7\uFFFD', '\u201D'],

  // A bare replacement character with nothing recoverable around it.
  ['\uFFFD', '?'],

  // Escapes that PowerShell 5.1 cannot parse, written out literally.
  //
  // `` `u{2014} `` is PowerShell 7 syntax. On 5.1 the backtick-u is not an escape
  // at all, so the six characters survive into the file verbatim and the prose
  // reads `contract u{2014} the codes`. Cheap to detect, so we do.
  ['u{2014}', '\u2014'],
  ['u{2013}', '\u2013'],
  ['u{2019}', '\u2019'],
  ['u{201C}', '\u201C'],
  ['u{201D}', '\u201D'],

  // ── escapes that were EVALUATED instead of stored ────────────────────────────
  //
  // A different failure from the GBK one above, and it produces ordinary control
  // characters, so it looks like nothing at all in a terminal. Measured in
  // `lib/taskstate.js`: the word `tests_passed` was stored as TAB + `ests_passed`, and
  // `build_ok` as BACKSPACE + `uild_ok` — the leading letter of each word was eaten by a
  // `\t` / `\b` escape that something downstream evaluated before writing the file.
  //
  // These two are repaired LITERALLY, because the general case cannot be: once a letter is
  // gone there is nothing left to infer it from. Only the occurrences whose intended text
  // is known are listed. Everything else is caught by `SUSPECTS` below, which reports and
  // refuses rather than guessing.
  ['\u0009ests_passed', 'tests_passed'],
  ['\u0008uild_ok', 'build_ok'],
];

/**
 * Patterns that are damaged but NOT auto-repairable, reported instead of rewritten.
 *
 * The distinction from `REPAIRS` is the whole design: a repair must know the intended text,
 * and for an evaluated escape the lost character is unknowable. Silently "fixing" one would
 * invent a variable name, which is worse than leaving the file visibly wrong — the failure
 * mode this repository keeps hitting is a plausible-looking wrong value, not a crash.
 *
 * Both patterns are narrow on purpose. A backspace character has no legitimate use in
 * source or prose. A tab is legitimate as leading indentation, so only a tab that appears
 * INSIDE a line — after a non-whitespace character — is flagged, which is the shape the
 * evaluated `\t` produced.
 */
const SUSPECTS = [
  { pattern: /\u0008/, label: 'backspace character (an evaluated \\b escape)' },
  { pattern: /[^\s\u0009]\u0009/, label: 'tab inside a line (an evaluated \\t escape?)' },
];

/** Recursively collect scannable files under `dir`. */
function collect(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      collect(full, out);
    } else if (SCAN_EXTENSIONS.has(extname(entry)) && full !== SELF) {
      out.push(full);
    }
  }
  return out;
}

const argv = process.argv.slice(2);
const checkOnly = argv.includes('--check');
const dirIndex = argv.indexOf('--dir');
const root = resolve(dirIndex >= 0 ? argv[dirIndex + 1] : '.');

let changed = 0;
let scanned = 0;
/** Damage that is reported rather than rewritten. See `SUSPECTS`. */
const suspects = [];

for (const file of collect(root)) {
  scanned += 1;
  const before = readFileSync(file, 'utf8');
  let after = before;

  for (const [bad, good] of REPAIRS) {
    if (after.includes(bad)) after = after.split(bad).join(good);
  }

  // Scan the REPAIRED text: a run that the table just fixed is no longer damage, and
  // reporting it again would make the two lists contradict each other.
  const shown = relative(root, file) || file;
  const afterLines = after.split('\n');
  for (const { pattern, label } of SUSPECTS) {
    for (let index = 0; index < afterLines.length; index += 1) {
      if (pattern.test(afterLines[index])) {
        suspects.push(`${shown}:${index + 1}  ${label}`);
        suspects.push(`    ${afterLines[index].trim().slice(0, 100)}`);
      }
    }
  }

  if (after === before) continue;

  changed += 1;
  const count = [...before].length - [...after].length === 0 ? 'several' : 'at least one';
  console.log(`${checkOnly ? 'WOULD FIX' : 'fixed'} ${shown} (${count} damaged character run)`);

  if (!checkOnly) writeFileSync(file, after, 'utf8');
}

console.log(`\nscanned ${scanned} files, ${changed} needed repair`);

if (suspects.length > 0) {
  console.log('');
  console.log('DAMAGE THAT CANNOT BE AUTO-REPAIRED (fix these by hand):');
  for (const line of suspects) console.log(`  ${line}`);
  console.log('');
  console.log('  An evaluated escape consumed a character, so the intended text is not');
  console.log('  recoverable from the file. Add a literal entry to REPAIRS once you know it.');
}

if (checkOnly && (changed > 0 || suspects.length > 0)) {
  console.log('run without --check to apply the repairable ones');
  process.exitCode = 1;
}
