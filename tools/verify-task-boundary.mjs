/**
 * Verify the task-boundary fix against the sessions that exercised it.
 *
 * The claim under test: a `user/message` whose source is NOT `kind: 'user'` must
 * not start a new user task. The bug was that `subagent-settled` (and `hindsight`
 * etc.) did exactly that, silently resetting the per-task assessment budget.
 *
 * The evidence needed is BOTH halves, in the same session:
 *   (a) the session really did receive synthetic user-role messages, and
 *   (b) the assessment row for that session still records `#task1`.
 *
 * Either half alone proves nothing: (b) without (a) is a session that never had a
 * chance to show the bug, and (a) without (b) is just an observation about DSH.
 *
 * Usage: node tools/verify-task-boundary.mjs
 */

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/** Decode every concatenated zstd frame in a session log. */
function decodeAll(buffer) {
  const offsets = [];
  let index = buffer.indexOf(ZSTD_MAGIC, 0);
  while (index !== -1) {
    offsets.push(index);
    index = buffer.indexOf(ZSTD_MAGIC, index + 4);
  }
  let text = '';
  for (let i = 0; i < offsets.length; i += 1) {
    try {
      text += zstdDecompressSync(buffer.subarray(offsets[i], offsets[i + 1] ?? buffer.length)).toString('utf8');
    } catch {
      // A frame that fails is skipped; the other frames still carry the answer.
    }
  }
  return text;
}

/** Find a session directory by id prefix under ~/.dsh/sessions. */
function findSession(prefix) {
  const root = join(process.env.USERPROFILE ?? '', '.dsh', 'sessions');
  if (!existsSync(root)) return null;
  for (const group of readdirSync(root)) {
    const groupDir = join(root, group);
    if (!statSync(groupDir).isDirectory()) continue;
    for (const entry of readdirSync(groupDir)) {
      // Main sessions are stored as `session-<uuid>`, subagent sessions as the bare
      // uuid, so a caller passing either form should match.
      const bare = entry.startsWith('session-') ? entry.slice('session-'.length) : entry;
      if (!bare.startsWith(prefix) && !entry.startsWith(prefix)) continue;
      const file = join(groupDir, entry, 'session.v3.jsonl.zstd');
      if (existsSync(file)) return file;
    }
  }
  return null;
}

/** The assessment rows the plugin wrote for one session (matched by id prefix). */
function rowsFor(sessionPrefix) {
  const logPath = join(process.env.USERPROFILE ?? '', '.dsh', 'completion-supervisor', 'assessments.jsonl');
  if (!existsSync(logPath)) return [];
  // Main sessions log a `session-<uuid>` id while subagent sessions log the bare
  // uuid, so accept either form of the prefix.
  const matches = (id) => id.startsWith(sessionPrefix) || id.startsWith(`session-${sessionPrefix}`);
  return readFileSync(logPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter((row) => row !== null && typeof row.session_id === 'string' && matches(row.session_id));
}

/**
 * What each code revision WOULD have counted as a task boundary, per turn.
 *
 * Two models, both computed from the same session events:
 *   NEW (shipped)  counts only `source.kind === 'user'`
 *   OLD (the bug)  counted everything except `plugin` and `tool`
 *
 * Comparing their per-turn INCREMENTS against the recorded `task_key` increments is
 * the decisive test, because an increment is immune to the unknown starting offset:
 * the plugin's counter lives in process memory, so a session that was already at
 * turn 22 when the plugin loaded has lost its earlier counts, and only deltas remain
 * comparable.
 */
function countByTurn(lines) {
  const perTurn = new Map();
  let turn = 0;
  for (const line of lines) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event?.type === 'turn/start') {
      const n = event.data?.turn;
      if (typeof n === 'number') turn = n;
      // The prompt that opens a turn is delivered as a user message just before it.
      continue;
    }
    if (event?.type !== 'user/message') continue;
    const kind = event.data?.source?.kind ?? '(none)';
    let bucket = perTurn.get(turn);
    if (bucket === undefined) {
      bucket = { newCount: 0, oldCount: 0, synthetic: [] };
      perTurn.set(turn, bucket);
    }
    if (kind === 'user') bucket.newCount += 1;
    if (kind !== 'plugin' && kind !== 'tool') {
      bucket.oldCount += 1;
      if (kind !== 'user') bucket.synthetic.push(kind);
    }
  }

  // Cumulative, so a turn's entry is the counter state at the END of that turn.
  let cumulativeNew = 0;
  let cumulativeOld = 0;
  const cumulative = new Map();
  for (const turnNumber of [...perTurn.keys()].sort((a, b) => a - b)) {
    const bucket = perTurn.get(turnNumber);
    cumulativeNew += bucket.newCount;
    cumulativeOld += bucket.oldCount;
    cumulative.set(turnNumber, {
      newCount: cumulativeNew,
      oldCount: cumulativeOld,
      synthetic: bucket.synthetic,
    });
  }
  return cumulative;
}

