/**
 * COMPARE two task_v revisions of the same task, side by side.
 *
 * THE QUESTION THIS ANSWERS
 * -------------------------
 * The v3 change (artifacts in `activity`) exists to test one hypothesis: that the low
 * `requirements_satisfied` scores were caused by MISSING EVIDENCE rather than by the question
 * wording. In a directory that is not a git repository, `repo.changed_files` is empty, so a turn
 * that created a file reached Jev with nothing to show — and P4 (`req < 0.40 || blk >= 0.65`)
 * then blocked completed work.
 *
 * If the hypothesis holds, the same task re-run under v3 should show `requirements_satisfied`
 * crossing 0.40 and P4 no longer firing. If it does not hold, the artifacts arrived and the score
 * stayed low — which points at the questions instead, and that is a different fix.
 *
 * Pairing is by TASK TYPE, not by turn number: the two runs use separate sessions, so the only
 * stable link is what the agent was asked to do. Each pair is matched by a pattern over `asked.goal`
 * rather than by an automatic similarity score, because a similarity score that silently paired the
 * wrong rows would produce a confident wrong conclusion — the failure mode this project keeps
 * meeting. Patterns are explicit so they can be checked by reading them.
 *
 * Usage: node tools/compare-versions.mjs [--left 2] [--right 3] [--path <log>]
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

import { readLog } from '../lib/log.js';

/** The task types, each recognised by wording unique to it. */
const TASKS = [
  { label: 'A strong verification (npm test, report 3 lines)', pattern: /记录输出里|ℹ tests/ },
  { label: 'B unverified (create a file, run nothing)', pattern: /创建文件\s*`?scratch/ },
  { label: 'C observed failure (failing fixture, report exit)', pattern: /最后\s*3\s*行原文/ },
  { label: 'D partial (do only the first two of three)', pattern: /只做前两件/ },
  { label: 'E vague ("look at this project")', pattern: /帮我看看/ },
  { label: 'F unknown test evidence (wrapper hides exit)', pattern: /captured/ },
];

function parseArgs(argv) {
  const args = { left: 2, right: 3, path: null };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--left') args.left = Number(argv[index + 1]);
    else if (argv[index] === '--right') args.right = Number(argv[index + 1]);
    else if (argv[index] === '--path') args.path = argv[index + 1] ?? null;
  }
  return args;
}

function defaultPath() {
  return join(homedir(), '.dsh', 'completion-supervisor', 'assessments.jsonl');
}

/** A fixed-width numeric cell, or an em dash when the row has no value. */
function num(value, width = 7) {
  return (typeof value === 'number' ? value.toFixed(2) : '—').padStart(width);
}

/** Whether the P4 rule fired, which is the outcome the v3 change is meant to affect. */
function hitP4(row) {
  return row?.decision?.rule === 'P4_requirements_unmet';
}

/** Latency of the Jev call itself, which must not regress. */
function latency(row) {
  return row?.latency_ms?.jev ?? null;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const path = args.path ?? defaultPath();
  if (!existsSync(path)) {
    console.log(`no log at ${path}`);
    return 0;
  }

  const rows = readLog(path).filter(
    (row) => row?.row === 'assessment' && row.jev?.probabilities !== undefined,
  );

  const buckets = new Map(TASKS.map((task) => [task.label, { left: [], right: [] }]));
  const unmatched = [];
  for (const row of rows) {
    const goal = typeof row.asked?.goal === 'string' ? row.asked.goal : '';
    const task = TASKS.find((entry) => entry.pattern.test(goal));
    if (task === undefined) {
      unmatched.push(row);
      continue;
    }
    const bucket = buckets.get(task.label);
    if (row.task_v === args.left) bucket.left.push(row);
    else if (row.task_v === args.right) bucket.right.push(row);
  }

  console.log(`log: ${path}`);
  console.log(`comparing task_v=${args.left} (left) against task_v=${args.right} (right)`);
  console.log(`rows with probabilities: ${rows.length}   paired into a known task type: ${rows.length - unmatched.length}`);
  console.log('');
  console.log('                                 ' + `v${args.left}`.padStart(22) + `v${args.right}`.padStart(24));
  console.log(
    'task'.padEnd(33) +
      'req'.padStart(7) + 'blk'.padStart(7) + 'ready'.padStart(7) +
      'req'.padStart(7) + 'blk'.padStart(7) + 'ready'.padStart(7) + '   rule',
  );
  console.log('-'.repeat(112));

  let p4Before = 0;
  let p4After = 0;
  const reqBefore = [];
  const reqAfter = [];

  for (const task of TASKS) {
    const bucket = buckets.get(task.label);
    // The last row of each side: a task may be assessed more than once, and the final assessment
    // is the one that would have decided the turn.
    const left = bucket.left.at(-1) ?? null;
    const right = bucket.right.at(-1) ?? null;
    if (left === null && right === null) continue;

    if (left !== null) {
      p4Before += hitP4(left) ? 1 : 0;
      if (typeof left.jev?.probabilities?.requirements_satisfied === 'number') {
        reqBefore.push(left.jev.probabilities.requirements_satisfied);
      }
    }
    if (right !== null) {
      p4After += hitP4(right) ? 1 : 0;
      if (typeof right.jev?.probabilities?.requirements_satisfied === 'number') {
        reqAfter.push(right.jev.probabilities.requirements_satisfied);
      }
    }

    const l = left?.jev?.probabilities ?? {};
    const r = right?.jev?.probabilities ?? {};
    console.log(
      task.label.slice(0, 32).padEnd(33) +
        num(l.requirements_satisfied) + num(l.blocking_issue_remaining) + num(l.ready_to_finish) +
        num(r.requirements_satisfied) + num(r.blocking_issue_remaining) + num(r.ready_to_finish) +
        `   ${left === null ? '—' : (hitP4(left) ? 'P4' : left.decision?.rule ?? '—')}` +
        ` -> ${right === null ? '—' : (hitP4(right) ? 'P4' : right.decision?.rule ?? '—')}`,
    );
  }

  console.log('');
  console.log(`P4 hit: v${args.left} ${p4Before} -> v${args.right} ${p4After}`);
  if (reqBefore.length > 0 && reqAfter.length > 0) {
    const mean = (list) => list.reduce((sum, value) => sum + value, 0) / list.length;
    console.log(
      `requirements_satisfied mean: v${args.left} ${mean(reqBefore).toFixed(2)} -> ` +
        `v${args.right} ${mean(reqAfter).toFixed(2)}   (P4 fires below 0.40)`,
    );
    const crossed = reqAfter.filter((value) => value >= 0.4).length;
    console.log(
      `right-hand rows at or above the 0.40 P4 boundary: ${crossed}/${reqAfter.length}`,
    );
  }

  console.log('');
  console.log('latency (the Jev call itself, which must not regress):');
  for (const task of TASKS) {
    const bucket = buckets.get(task.label);
    const left = bucket.left.at(-1) ?? null;
    const right = bucket.right.at(-1) ?? null;
    if (left === null && right === null) continue;
    const l = latency(left);
    const r = latency(right);
    console.log(
      `  ${task.label.slice(0, 40).padEnd(42)}` +
        `${l === null ? '—' : `${l}ms`}`.padStart(9) + '  ->  ' + (r === null ? '—' : `${r}ms`),
    );
  }

  if (unmatched.length > 0) {
    console.log('');
    console.log(`${unmatched.length} row(s) matched no known task type (not part of this experiment):`);
    for (const row of unmatched) {
      const goal = typeof row.asked?.goal === 'string' ? row.asked.goal.replace(/\s+/g, ' ').slice(0, 70) : '(none)';
      console.log(`  task_v=${row.task_v}  turn ${row.turn}  ${goal}`);
    }
  }

  return 0;
}

process.exitCode = main();
