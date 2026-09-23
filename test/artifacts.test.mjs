/**
 * The deterministic artifact layer.
 *
 * These tests are mostly about what is NOT recorded, because that is where the risk is. A
 * missing path costs Jev some context; an INVENTED path puts a fabricated fact into the state
 * that the whole completion judgement rests on — the same class of error as reading a wrapped
 * exit code as a pass, which already reached a real session once.
 *
 * The shapes below are copied from a real session log rather than written from memory:
 * `write` takes `{content, file_path}`, `present` takes `{files: [{path, description}]}`,
 * `edit` takes `{file_path, old_string, new_string}`, and `pwsh` takes
 * `{command, description, workdir, timeoutMs, run_in_background}`. Measured with
 * `node tools/scan-tool-schemas.mjs`, which reports the argument keys of every tool this
 * machine has actually used.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { deriveArtifacts, describeArtifacts, relativizePath } from '../lib/artifacts.js';
import { materialFacts, fingerprintState } from '../lib/fingerprint.js';

const WS = 'C:\\Users\\me\\Desktop\\git cloud\\dsh-completion-supervisor';

// ── what IS recorded: structured arguments ───────────────────────────────────

test('the producing tools contribute their paths from structured arguments', () => {
  const calls = [
    { name: 'write', args: { content: 'x', file_path: `${WS}\\scratch\\note.md` }, ok: true },
    { name: 'edit', args: { file_path: `${WS}\\lib\\taskstate.js`, old_string: 'a', new_string: 'b' }, ok: true },
    { name: 'present', args: { files: [{ path: `${WS}\\out\\report.pdf`, description: 'the report' }] }, ok: true },
  ];

  const artifacts = deriveArtifacts(calls, { cwd: WS });
  assert.deepEqual(
    [...artifacts.created_or_written_paths].sort(),
    ['lib\\taskstate.js', 'out\\report.pdf', 'scratch\\note.md'],
    'all three tools must contribute, present via its nested items[]',
  );
  assert.equal(artifacts.verified_artifacts.length, 3);
  assert.deepEqual(
    artifacts.material_actions.map((action) => action.verb).sort(),
    ['edited', 'presented', 'wrote'],
    'the verb says which operation happened, not merely that a path was seen',
  );
});

test('a read touches a path without producing anything', () => {
  const calls = [
    { name: 'read', args: { file_path: `${WS}\\package.json`, limit: 40 }, ok: true },
    { name: 'read_image', args: { file_path: `${WS}\\shot.png` }, ok: true },
  ];

  const artifacts = deriveArtifacts(calls, { cwd: WS });
  assert.deepEqual(artifacts.created_or_written_paths, [], 'reading is not producing');
  assert.deepEqual(artifacts.touched_paths.sort(), ['package.json', 'shot.png']);
  assert.deepEqual(artifacts.verified_artifacts, []);
});

// ── what is NOT recorded: anything requiring a guess ─────────────────────────

test('a shell command is never parsed for the files it might have produced', () => {
  // THE RULE THIS LOCKS IN. Every one of these commands plausibly creates a file, and one of
  // them says so in plain text. None may be recorded, because deciding which is which needs a
  // guess about shell semantics, and a guessed artifact is a fabricated fact.
  //
  // Measured context: all 1375 tool results in the sampled logs were plain prose (`[text]`),
  // and all 545 `pwsh` calls carried only command/description/workdir/timeoutMs/
  // run_in_background. There is no structured field to read.
  const calls = [
    { name: 'pwsh', args: { command: 'Invoke-WebRequest -OutFile C:\\ws\\dl.exe https://example.com/x.exe' }, ok: true },
    { name: 'pwsh', args: { command: 'npm run build' }, ok: true },
    { name: 'pwsh', args: { command: 'New-Item -Path C:\\ws\\made.txt -ItemType File' }, ok: true },
    { name: 'pwsh', args: { command: 'Set-Content -Path C:\\ws\\written.md -Value hello' }, ok: true },
  ];

  const artifacts = deriveArtifacts(calls, { cwd: 'C:\\ws' });
  assert.deepEqual(artifacts.created_or_written_paths, [], 'a command name is not a file path');
  assert.deepEqual(artifacts.touched_paths, []);
  assert.deepEqual(artifacts.verified_artifacts, []);
  assert.deepEqual(artifacts.material_actions, []);
});

test('an unknown tool is ignored, so a new tool is under-reported and never mis-reported', () => {
  // An ALLOW-list, like `isUserAuthored` and the user-facing block filter. Under-reporting is
  // recoverable (the path simply is not shown); mis-reporting is not.
  const calls = [
    { name: 'some_future_writer', args: { file_path: 'C:\\ws\\a.md' }, ok: true },
    { name: 'univer_export', args: { output: 'C:\\ws\\b.xlsx' }, ok: true },
  ];

  const artifacts = deriveArtifacts(calls, { cwd: 'C:\\ws' });
  assert.deepEqual(artifacts.created_or_written_paths, []);
  assert.deepEqual(artifacts.material_actions, []);
});

test('a path argument with the wrong shape contributes nothing instead of a broken value', () => {
  const calls = [
    { name: 'write', args: { file_path: 42 }, ok: true },
    { name: 'write', args: { file_path: '   ' }, ok: true },
    { name: 'present', args: { files: 'not-an-array' }, ok: true },
    { name: 'present', args: { files: [{ description: 'no path here' }] }, ok: true },
    { name: 'write', args: null, ok: true },
    { name: 'write', args: { file_path: 'C:\\ws\\ok.md' }, ok: true },
  ];

  const artifacts = deriveArtifacts(calls, { cwd: 'C:\\ws' });
  assert.deepEqual(artifacts.created_or_written_paths, ['ok.md'], 'only the well-formed path survives');
});

test('a write that reported an error is an action but not a delivered artifact', () => {
  // The distinction `verified_artifacts` exists for. `isError` is a real structured field on
  // the result block, so the success signal is an observation rather than a guess.
  const calls = [{ name: 'write', args: { file_path: `${WS}\\failed.md` }, ok: false }];

  const artifacts = deriveArtifacts(calls, { cwd: WS });
  assert.deepEqual(artifacts.created_or_written_paths, ['failed.md'], 'the attempt is recorded');
  assert.deepEqual(artifacts.verified_artifacts, [], 'the failure is not');
  assert.equal(artifacts.material_actions[0].ok, false);
});

test('a file written and then edited is one artifact, not two', () => {
  const calls = [
    { name: 'write', args: { file_path: `${WS}\\a.md` }, ok: true },
    { name: 'edit', args: { file_path: `${WS}\\a.md` }, ok: true },
  ];

  const artifacts = deriveArtifacts(calls, { cwd: WS });
  assert.deepEqual(artifacts.created_or_written_paths, ['a.md']);
  assert.equal(artifacts.verified_artifacts.length, 1);
  assert.equal(artifacts.material_actions.length, 2, 'both operations are still reported');
});

// ── path shortening ──────────────────────────────────────────────────────────

test('paths inside the working directory are shortened; anything else is kept intact', () => {
  assert.equal(relativizePath(`${WS}\\scratch\\note.md`, WS), 'scratch\\note.md');
  assert.equal(relativizePath(`${WS}\\scratch\\note.md`, `${WS}\\`), 'scratch\\note.md', 'a trailing separator is tolerated');
  assert.equal(relativizePath('c:\\users\\me\\desktop\\git cloud\\dsh-completion-supervisor\\a.md', WS), 'a.md', 'Windows paths are case-insensitive');
  assert.equal(
    relativizePath('C:\\Users\\me\\AppData\\Local\\Tabbit Browser\\artifacts\\x.png', WS),
    'C:\\Users\\me\\AppData\\Local\\Tabbit Browser\\artifacts\\x.png',
    'a path outside the workspace keeps its full form: shortening it would hide WHERE it is',
  );
  // The working directory itself must not collapse to an empty string, because "" reads as
  // "no path" and the directory is a real location the turn may have been about.
  assert.equal(relativizePath(WS, WS), WS);
  assert.equal(relativizePath(`${WS}\\a.md`, null), `${WS}\\a.md`, 'no cwd means no shortening, not a crash');
});

test('a prefix that only LOOKS like the workspace is not shortened', () => {
  // `...-supervisor-other` starts with the workspace string, and a naive `startsWith` without
  // a separator check would produce a mangled relative path for a file that lives elsewhere.
  const sibling = `${WS}-other\\a.md`;
  assert.equal(relativizePath(sibling, WS), sibling);
});

// ── the fingerprint must notice a produced file ──────────────────────────────

test('producing a file changes the fingerprint, which is what makes re-assessment happen', () => {
  // Without this, "wrote a new file" fingerprints identically to "did nothing", the second
  // stopping is skipped as `no_material_change`, and the improved evidence never reaches Jev.
  const base = {
    goal: 'create the note',
    claim: 'Created it.',
    repo: { available: false, changed_files: [], untracked: [] },
    evidence: { tests_run: false, tests_passed: null },
    commands: [],
    activity: { tool_calls_this_turn: 0 },
  };

  const before = fingerprintState(base).fingerprint;
  const afterWrite = fingerprintState({
    ...base,
    activity: { tool_calls_this_turn: 1, created_or_written_paths: ['scratch\\note.md'], verified_artifacts: [{ path: 'scratch\\note.md', tool: 'write', ok: true }] },
  }).fingerprint;

  assert.notEqual(before, afterWrite, 'a produced file is a material change');
});

test('a file that failed then succeeded IS a material change', () => {
  // The two fields are not redundant: the path list is identical across both states, so only
  // `verified_artifacts` distinguishes them. That transition is exactly when a re-assessment
  // is worth a Jev call.
  const base = {
    goal: 'g',
    claim: 'c',
    repo: { available: false, changed_files: [] },
    evidence: {},
    commands: [],
  };
  const failed = fingerprintState({
    ...base,
    activity: { created_or_written_paths: ['a.md'], verified_artifacts: [] },
  }).fingerprint;
  const succeeded = fingerprintState({
    ...base,
    activity: { created_or_written_paths: ['a.md'], verified_artifacts: [{ path: 'a.md', tool: 'write', ok: true }] },
  }).fingerprint;

  assert.notEqual(failed, succeeded);
});

test('reading different files does NOT change the fingerprint', () => {
  // Reading churns constantly and says nothing about whether the work is finished. Including
  // it would defeat the deduplication the fingerprint exists for.
  const base = {
    goal: 'g',
    claim: 'c',
    repo: { available: false, changed_files: [] },
    evidence: {},
    commands: [],
    activity: { created_or_written_paths: [] },
  };
  const readOne = fingerprintState({ ...base, activity: { ...base.activity, touched_paths: ['a.md'] } }).fingerprint;
  const readOther = fingerprintState({ ...base, activity: { ...base.activity, touched_paths: ['b.md', 'c.md'] } }).fingerprint;
  assert.equal(readOne, readOther);
  assert.equal(fingerprintState(base).fingerprint, readOne);
});

test('the fingerprinted facts carry the artifact fields, so an analysis can see them', () => {
  const facts = materialFacts({
    repo: { available: false, changed_files: [] },
    evidence: {},
    activity: { created_or_written_paths: ['b.md', 'a.md'], verified_artifacts: [{ path: 'a.md' }] },
    commands: [],
  });
  // Sorted, so file ordering never changes the hash.
  assert.equal(facts.created_or_written_paths, 'a.md|b.md');
  assert.equal(facts.verified_artifacts, 'a.md');
});

// ── the summary line ─────────────────────────────────────────────────────────

test('describeArtifacts reports produced and confirmed paths, and nothing when there are none', () => {
  const lines = describeArtifacts({
    created_or_written_paths: ['a.md', 'b.md'],
    verified_artifacts: [{ path: 'a.md' }],
  });
  assert.equal(lines.length, 2);
  assert.match(lines[0], /files created or written \(2\): a\.md, b\.md/);
  assert.match(lines[1], /confirmed by a successful tool call \(1\): a\.md/);

  assert.deepEqual(describeArtifacts({ created_or_written_paths: [], verified_artifacts: [] }), []);
  assert.deepEqual(describeArtifacts(null), []);
});