const targets = process.argv.slice(2);
if (targets.length === 0) {
  console.log('usage: node tools/verify-task-boundary.mjs <session-id-prefix> [...]');
  process.exit(2);
}

let allPassed = true;

for (const prefix of targets) {
  const file = findSession(prefix);
  console.log(`=== session ${prefix} ===`);
  if (file === null) {
    console.log('  no session log found');
    allPassed = false;
    continue;
  }

  const lines = decodeAll(readFileSync(file)).split('\n').filter(Boolean);
  const sources = new Map();
  for (const line of lines) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event?.type !== 'user/message') continue;
    const kind = event.data?.source?.kind ?? '(none)';
    sources.set(kind, (sources.get(kind) ?? 0) + 1);
  }

  const synthetic = [...sources.entries()].filter(([kind]) => kind !== 'user' && kind !== 'plugin' && kind !== 'tool');
  // `plugin` and `tool` were ALREADY excluded by the old code, so only these other
  // kinds can demonstrate the fix. Counting the old exclusions as evidence would
  // make a broken build look correct.
  const syntheticTotal = synthetic.reduce((sum, [, n]) => sum + n, 0);

  console.log('  user-role messages by source:');
  for (const [kind, count] of [...sources.entries()].sort((a, b) => b[1] - a[1])) {
    const marker = kind === 'user' ? 'HUMAN' : synthetic.some(([k]) => k === kind) ? 'SYNTHETIC' : 'old-code-excluded';
    console.log(`    ${String(count).padStart(4)}  ${kind.padEnd(28)} ${marker}`);
  }

  const rows = rowsFor(prefix).filter((r) => r.row === 'assessment').sort((a, b) => a.turn - b.turn);
  const taskKeys = [...new Set(rows.map((r) => r.task_key).filter(Boolean))];
  const builds = [...new Set(rows.map((r) => r.build_id).filter(Boolean))];

  console.log(`  assessment rows: ${rows.length}`);
  console.log(`  task_key(s)    : ${taskKeys.join(', ') || '(none)'}`);
  console.log(`  build(s)       : ${builds.join(', ') || '(none)'}`);
  console.log(`  synthetic user-role messages: ${syntheticTotal}`);

  // ── the decisive per-turn comparison ──────────────────────────────────────
  const cumulative = countByTurn(lines);
  const numbered = rows
    .map((r) => ({
      turn: r.turn,
      recorded: Number.parseInt(String(r.task_key ?? '').split('#task')[1] ?? '', 10),
    }))
    .filter((r) => Number.isFinite(r.recorded));

  if (numbered.length >= 2) {
    console.log('');
    console.log('  per-turn increment: recorded vs what each revision would count');
    console.log('    turn   recorded  NEW-model  OLD-model   synthetic this turn');
    let newMatches = 0;
    let oldMatches = 0;
    for (let i = 1; i < numbered.length; i += 1) {
      const prev = numbered[i - 1];
      const cur = numbered[i];
      const atPrev = cumulative.get(prev.turn);
      const atCur = cumulative.get(cur.turn);
      if (atPrev === undefined || atCur === undefined) continue;
      const recordedDelta = cur.recorded - prev.recorded;
      const newDelta = atCur.newCount - atPrev.newCount;
      const oldDelta = atCur.oldCount - atPrev.oldCount;
      if (newDelta === recordedDelta) newMatches += 1;
      if (oldDelta === recordedDelta) oldMatches += 1;
      console.log(
        `    ${String(cur.turn).padStart(4)}   ${String(recordedDelta).padStart(8)}  ` +
          `${String(newDelta).padStart(9)}  ${String(oldDelta).padStart(9)}   ${atCur.synthetic.length > 0 ? atCur.synthetic.join(',') : '-'}`,
      );
    }
    console.log(`    -> matches: NEW ${newMatches}/${numbered.length - 1}, OLD ${oldMatches}/${numbered.length - 1}`);
    if (newMatches > oldMatches) {
      console.log('  RESULT: PASS — the recorded increments follow the allow-list, not the deny-list');
    } else if (oldMatches > newMatches) {
      console.log('  RESULT: FAIL — the recorded increments still follow the OLD deny-list');
      allPassed = false;
    } else {
      console.log('  RESULT: inconclusive — both models predict the same increments here');
    }
  } else if (syntheticTotal === 0) {
    console.log('  RESULT: inconclusive — this session gives the bug no chance to fire');
  } else if (taskKeys.length === 1 && /#task1$/.test(taskKeys[0])) {
    console.log(
      `  RESULT: PASS — ${syntheticTotal} synthetic message(s) arrived, the old code would have ` +
        `counted ${syntheticTotal + (sources.get('user') ?? 0)} tasks here, and the row records #task1`,
    );
  } else if (taskKeys.length > 1) {
    console.log('  RESULT: FAIL — the task changed within a single-user-message session');
    allPassed = false;
  } else {
    console.log(`  RESULT: CHECK — synthetic messages present; task_key is ${taskKeys[0] ?? '(none)'}`);
  }
  console.log('');
}

process.exit(allPassed ? 0 : 1);
