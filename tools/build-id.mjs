#!/usr/bin/env node
/**
 * Compute (and optionally write) the BUILD_ID in lib/build.js.
 *
 * The hash covers every shipped module in a fixed order, so it changes whenever the
 * code changes and never changes for an unrelated reason. `--write` rewrites the two
 * exported constants in place; `--check` exits non-zero when the recorded id is
 * stale, which is what makes "did I reload the plugin?" answerable without guessing.
 *
 * USAGE
 *   node tools/build-id.mjs            # print the current source hash
 *   node tools/build-id.mjs --check    # exit 1 if lib/build.js is stale
 *   node tools/build-id.mjs --write    # update lib/build.js
 */

import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Every shipped module, discovered rather than listed.
 *
 * This used to be a hard-coded array, and that is a silent failure waiting to happen: add a
 * module, forget the array, and the new file's contents no longer affect the id — so
 * `--check` reports "current" for a plugin that is genuinely older than its sources, which is
 * the exact question this tool exists to answer. `lib/artifacts.js` was added under the listed
 * version and would have been the first casualty.
 *
 * Discovered by directory listing and SORTED, so the order is fixed across runs and platforms
 * while remaining impossible to get out of date. `lib/build.js` is excluded because it is the
 * file being written.
 */
const MODULES = [
  ...readdirSync(join(ROOT, 'lib'))
    .filter((name) => name.endsWith('.js') && name !== 'build.js')
    .sort()
    .map((name) => `lib/${name}`),
  'cordis.patch.yml',
];

/**
 * FNV-1a over the concatenated module bytes, rendered as 12 hex chars.
 *
 * Wider than the 32-bit fingerprints in the log because this identifies a build
 * rather than a turn state: a collision here would misattribute an entire session's
 * worth of rows, so the extra four characters are cheap insurance.
 * @returns {string}
 */
function computeBuildId() {
  // Two 32-bit lanes, seeded differently, so the result is 64 bits wide.
  let a = 0x811c9dc5;
  let b = 0x1b873593;
  for (const relative of MODULES) {
    const bytes = readFileSync(join(ROOT, relative));
    // A separator between files stops a byte moving across a boundary from
    // producing the same hash.
    for (const byte of [0x0a, 0x1f, ...bytes]) {
      a = Math.imul(a ^ byte, 0x01000193) >>> 0;
      b = Math.imul(b ^ byte, 0x85ebca6b) >>> 0;
    }
  }
  return (a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0')).slice(0, 12);
}

const id = computeBuildId();
const target = join(ROOT, 'lib', 'build.js');
const source = readFileSync(target, 'utf8');
const recorded = /export const BUILD_ID = '([^']*)'/.exec(source)?.[1] ?? '';

const mode = process.argv[2] ?? '--print';

if (mode === '--write') {
  const at = new Date().toISOString();
  const updated = source
    .replace(/export const BUILD_ID = '[^']*'/, `export const BUILD_ID = '${id}'`)
    .replace(/export const BUILD_AT = '[^']*'/, `export const BUILD_AT = '${at}'`);
  writeFileSync(target, updated);
  console.log(`BUILD_ID written: ${id}  (${at})`);
  console.log(`modules hashed: ${MODULES.length}`);
  process.exit(0);
}

if (mode === '--check') {
  if (recorded === id) {
    console.log(`BUILD_ID current: ${id}`);
    process.exit(0);
  }
  console.log(`BUILD_ID STALE: recorded=${recorded || '(none)'} computed=${id}`);
  console.log('run: node tools/build-id.mjs --write');
  process.exit(1);
}

console.log(id);
