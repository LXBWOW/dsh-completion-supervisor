/**
 * INSPECT what one assessment was actually about, with everything side by side.
 *
 * WHY THIS EXISTS
 * ---------------
 * When Jev returns a low `ready_to_finish` on a turn whose deterministic evidence looks
 * strong, there are three very different explanations, and they call for three different
 * fixes:
 *
 *   1. MODEL MISTAKE      — the inputs were complete and clear, and the answer is still
 *                           wrong. Nothing to fix offline; this is the drift to measure.
 *   2. QUESTION PROBLEM   — the question presupposes something the task does not contain.
 *                           "Is the implementation complete?" is unanswerable-by-design
 *                           for a task that was never about implementing anything, so a
 *                           low probability is the question failing, not the model.
 *   3. STATE UNDERSOLD    — the evidence exists but was compressed away before sending,
 *                           so Jev judged a thinner state than the turn actually had.
 *
 * They are indistinguishable from the probability alone, which is why the probability
 * alone must never drive a threshold change. This tool prints the four things a human
 * needs to tell them apart, per assessment: the goal Jev was given, the claim, the
 * deterministic evidence, and every probability next to the question's wording.
 *
 * USAGE
 *   node tools/inspect-asked.mjs              # every assessment that has probabilities
 *   node tools/inspect-asked.mjs --last 3     # only the most recent 3
 *   node tools/inspect-asked.mjs --path <file>
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

import { readLog, joinOutcomes } from '../lib/log.js';
import { JEV_QUESTIONS, JEV_QUESTION_NAMES, readProbability } from '../lib/questions.js';

function parseArgs(argv) {
  const args = { path: null, last: null, brief: false, matrix: false };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--path') args.path = argv[index + 1] ?? null;
    else if (argv[index] === '--last') args.last = Number(argv[index + 1] ?? 0) || null;
    else if (argv[index] === '--brief') args.brief = true;
    else if (argv[index] === '--matrix') args.matrix = true;
  }
  return args;
}

function defaultPath() {
  return join(homedir(), '.dsh', 'completion-supervisor', 'assessments.jsonl');
}

function flag(value) {
  if (value === true) return 'true';
  if (value === false) return 'false';
  if (value === null) return 'null';
  if (value === undefined) return '(absent)';
  return String(value);
}

/**
 * Read one probability from a row, tolerating a rename between prompt versions.
 *
 * Thin wrapper over the shared helper, so the rename table lives next to the questions it
 * describes instead of being duplicated in every tool that reads a log.
 *
 * @param {object} row
 * @param {string} name - the CURRENT question name.
 * @returns {number|undefined}
 */
function probability(row, name) {
  return readProbability(row?.jev?.probabilities, name);
}

/**
 * Wrap a long text at a fixed width, indented, so a 600-character claim stays readable
 * and can be quoted verbatim in an analysis without opening the JSONL.
 */
