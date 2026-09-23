/**
 * REPLAY a real session through the supervisor's own reader to see what Jev would be shown.
 *
 * WHY THIS IS THE RIGHT VERIFICATION
 * ----------------------------------
 * The v3 change exists to close one specific gap: in a directory that is not a git repository,
 * `repo.changed_files` is always empty, so a turn that created a file reached Jev carrying no
 * evidence of it — and Jev answered `requirements_satisfied` low enough (measured 0.26-0.48)
 * to trip the P4 block rule on completed turns.
 *
 * Unit tests cannot show whether the gap is closed, because they build their own events. This
 * decodes a session that REALLY happened and runs it through `deriveEvidence` and
 * `assembleTaskState`, so the output is what the plugin would have sent.
 *
 * It reads no network and writes nothing.
 *
 * Usage:
 *   node tools/verify-artifacts.mjs --match f03699dd
 *   node tools/verify-artifacts.mjs --newest --cwd "C:\Users\me\Desktop\git cloud"
 *   node tools/verify-artifacts.mjs --match <id> --json
 */

import { deriveEvidence, assembleTaskState, TASK_STATE_VERSION } from '../lib/taskstate.js';
import { findSession, readSessionEvents } from './session-logs.mjs';

const args = process.argv.slice(2);
const matchIndex = args.indexOf('--match');
const match = matchIndex >= 0 ? (args[matchIndex + 1] ?? null) : null;
const cwdIndex = args.indexOf('--cwd');
const cwd = cwdIndex >= 0 ? (args[cwdIndex + 1] ?? null) : process.cwd();
const asJson = args.includes('--json');

const session = findSession(match);
if (session === null) {
  console.log(match === null ? 'no session logs found' : `no session log matching "${match}"`);
  process.exit(0);
}

const events = readSessionEvents(session.path);

/** The turns the session actually contains, in order. */
const turns = [];
for (const event of events) {
  const turn = event?.data?.turn;
  if (typeof turn === 'number' && !turns.includes(turn)) turns.push(turn);
}
turns.sort((a, b) => a - b);

const report = [];
for (const turn of turns) {
  const derived = deriveEvidence(events, turn, { cwd });
  // The state Jev would receive. `git` is passed as unavailable because that is this machine's
  // real situation for the default working directory — and it is the case being tested.
  const state = assembleTaskState({
    sessionId: 'replay',
    turn,
    cwd,
    derived,
    git: { available: false, changed_files: [], untracked: [], insertions: null, deletions: null },
    prior: null,
    at: '1970-01-01T00:00:00.000Z',
  });
  report.push({
    turn,
    tool_calls: derived.activity.tool_calls_this_turn,
    tools_used: derived.activity.tools_used,
    created_or_written_paths: derived.artifacts.created_or_written_paths,
    touched_paths: derived.artifacts.touched_paths,
    verified_artifacts: derived.artifacts.verified_artifacts,
    material_actions: derived.artifacts.material_actions,
    repo_available: state.repo.available,
    changed_files: state.repo.changed_files,
  });
}

if (asJson) {
  console.log(JSON.stringify({ session: session.path, cwd, task_v: TASK_STATE_VERSION, turns: report }, null, 2));
  process.exit(0);
}

console.log(`session: ${session.path}`);
console.log(`events:  ${events.length}   turns: ${turns.length}`);
console.log(`cwd (assumed for path shortening): ${cwd}`);
console.log(`task_v: ${TASK_STATE_VERSION}`);
console.log('');

let turnsWithProduced = 0;
let turnsWithEvidenceAndNoRepo = 0;

for (const entry of report) {
  const produced = entry.created_or_written_paths;
  if (produced.length > 0) turnsWithProduced += 1;
  if (produced.length > 0 && entry.repo_available === false && entry.changed_files.length === 0) {
    turnsWithEvidenceAndNoRepo += 1;
  }

  console.log(`turn ${entry.turn}   ${entry.tool_calls} tool call(s)  [${entry.tools_used.join(', ')}]`);
  console.log(`  repo.available=${entry.repo_available}  changed_files=${JSON.stringify(entry.changed_files)}`);
  console.log(`  created_or_written_paths: ${produced.length === 0 ? '(none)' : produced.join(', ')}`);
  if (entry.touched_paths.length > 0) {
    console.log(`  touched_paths (read only, NOT counted as produced): ${entry.touched_paths.join(', ')}`);
  }
  if (entry.verified_artifacts.length > 0) {
    console.log(
      `  verified_artifacts: ${entry.verified_artifacts.map((a) => `${a.path} (via ${a.tool})`).join(', ')}`,
    );
  }
  if (entry.material_actions.length > 0) {
    console.log(
      `  material_actions: ${entry.material_actions.map((a) => `${a.verb} ${a.path}${a.ok ? '' : ' [FAILED]'}`).join('; ')}`,
    );
  }
  console.log('');
}

console.log('-'.repeat(72));
console.log(`turns whose reader saw a produced artifact: ${turnsWithProduced}/${turns.length}`);
console.log(
  `turns that had artifact evidence WHILE git was unavailable: ${turnsWithEvidenceAndNoRepo}`,
);
console.log('');
if (turnsWithEvidenceAndNoRepo > 0) {
  console.log('Those are the turns that previously reached Jev with nothing but an empty');
  console.log('repository and `available: false`. They are the reason for the v3 change, and');
  console.log('their `requirements_satisfied` before/after is the measurement that will say');
  console.log('whether the missing evidence or the question wording was the cause.');
} else if (turnsWithProduced > 0) {
  console.log('Artifacts were found, but on turns where git also answered — so this session does');
  console.log('not exercise the gap. Try a session that wrote a file in a non-repo directory.');
} else {
  console.log('No turn in this session produced an artifact through a structured argument.');
  console.log('That is expected for read/test-only sessions; it is not a failure.');
}