function wrap(text, indent, width = 96) {
  const value = typeof text === 'string' && text.length > 0 ? text : '(none recorded)';
  const words = value.split(' ');
  const lines = [];
  let line = '';
  for (const word of words) {
    if (line.length + word.length + 1 > width) {
      lines.push(line);
      line = word;
    } else {
      line = line.length === 0 ? word : `${line} ${word}`;
    }
  }
  if (line.length > 0) lines.push(line);
  return lines.map((entry) => `${indent}${entry}`).join('\n');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const path = args.path ?? defaultPath();
  if (!existsSync(path)) {
    console.log(`no log at ${path}`);
    return 0;
  }

  const rows = readLog(path);
  let assessments = joinOutcomes(rows).filter((row) => row.jev?.probabilities !== undefined);
  if (args.last !== null) assessments = assessments.slice(-args.last);

  if (assessments.length === 0) {
    console.log('no assessment in this log carries probabilities');
    return 0;
  }

  console.log(`${assessments.length} assessment(s) with probabilities, from ${path}`);

  // A probability matrix, one row per assessment and one column per question.
  //
  // This is the view that answers "is the policy reading the same signal I am?" without
  // opening the JSONL. Reading the seven numbers in a row together is what shows a
  // question going flat, or a whole column pinned low regardless of the task — neither of
  // which is visible in a per-question summary or in a single decision.
  if (args.matrix) {
    const columns = [
      ['req', 'requirements_satisfied'],
      ['impl', 'implementation_complete'],
      // `vsuf` and `vneed` are deliberately distinct labels: one is a POSITIVE question
      // (verification is sufficient) and the other NEGATIVE (more verification is needed), and
      // abbreviating both to "verif" would invite reading the table backwards.
      ['vsuf', 'verification_sufficient'],
      ['blk', 'blocking_issue_remaining'],
      ['evid', 'evidence_matches_claim'],
      ['vneed', 'needs_more_verification'],
      ['ready', 'ready_to_finish'],
    ];
    console.log('');
    console.log(
      'build'.padEnd(14) + 'turn'.padStart(5) + '  ' +
        columns.map(([label]) => label.padStart(6)).join('') + '   rule',
    );
    for (const row of assessments) {
      console.log(
        String(row.build_id ?? '(none)').padEnd(14) +
          String(row.turn).padStart(5) +
          '  ' +
          columns
            .map(([, name]) => {
              const value = probability(row, name);
              return (typeof value === 'number' ? value.toFixed(2) : '—').padStart(6);
            })
            .join('') +
          `   ${flag(row.decision?.rule)}`,
      );
    }
    console.log('');
    console.log('columns: req=requirements_satisfied impl=implementation_complete');
    console.log('         vsuf=verification_sufficient blk=blocking_issue_remaining');
    console.log('         evid=evidence_matches_claim vneed=needs_more_verification ready=ready_to_finish');
    console.log('         (blk and vneed are NEGATIVE: high argues against finishing)');
    console.log('         (rows with prompt_v=1 used the v1 wording: tests_sufficient, not vsuf)');
    return 0;
  }

  // Brief mode answers one question fast: what KIND of task was each assessment about,
  // and how did the policy read it? It exists because the most consequential defect found
  // so far was invisible in every aggregate — the questions presuppose a task that edits
  // a repository, and a sample made entirely of non-editing tasks therefore looks like a
  // badly calibrated model when it is really a badly matched question set.
  if (args.brief) {
    console.log('');
    console.log(
      'turn'.padStart(5) + 'task shape'.padEnd(46) + 'ready'.padStart(7) + 'evid'.padStart(7) +
        'vsuf'.padStart(7) + '  decision',
    );
    for (const row of assessments) {
      const facts = row.facts ?? {};
      const shape = facts.repo_available === false
        ? 'no repository (repo_available=false)'
        : facts.tests_passed === true
          ? 'verified change'
          : 'edits without verification';
      console.log(
        String(row.turn).padStart(5) +
          shape.padEnd(46) +
          (typeof probability(row, 'ready_to_finish') === 'number' ? probability(row, 'ready_to_finish').toFixed(2) : '—').padStart(7) +
          (typeof probability(row, 'evidence_matches_claim') === 'number' ? probability(row, 'evidence_matches_claim').toFixed(2) : '—').padStart(7) +
          (typeof probability(row, 'verification_sufficient') === 'number' ? probability(row, 'verification_sufficient').toFixed(2) : '—').padStart(7) +
          `  ${flag(row.decision?.action)} (${flag(row.decision?.rule)})`,
      );
      const goal = typeof row.asked?.goal === 'string' ? row.asked.goal.replace(/\s+/g, ' ') : '(none)';
      console.log(`      goal: ${goal.slice(0, 130)}`);
    }
    return 0;
  }

  console.log('NOTE: goal and claim are stored bounded at 600 characters, so a truncated');
  console.log('      text here was truncated before the log, not by this tool.');
  console.log('');

  for (const row of assessments) {
    console.log('='.repeat(100));
    console.log(`turn ${row.turn}   at ${row.at}   session ${String(row.session_id).slice(0, 8)}   build ${row.build_id}`);
    console.log(
      `decision: ${flag(row.decision?.action)}  rule ${flag(row.decision?.rule)}  ` +
        `(${row.decision?.reason ?? 'no reason recorded'})`,
    );
    console.log(
      `model: ${flag(row.jev?.model)}   requested: ${flag(row.jev?.model_requested)}   ` +
        `question_set_hash: ${flag(row.question_set_hash)}`,
    );
    console.log('');

    console.log('-- WHAT JEV WAS TOLD THE USER ASKED (asked.goal) ' + '-'.repeat(50));
    console.log(wrap(row.asked?.goal, '   '));
    console.log('');
    console.log('-- WHAT THE AGENT CLAIMED (asked.claim) ' + '-'.repeat(57));
    console.log(wrap(row.asked?.claim, '   '));
    console.log('');

    const facts = row.facts ?? {};
    console.log('-- DETERMINISTIC EVIDENCE (facts) ' + '-'.repeat(61));
    console.log(
      `   repo_available=${flag(facts.repo_available)}  changed_files_n=${flag(facts.changed_files_n)}` +
        `  untracked_n=${flag(facts.untracked_n)}  insertions=${flag(facts.insertions)}  deletions=${flag(facts.deletions)}`,
    );
    console.log(
      `   tests_run=${flag(facts.tests_run)}  tests_passed=${flag(facts.tests_passed)}` +
        `  build_ok=${flag(facts.build_ok)}  lint_ok=${flag(facts.lint_ok)}`,
    );
    console.log(
      `   error_results_n=${flag(facts.error_results_n)}  unverified_claims_n=${flag(facts.unverified_claims_n)}` +
        `  unattributable_exits_n=${flag(facts.unattributable_exits_n)}`,
    );
    console.log(
      `   tool_calls_this_turn=${flag(facts.tool_calls_this_turn)}` +
        `  material=${flag(facts.material_tool_calls)}  message_only=${flag(facts.message_only_tool_calls)}`,
    );
    // The v3 artifact fields. Without them printed, the whole "did missing evidence or the
    // wording cause the low score" question has to be answered by opening the JSONL by hand —
    // which is the step that makes an analysis quietly skip it.
    const produced = Array.isArray(facts.created_or_written_paths) ? facts.created_or_written_paths : [];
    const touched = Array.isArray(facts.touched_paths) ? facts.touched_paths : [];
    const confirmed = Array.isArray(facts.verified_artifacts) ? facts.verified_artifacts : [];
    console.log(
      `   task_v=${flag(row.task_v)}  created_or_written_paths(${produced.length}): ` +
        `${produced.length === 0 ? '(none)' : produced.join(', ')}`,
    );
    if (touched.length > 0) console.log(`   touched_paths(${touched.length}): ${touched.join(', ')}`);
    if (confirmed.length > 0) {
      console.log(
        `   verified_artifacts: ${confirmed.map((entry) => `${entry?.path} via ${entry?.tool}`).join(', ')}`,
      );
    }
    console.log('');
    if (Array.isArray(row.commands) && row.commands.length > 0) {
      console.log('-- RECORDED COMMANDS ' + '-'.repeat(73));
      for (const command of row.commands) {
        // `exit_attributable=false` is the field that explains a null verdict: the run
        // happened, and the code the host reported belonged to a later statement.
        console.log(
          `   [${flag(command.kind)}] exit=${flag(command.exit)} attributable=${flag(command.exit_attributable)}` +
            `  ${String(command.cmd).slice(0, 110)}`,
        );
      }
      console.log('');
    }

    console.log('-- PROBABILITIES, NEXT TO THE QUESTION THAT PRODUCED THEM ' + '-'.repeat(40));
    for (const name of JEV_QUESTION_NAMES) {
      const value = row.jev.probabilities?.[name];
      const shown = typeof value === 'number' ? value.toFixed(3) : '(missing)';
      const instruction = JEV_QUESTIONS[name].instructions.replace(/\s+/g, ' ');
      console.log(`   ${name.padEnd(26)} ${shown.padStart(7)}`);
      console.log(`      Q: ${instruction}`);
    }
    console.log('');

    if (row.ground_truth !== null && row.ground_truth !== undefined) {
      console.log(`-- GROUND TRUTH: ${flag(row.ground_truth.verdict)}  (follow-up kind ${flag(row.ground_truth.followup_kind)})`);
      console.log('');
    }
  }

  return 0;
}

process.exitCode = main();
