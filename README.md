# dsh-completion-supervisor

Checks whether an agent's "done" is actually true, using Jev as a fast typed classifier rather than an LLM.

**Status: deterministic enforcement + Jev observation (`policy_v 3`).** Three rules may steer a turn,
and each compares against a fact the plugin computed for itself — an unresolved tool error, an
unsupported verification claim, a recorded test run that did not pass. Everything derived from Jev's
probabilities is recorded and decides nothing. At most one steer per user task.

Jev is still called on every assessable turn, and its seven probabilities, latency, model and
`ground_truth` are still written to the log: that record is the only thing that could justify bringing
a probability back into a decision. [What Jev does and does not do](#what-jev-does-and-does-not-do)
states the boundaries plainly, because the gap between what it sounds like it does and what it
actually returns is the largest source of wrong expectations about this plugin.

---

## The problem

A coding agent says it is finished. Sometimes it is. Sometimes:

- it says "tests pass" and never ran a test
- it created a file and never tracked it
- a summary describes an outcome the recorded commands contradict
- a build failed and the failure was summarised away

The user finds out later, or not at all.

## The approach

At the one moment a turn is about to close, gather deterministic evidence, compress it, ask Jev
seven narrow yes/no questions in **one** request, and run a pure policy over the answers. Since
`policy_v 3` the policy uses those answers to LABEL the turn, and uses only the deterministic evidence
to act on it.

```
agent/turn-stopping
      |
      v
TaskState  (deterministic facts gathered in code)
      |
      v
one Jev request  (7 x noul)
      |
      v
decide()  (pure function)
      |
      v
shadow log   (row 1: the assessment)
      |
      v
outcome row  (row 2: what the user actually did next)
```

## Why Jev, and why batched

Jev (TypeSafe System One) is **not an LLM**. It takes a state plus typed questions and returns
probabilities. That makes it the right tool for narrow, repeated verification: it is fast (measured
566–850 ms), cheap (~$0.000022 per call), and it answers seven questions in one request.

An earlier design — a Jev gate on **every tool call** — was abandoned. It fired once per tool call,
so latency and quota grew linearly with the tool-call count, while buying only an extra safety layer
rather than better completions. This plugin fires once per **completion claim** instead: **1–3 calls
per user task** instead of dozens.

## What Jev does and does not do

Five statements, each verifiable against this repository and the decision log rather than against a
vendor description. They are here because the gap between what Jev sounds like it does and what it
actually returns is the largest source of wrong expectations about this plugin — including several that
were written into earlier drafts of this file.

1. **It does not read the conversation history.** The request body is one `state` object assembled from
   the current turn: `goal`, `claim`, `repo`, `commands`, `evidence`, `activity`, and an optional
   `prior`. There is no transcript field, and `prior` is dropped during fitting when the state
   overflows. Measured `input_tokens`: median 2496, max 6407 — a state fits, a history does not.
2. **It does not output natural language.** `output_tokens` was exactly 136 on all 68 logged calls and
   the body is `{probabilities, request_id, usage}`. There is no text channel, so a sentence attributed
   to Jev — "it says", "it points out", "it thinks" — cannot have come from it. The interpretation is
   always the policy layer's.
3. **It returns seven probabilities**, one per typed question, each in `[0,1]`:
   `requirements_satisfied`, `implementation_complete`, `verification_sufficient`,
   `blocking_issue_remaining`, `evidence_matches_claim`, `needs_more_verification`, `ready_to_finish`.
   Nothing else in the response is used, and no decision of ours is derived from anything else it could
   return.
4. **There is no confirmed `good_block` sample.** The verdict path exists in the logger and no row has
   ever taken it. Of the 11 turns where a probability-driven `P4` fired, none was confirmed necessary on
   review; the one steer that reached a user is logged as a `false_block`.
5. **Repeated sampling of one state spreads 0.04–0.11.** `tools/probe-determinism.mjs` sent the same
   state 5, 8 and 6 times: the spread reached 0.110 against threshold gaps of 0.05–0.30, i.e. the noise
   is the size of the decision being asked for. `needs_more_verification` stayed inside `[0.64, 0.87]`
   across all 68 calls (median 0.78) — a standing lean toward "not done" that `lib/questions.js`
   attributes to a correct answer to the wrong question.

Two things follow, and both are load-bearing for how this plugin is built. It cannot tell you *what* is
missing — a probability has no field to carry an item, so any specific demand in a steer message is the
policy's, not Jev's. And it has no memory of what it said before: the only de-duplication is one row of
state (`already_intervened_this_turn`, and a fingerprint of the turn's material facts).

## The division of labour

The core rule:

| Kind of question | Who answers it |
|---|---|
| Is the test command's exit code 0? | code |
| Which files changed, and were any left untracked? | code |
| Did the agent claim tests that never ran? | code |
| Does this evidence actually satisfy the user's request? | **Jev** — recorded since `policy_v 3`, never acted on |
| Does this need a human? | a human |

Jev is never asked something code can compute. The highest-value check in the plugin is
`unverified_claims`: the agent says "all tests pass" and no test command appears in the recorded
commands. Code detects that contradiction with certainty and for free.

## Fail-open, always

Every failure ends the same way: **log it, do not steer, let DSH end the turn natively.**

| Failure | Behaviour |
|---|---|
| No `TYPESAFE_API_KEY` | skip Jev; deterministic checks still run |
| Key file missing or unreadable | same as no key — never a throw on the turn-close path |
| Jev timeout | log, do not steer |
| Jev HTTP error | log, do not steer; the key is redacted out of the echoed body |
| Malformed / incomplete response | log, do not steer |
| State over the token budget | skip Jev, do not send a truncated state |
| `git` unavailable | facts become empty, assessment continues |
| Anything thrown | caught at the outermost guard; turn ends normally |

An incomplete answer set is **rejected**, never defaulted. A fabricated `0.0` would read as
"confidently not done" and could block a turn that was fine.

Jev is never a single point of failure.

## Why the thresholds are asymmetric

```
false block  ->  interrupt a working agent, burn a turn, show a user an unexpected message
false pass   ->  the user notices, exactly as if this plugin were not installed
```

A false pass is cheaper. So the bar to **finish** is high (0.70–0.75) while the bar to **block** is low
(0.40–0.65), leaving a wide middle band that defaults to passing.

**That ordering no longer decides anything, and how it used to is worth stating because it explains the
whole shape of the log.** Under `policy_v 1` and `v2`, `P4` fired on
`requirements_satisfied < 0.40 OR blocking_issue_remaining >= 0.65` — before `P8`, the only `finish`
path, was ever reached. So whenever one of those two held, `readyToFinishAtOrAbove` was never consulted
at all, and a `finish` boundary described as "high" was a number nothing read.

Measured, not reasoned: `node tools/analyse.mjs --replay` sweeps threshold sets over the logged
probabilities. On the first 13 assessments that carry probabilities, moving the finish threshold from
0.70 to 0.90 changed the outcome of **zero** rows — `requirements_satisfied` had a median of 0.26 and
a maximum of 0.48, and `blocking_issue_remaining` a median of 0.74. P4 had already returned.

Two things follow, and both outlived the rule they were written about:

1. **Moving a boundary could not fix a block-first failure.** When the sweeps show no change, the cause
   is upstream of the number being tuned — and reading that honestly is what made the probabilities
   themselves the suspect rather than their thresholds.
2. **`P9_default_pass` is what actually passes a turn.** Any turn that trips no rule passes,
   with no probability needing to clear anything. "Pass requires 0.70" was always the wrong reading of
   this table; under `policy_v 3` it is the only reading there is, because every path that consults a
   probability returns `finish`.

So when most rows block, the question is not "which threshold" but "is the state complete enough to
judge, and is the question about something that exists". Both were wrong in the first round — the
missing file evidence in a non-repository workspace, and the reasoning-block claim described in the
measured-contracts section below.

This is the opposite of [Foreman](https://github.com/thruwire/foreman)'s stance, on purpose. Foreman
is an unattended factory scheduler: when its assessment fails it must stop and page a human, because
continuing blind could corrupt a repository. This plugin is an assistant enhancement: when its
judgement fails, the correct outcome is that DSH behaves exactly as it would without it.

## Jev is NOT deterministic — and that decides what a threshold can mean

Measured with `node tools/probe-determinism.mjs`, which sends **one identical state** repeatedly
and reports the spread. The same fixed state was probed under both prompt versions, so the two
columns also show what the v2 rewording did:

| question | v1 (`prompt_v=1`, 8 repeats) | v2 (`prompt_v=2`, 6 repeats) |
|---|---|---|
| `requirements_satisfied` | 0.400–0.450 | **0.480–0.520** |
| `implementation_complete` | 0.650–0.700 | 0.630–0.690 |
| `tests_sufficient` → `verification_sufficient` | 0.420–0.470 | **0.540–0.600** |
| `blocking_issue_remaining` | 0.260–0.370 | 0.340–0.380 |
| `evidence_matches_claim` | 0.430–0.480 | **0.230–0.260** |
| `needs_more_verification` | 0.670–0.700 | 0.700–0.730 |
| `ready_to_finish` | 0.500–0.540 | 0.530–0.570 |

Every question varies; none is a constant. The same state can come back as `0.48` or `0.52`.

Two of those shifts were the goal of the rewrite, and one was not:

- **`requirements_satisfied` crossed the P4 boundary** (0.40). The same state that used to be
  blocked on `req < 0.40` now sits above it, because the question no longer asks about a
  repository.
- **The verification question rose ~0.12**, because a task is no longer penalised for having no
  tests.
- **`evidence_matches_claim` fell ~0.20, and this was not intended.** The v2 wording says to compare
  the claim against "those recorded items only", which is stricter than v1's phrasing: the probe's
  claim mentions concrete counts that the state does not record, so the honest answer became "not
  supported". P6 (`evidence_matches_claim < 0.50`) therefore fires on that state where P4 used to.
  Under `policy_v 2` the net effect was that the state was still blocked, by a different rule — which is
  the finding that ended the tuning. Under `policy_v 3` both `P4` and `P6` are advisory, so the state is
  recorded twice over and acted on by neither.

Whether that strictness is a defect or the correct reading depends on real tasks, which is what the
8-task round is for. The signal to watch is a **false block on an obviously complete task**.

Three consequences of the noise itself, none of them optional:

1. **A threshold placed where real values land is deciding partly on noise.**
   `requirementsUnsatisfiedBelow` is 0.40 and real measurements sit at 0.26-0.54.
   `blockingIssueAtOrAbove` is 0.65. Both are within a spread of the values they judge.
2. **A before/after difference smaller than the spread is not evidence.** Not hypothetical: the
   v2/v3 artifact comparison first looked like four tasks improving (0.06-0.10 on
   `requirements_satisfied`). Only one — the file-creating task, at **+0.27** — survived that test.
3. **Thresholds must be quoted with a tolerance and chosen away from the data's centre**, not fitted
   to a single observation.

The repeat count is part of the claim, not a detail: 5 repeats bounded the spread at 0.06 and looked
reassuring, while 8 repeats found 0.11. **Treat any figure here as a lower bound.**

Those three consequences were written as cautions about tuning. `policy_v 3` is what happens when they
are taken as conclusions instead: if a boundary cannot be placed without landing inside the noise, and no
threshold move fixes a block-first failure, then the honest move is to stop spending interruptions on
that signal. That is why this release is a contraction and not another re-tuning.

### What this does to the artifact result

The file-creating task moved `ready_to_finish` from 0.38 to **0.72** — against a `P8_finish` bar of
0.75. That is a gap of 0.03, and the measured spread for that question is 0.04, so whether that turn
finishes is decided by sampling rather than by the evidence. The artifact fix is real and large
enough to measure; it is not yet large enough to make the outcome stable.

Under `policy_v 3` that instability costs nothing: `P8_finish` and `P9_default_pass` both permit the turn,
so sampling now decides only which name the row is logged under. That is exactly the kind of finding the
contraction is meant to convert from a risk into a label.

That measurement was taken under `prompt_v=1`, and the wording has since changed — see the
determinism table below, where the same state scores differently under each version. Numbers from
the two versions are not interchangeable, and the `question_set_hash` on each row is what tells them
apart.

## Cost controls

Three mechanisms keep the call count at 1–3 per task:

1. **`maxAssessments: 3`** — a hard ceiling per user task. A new user message resets the budget.
2. **Assessment fingerprint** — if the material facts are unchanged since the last assessment, the
   Jev call is skipped. A steered turn that stops again with identical evidence is the same
   situation; Jev would return the same answer.
3. **Skip non-coding turns** — a turn with no tool call has nothing to verify. This is the single
   largest source of saved calls, since most turns in a session are conversation.

There is deliberately **no time-based cooldown**. It is arbitrary (why 20 seconds?), and it can both
suppress a genuine re-assessment and permit a pointless one depending only on wall-clock luck. The
fingerprint decides causally instead.

## Layout

```
lib/
  index.js       plugin entry: hooks, throttle rules, fail-open guards
  jev.js         hand-written System One client; strict validation (no SDK, no deps)
  questions.js   the 7 noul questions, versioned by PROMPT_VERSION
  taskstate.js   evidence derivation + staged compression
  fingerprint.js material-facts hash (what counts as "changed")
  policy.js      decide(): PURE, replayable, all thresholds in one table
  log.js         JSONL rows (assessment / skip / outcome) + ground-truth backfill
  health.js      READ-ONLY summary of the log; writes nothing, calls no model
  state.js       in-process per-session state
  git.js         read-only git evidence via ctx.shell
  tokens.js      calibrated token estimator (no tokenizer)
  build.js       BUILD_ID: hash of the shipped sources, so a row is attributable
tools/
  analyse.mjs    offline: summary + threshold replay over the shadow log
  build-id.mjs   recompute/verify BUILD_ID
  fix-mojibake.mjs  detect text a PowerShell round-trip damaged
  decode-session.mjs  read a real session log (concatenated zstd frames)
  set-key.mjs    place the API key with hidden input; never echoes it
  verify-task-boundary.mjs  prove the allow-list against a live session's sources
  verify-*.mjs   the contract probes, kept as reproducible evidence
test/
  pure.test.mjs          the pure modules
  integration.test.mjs   the plugin against a fake DSH context
  real-fixtures.test.mjs regressions locked to captured live data
  fixtures/real-rows.json  the captured data (nothing here is hand-written)
```

Everything in `lib/` except `index.js` and `git.js` is **pure or boundary-injected**, so it is
testable without DSH, without a network, and without disk.

## Install

The bundle patch is already wired as a profile bundle. Add the dependency and the bundle entry to
`~/.dsh/profiles/desktop/package.json`:

```json
{
  "dependencies": {
    "dsh-completion-supervisor": "link:C:/Users/lxb-tuf/Desktop/git cloud/dsh-completion-supervisor"
  },
  "dsh": {
    "profile": {
      "bundles": ["...", "dsh-completion-supervisor"]
    }
  }
}
```

Then put the key in place and **restart DSH** (Desktop has no HMR — `patchReload: "live"` does not
apply there):

```
npm run set-key          # prompts with hidden input, writes the file
npm run key-status       # says whether a key is in place; never prints it
```

`set-key` writes to:

```
~/.dsh/completion-supervisor/.env
TYPESAFE_API_KEY=<key>
```

Use the script rather than pasting the key somewhere convenient. The three ways a secret gets
disclosed, in order of how often they happen: it is echoed into a chat transcript that is persisted
and summarised; it is captured by shell history or the Windows registry through `setx`; or it is
committed. The prompt writes nothing back to the terminal, refuses a non-TTY stdin outright (a piped
key is already in a file or a command line elsewhere), and keeps the value out of the process
argument list.

That file is read by the plugin itself, from inside the DSH home — outside every repository, next to
the decision log. It cannot be committed by accident, and `git status` in a project can never show
it. The environment variable `TYPESAFE_API_KEY` also works and takes precedence; a bare key, a
`KEY=value` line, and surrounding quotes are all tolerated.

**Why the plugin reads the file instead of relying on the harness to do it.** `dsh-app-boot` exports a
`loadEnv()` that calls `process.loadEnvFile('.env')`, and its doc comment promises exactly the
behaviour this README used to imply. In the shipped Desktop build that function is **defined and
never called** — a recursive search of the whole app tree finds three references, all on its own
definition and export lines. So a `.env` the user creates is silently ignored, and the only symptom
is `present: false`, which reads like a bad key rather than an unread file. Reading it in the plugin
makes the instruction true under any launcher.

The key is never printed, never written to a log row, and never committed. Two independent guards
enforce the logging half: the JSONL writer redacts the key from every serialized row, and every
logger line is scrubbed before it is emitted. Both exist because the realistic leak is not a
deliberate `log(key)` — it is an upstream error string that quotes the header it rejected, and there
are two sinks for it.

## Verify it is running

Ask the agent to call `completion_supervisor_status`. It reports mode, key presence, **which source
answered**, thresholds, version stamps, `BUILD_ID`, tracked sessions, and the failure counters.

The status tool re-reads the key live rather than only reporting the value frozen at plugin load. If
you have just placed a key, the line says so and tells you a restart is needed — instead of leaving
you to interpret an unexplained `present: false`. It reports the source (environment, or the file
path), never the value.

`BUILD_ID` is the field to read first after a restart. If it does not match
`node tools/build-id.mjs --check` in the source tree, the running plugin is older than the code, and
every row written since the restart came from that older build. This is not a theoretical concern:
during the first install a restart picked up a fixed writer while a reader fix was still pending, and
the resulting rows looked self-contradictory — `repo_available` listed in `changed_fields` but absent
from `facts` — with nothing in the row to explain it.

Environment variables are read once at plugin load, so `TYPESAFE_API_KEY` also needs a restart to be
picked up.

## Health at a glance

`completion_supervisor_health` (an agent tool) and `/supervisor` (a slash command) answer "has it
been working recently?" from the decision log alone, without reading rows by hand. One optional
argument, `limit` (default 50, clamped to 1..500):

```
/supervisor                    # at the prompt — no model, no tokens
/supervisor 100

completion_supervisor_health           # the same report as a tool, for the agent to call
completion_supervisor_health limit=100
```

The slash command exists because "show me the verdict" is a question a person asks the UI, not a
request for a model to interpret: it runs in the command runtime, never enters a turn, and cannot be
paraphrased on the way to the reader. The tool stays for the case where the agent needs the numbers
while investigating something. **Both render the same bytes** — one report builder, and a test
asserts the two outputs are identical, because two surfaces for two readers is fine and two sources
of truth is not.

It is named `/supervisor` rather than `/health` on purpose: this is a third-party plugin in a shared
command namespace, and the generic word would collide with the first unrelated thing to want it.
`/supervisor` also leaves room for subcommands later.

```
Completion Supervisor Health

Mode: INTERVENTION
Build: c3cf56013b16
Policy: v2
Task state: v4
Jev model: jev-1.13.0

Last 50 assessments
-------------------
Assessments:          50
Tasks:                34
Window:               2026-09-20T06:03:18Z .. 2026-09-20T17:37:35Z
Mixed in window:      policy_v 1,2 | task_v 1,2,3,4 | log_v 1,2 | mode shadow 48 / intervention 2
Jev successes:        48
Jev failures:         2  (no_key 1, timeout 1; fail-open, the turn ended unsupervised)
Actual steers:        1
Steer suppressed:     42  (shadow_mode 42)
Gray-zone cases:      1
Advisory P6 hits:     1

Jev latency:          48 samples | avg 986 ms | p50 1041 ms | p95 1584 ms | max 1901 ms

Steers by reason:
  P4_requirements_unmet (requirements)    1

Most recent steer:
  time:  2026-09-20T17:31:00.016Z
  task:  57cbd8f4#task1
  rule:  P4_requirements_unmet
  req:   0.28   blk: 0.31   gray_zone: false
  goal:  "已重启"

Health: CHECK
- recent_steer_needs_review: true — 1 steer(s) in the last 50 assessments; whether a given one was
  CORRECT depends on the task's meaning, which this command cannot judge
```

That window was taken while `policy_v 2` was live and it spans both policy versions, which is why
`Steers by reason` names `P4`. A window recorded entirely under `policy_v 3` cannot produce a line like
it: the only rules that steer are `P1`/`P2`/`P3`.

One thing to know before reading a v3 window. `Advisory P6 hits` is a single-rule label that predates the
contraction, and the report object already carries the full breakdown as `steer.advisoryHits`
(`P4`, `P5`, `P6`, `P7`). For a v3 window the number that matters most is `P4_requirements_unmet`, because
it counts the turns this plugin WOULD have interrupted under `policy_v 2`. `Gray-zone cases` is the wider
count — turns the observation band flagged and nothing acted on.

### It is a reader, and only a reader

It opens the JSONL for reading. It writes no rows, calls no model, touches no supervisor state, and
cannot change a decision. A missing, empty, unreadable, or partly malformed log produces a report
rather than an exception.

This is deliberately a separate tool from `completion_supervisor_status`, which describes the running
PROCESS from values it holds in memory. The two read from different places — status can work on a
machine that has never assessed anything, health works in a process that remembers no turn — and
folding them into one output would produce numbers from two sources with nothing saying which is
which.

### It will never say "false positive"

The question a reader wants answered first — was that steer wrong? — needs the meaning of the task,
which lives in the conversation and not in the log. So the report carries
`recent_steer_needs_review: true` and never `false_positive`. A deterministic counter that claimed to
know would be believed, and being believed is exactly what makes it worse than no counter at all.

### What the numbers mean

- **`Jev failures`** — assessments that got no answer from Jev. Every one is fail-open, so those turns
  ended unsupervised. The parenthetical splits them by `jev_error.kind`: `no_key` is a configuration
  fault and `timeout` is an outage, and the two call for different actions.
- **`Steer suppressed`** — the policy wanted to act and a run-time limit stopped it (`shadow_mode`,
  `per_task_steer_budget`). Distinct from `Actual steers`, which is what happened.
- **`Mixed in window`** — printed only when the window spans a change, and it is the honesty line.
  `would_steer`, `gray_zone` and `advisory_rule` were added in `log_v 2`, so on older rows the report
  re-derives "wanted to act" from `action` + `enforce` — fields those rows do carry — instead of
  reporting a flattering zero. `gray_zone` and `advisory_rule` genuinely have no value on those rows,
  and `task_v 1-2` rows reached Jev without the artifact and command-output evidence later rows carry.
- **`Jev latency`** — successful calls only. A timeout would contribute its full timeout value, which
  measures the timeout setting rather than the service.

### The verdict

`Health: OK` or `Health: CHECK`, produced by comparisons over fields that are literally in the rows.
`CHECK` fires on any of: a running `BUILD_ID` differing from the newest logged row; a mode change
since that row; two or more Jev failures within the last 20 assessments; five consecutive trailing
failures; a steer (raising `recent_steer_needs_review`); one task steered twice; a steer past
`maxSteersPerTask`; an unparsable line; `no_key` within the last 20 rows; more than one Jev model
answering in the window; a missing log. Each line names the field it came from.

The `no_key` and failure checks look at the recent tail rather than the whole window on purpose: a
row written before the key was installed is history, and a check that keeps firing until it scrolls
out is how a reader learns to ignore it. A key that is missing right now fails every new row, so the
tail catches that too.

One case is deliberately **not** a check, and it is the one a reader hits first. A build id differing
from the newest logged row is a `note:` while that row was written BEFORE THIS PROCESS STARTED — the
ordinary state after a restart, before the first turn is assessed — and a check only when the row was
written after we started, which means something else is appending to this log.

The obvious-looking separator, the build's own timestamp, is **wrong**, and this is recorded because
it was tried: an old process keeps writing rows after a new build lands, because nothing restarts it
when sources change. The first version of this check compared the newest row against `BUILD_AT` and
raised a stale-code alarm on the very first live run — on a row written 58 seconds after the build and
40 seconds before the new process started. The process's own start time is sound for a reason that
does not depend on timing luck: every row this process writes carries its build id, so a row older
than the process cannot be ours. Getting this wrong means the alarm fires on every restart, which is
how a working alarm becomes an ignored one.

## Rollout and the intervention boundary

Three shadow rounds ran first. The gate to turning intervention on was an offline **replay**, not a
sample count — see "What was verified" below.

### The two bands, and what they still decide

**The thresholds that decide what gets LOGGED are not the thresholds that decide what gets DONE.** As of
`policy_v 3` neither of them decides anything that gets done — both are recording — and they are still
kept apart because they answer two different questions.

| band | requirements | blocking | what it does |
|---|---|---|---|
| observation | `< 0.40` | `>= 0.65` | recorded on the row as `shadow_rule`. Keeps a new row comparable with every shadow-round row already on disk. |
| intervention | `< 0.30` | `>= 0.75` | recorded on the row as `advisory_rule: P4_requirements_unmet`. Steers nothing. |

So `advisory_rule: P4_requirements_unmet` means exactly *"this turn would have been interrupted before
`policy_v 3`"*. That makes the field the count of steers the contraction removed, which is the number to
watch if anyone wants to argue for bringing them back.

`advisory_rule` is measured against the intervention band rather than the observation one on purpose:
`requirements_satisfied` has a median of 0.27 across the logged rows, so a 0.40 test would fire on
roughly half of all turns and hide `P5`/`P6`/`P7` behind it — the opposite of what keeping advisories is
for.

`P4`, `P5`, `P6` and `P7` are **advisory**: evaluated, recorded, unable to steer. `P1`, `P2` and `P3`
steer directly, because they compare against code-computed facts rather than against a probability.
Nothing else may act.

`gray_zone: true` means the observation band flagged the turn and nothing acted on it. Under `policy_v 3`
that is what happens on *every* turn it flags, so the field is now the full count of turns the plugin
chose to leave alone rather than a narrow middle between two bands.

### Why the probabilities were retired rather than re-tuned

Four measurements, all of them recoverable from the log:

- **No confirmed `good_block`, ever.** 141 rows, 97 assessments, 68 Jev calls — the verdict path exists
  and no row has taken it.
- **Eleven probability-driven `P4` firings, none confirmed necessary** on review.
- **The one steer that reached a user is logged as a `false_block`** (`applied=true`, 09-20T17:36). The
  user's own note calls the premise defensible and the experience of being steered undesirable — which
  is the asymmetry this plugin has always stated: a wrong steer costs more than a missed one.
- **The signal moves as much as its own decision gap.** Same state, repeated: spread 0.04–0.11
  (`tools/probe-determinism.mjs`). `needs_more_verification` never fell below 0.64 in 68 calls.

A signal with no measured true positive, noise the size of its threshold gap, and a failure mode that
interrupts someone else's work should not be spending real interruptions. Deleting it would also delete
the evidence, so the numbers are still collected on every turn.

**This is an end state, not a step.** The plugin is in `deterministic enforcement + Jev observation` mode
and is no longer being calibrated: the question set, every threshold value and the scoring scale are
frozen, and no further tuning is planned. Anyone wanting to move a probability back into a decision should
argue from the `advisory_rule` counts on rows written from here on — not from another threshold sweep, which
is the exercise this release concludes.

### Why P6 stopped blocking

It fired **four times on the 12 labelled samples and every one was a false block** — a completed turn
interrupted — while it never once fired on a task that was genuinely unfinished. Each firing was a
claim quoting text a command had printed while the state carried none of it, which `task_v 4` fixed for
two of the three; the third created its file with `pwsh`, whose products this plugin deliberately does
not guess at. So the rule was reading a real gap in the evidence and reporting it as a problem with the
agent. It is kept, computed and logged, because a claim that outruns its evidence is exactly what this
plugin exists to notice — it just does not get to interrupt anyone on the strength of it.

Silencing P6 alone would **not** have been enough: on the v4 N2 row, `P7_needs_verification` fires and
produces the identical false block under a different name.

### What the replay says now

`node tools/score-round.mjs` replays all 12 labelled rows through the live policy. Because `decide()`
is pure and a row records every field it reads (`facts`, plus the seven probabilities), this needs no
Jev call and no new sampling. Under `policy_v 3`:

```
steered a task that was COMPLETE     0/8   <- the number that must be 0
steered a task that was INCOMPLETE   2/4
missed an incomplete task            2/4   <- the price of the contraction, stated rather than hidden
advisory rules that fired            P6_evidence_mismatch ×4, P4_requirements_unmet ×2
```

**Read the third line, not just the first.** Two of the four incomplete rows are no longer caught. Both
are `N4`, "download a URL that does not exist" — the same task under `task_v 3` and `task_v 4` — and the
control row is the one whose `blocking_issue_remaining` sits at 0.77 against the 0.75 boundary (see
[Stop-loss](#stop-loss)). The two that are still caught are caught by deterministic rules,
`P1_unresolved_errors` and `P3_failing_tests`, which is the shape of the split: the surviving rules
compare against facts and do not depend on a probability crossing anything.

Losing those rows is a judgement about which error is worse rather than a measurement, and the position
is the one in the header of `lib/policy.js` — interrupting a working agent costs strictly more than
letting a turn end the way it would have without the plugin. The honest caveat attached to it: the
sample behind the loss is ONE task scored twice, so it is thinner evidence than the 2/4 suggests.

### Steering budget

`maxSteersPerTask: 1`, deliberately tighter than `maxAssessments: 3`. The assessment cap bounds how
often we LOOK; the steer cap bounds how often we SPEAK. A steered turn reaches `turn-stopping` again,
so a second assessment of the same task is expected — a second steer for the same disagreement is a
loop, and a loop is worse than any single missed intervention. Once spent, later turns of the task are
recorded with `steer_suppressed: per_task_steer_budget` and allowed to end normally.

Every row separates `would_steer` (what the policy wanted) from `will_steer` (what the run-time limits
allowed). Without that split a quiet log cannot distinguish a healthy policy from an exhausted budget,
and those two call for opposite responses.

### Stop-loss

**The first clear false block turns it back to shadow.** Concretely: a turn that was steered where the
work was in fact complete, judged from the agent's own transcript rather than from the supervisor's
row. The revert is one line — `shadowMode: true` in `cordis.patch.yml` — plus a restart.

As of `policy_v 3` the rule is largely dormant, and saying so is better than leaving a promise with
nothing left to fire on: the only steers that remain come from `P1`/`P2`/`P3`, which are contradictions
in the recorded facts — a failing exit code, a claim with no run behind it, an unresolved error. A steer
of that kind has a checkable answer to "was it wrong?", which is exactly what the rule needed.

The measurement that motivated it is still the reason to read the log. On the control task, adding
command output raised `requirements_satisfied` from 0.17 to **0.40** and lowered
`blocking_issue_remaining` from 0.84 to **0.77** — 0.02 clear of the intervention boundary. Under
`policy_v 2` that turn was caught, narrowly. Under `policy_v 3` it is not caught at all, because the
boundary no longer spends an interruption.

Roll back with `shadowMode: true` (or `enabled: false`) plus a restart.

## Reading the log

`~/.dsh/completion-supervisor/assessments.jsonl`, three row kinds:

- `row: "assessment"` — what was seen, what Jev said, what the policy decided
- `row: "skip"` — a turn we deliberately did **not** assess, and why
- `row: "outcome"` — what the user did next, appended later, linked by `assessment_id`

The skip row matters as much as the assessment row. Without it a rule that fires too
often is invisible, and the analysis looks *healthier* the more it suppresses — because
the turns it swallowed never appear in the counts. `node tools/analyse.mjs` prints the
skip breakdown before the assessment breakdown for that reason.

The outcome row is what makes the log evaluable. Without it we could only ask "what would different
thresholds have done?", never "were the judgements right?".

| verdict | meaning |
|---|---|
| `true_pass` | we passed, the user moved on |
| `false_pass` | we passed, the user reported a problem — we missed it |
| `good_block` | we blocked, the agent then fixed it |
| `false_block` | we blocked, the user dismissed us — **our most expensive error** |

A false-block rate above ~10% is the signal to go back to shadow. See "Stop-loss" above for what
counts as a clear false block.

Every assessment row also carries `task_key`, `assessments_used_before` and `max_assessments`. These
exist so the per-task budget is checkable from the data: without them, "three assessments in one task"
(the ceiling working) and "one assessment in each of three tasks" (the reset working) produce the same
row count, and a task that never tripped a rule writes no skip row to disambiguate them.
`assessments_used_before` records the value the budget rule actually compared against, so it explains
the decision rather than following it. `node tools/analyse.mjs` groups by `task_key` and warns if any
assessment ever ran with the budget already spent.

## Version stamps

Every row records `log_v`, `task_v`, `prompt_v`, `question_set_v`, `question_set_hash`, `policy_v`,
`fingerprint_v` and `build_id`. Rows produced under different wording, thresholds, models or **code**
must not be pooled in one analysis, and these fields are how a reader separates them.

`question_set_v` is `prompt_v` under a name that says what it versions; both are written so the rows
already on disk stay readable. `question_set_hash` is its **derived** twin: a hash of the question
names and instruction texts, in declaration order, computed at load time. It exists because a
hand-maintained version number has a silent failure mode — edit an instruction, forget the bump, and
the log then claims two different question sets are the same, which quietly invalidates every
probability comparison across that boundary. A derived hash cannot be forgotten. Grouping rows by it is
correct even when a bump was missed, and order is part of the hash because the questions are answered
by index in a batched request, so a reordering reassigns every probability to a different question.

**Current: `prompt_v=2` / `question_set_v=2`, hash `d3773ecfa135493b`.** v1 is the baseline: seven
questions written as if every task were a code change, which made three of them unanswerable for
tasks that were not. v1 rows are kept and must not be pooled with v2 rows on any probability —
`question_set_hash` is the field that separates them, and `readProbability` in `lib/questions.js`
exists so a reader can still show one column across both, because the renamed
`tests_sufficient` / `verification_sufficient` means the same thing in each.

`build_id` is a hash of the shipped sources (`node tools/build-id.mjs`). It exists because the shape
versions cannot change when a *reader* is fixed: after the first install, rows were written with
`repo_available` present in `changed_fields` and absent from `facts`, because the writer had been
reloaded and the reader had not. Nothing in the row said so, and the mismatch looked like flakiness.
When a row's `build_id` differs from `node tools/build-id.mjs --check`, the running plugin predates
the sources.

`task_v` is the one to read when comparing what Jev was **shown**. Current: **4** (artifacts in
`activity` under v3, command output under v4 — both below), and `fingerprint_v` is **3** to match. Both
changes are deliberately `task_v` bumps and not `prompt_v` ones: the seven questions are untouched, so
`question_set_hash` is unchanged and v2/v3/v4 rows stay comparable on **what was asked** — which is what
makes the calibration question ("was it the missing evidence or the wording?") answerable by comparing
the groups. It was answered, and the answer was the evidence, not the wording; see below. A `prompt_v`
bump would have made every earlier row unusable for that comparison.

`policy_v` is the one to read when a **decision** changes rather than a question or a state. Current:
**3**. It went to 3 when `P4` stopped steering, so the same probabilities produce a different verdict
again and v2 rows must not be pooled with v3 ones. The two bumps separate cleanly: v1 and v2 differ in
*which rules could act*, v2 and v3 in *whether any probability could act at all*. `log_v` is **2** and did
not move: its own bump had a matching cause — v1 rows predate `would_steer`, `will_steer`,
`steer_suppressed`, `steers_used_before`, `max_steers_per_task`, and the `enforce` / `advisory_rule` /
`shadow_rule` / `gray_zone` fields — whereas v3 stopped READING fields rather than adding any, so the row
shape is identical and a bump would have implied a difference a reader could not find.

### Which model actually answered

Inside `jev`, every row carries two model fields:

| field | meaning |
|---|---|
| `model_requested` | the alias we asked for — `jev-latest` |
| `model` | the concrete id the API answered with, or `null` if it named none |

Both are recorded because **a threshold is a claim about a model**. `jev-latest` is a moving alias, so
a log that records only the alias cannot answer the question that decides whether a calibration is
still valid: has the thing behind the alias changed since these rows were written? Once the returned id
is known to be a concrete version, thresholds bind to that version rather than to the alias.

`model` stays `null` when the response omits one, rather than falling back to the requested alias. The
fallback would assert a concrete version nothing confirmed, and a later reader would take it as
evidence that calibration is still valid.

## Timeouts

`jevTimeoutMs` is **5000ms during the calibration phase**, up from the 3000ms the plugin started at.

A timeout is a *lost observation*, not just a slow row: one of the first four real calls timed out at
3000ms. If slowness correlates with large or ambiguous states — the interesting ones — then cutting
them off biases the sample toward the easy cases, which is the opposite of what a calibration phase is
for.

This number must come **down** before `shadowMode` is turned off. There it sits on the turn-close path
and the user waits for it, so the value has to come from the measured distribution (`latency_ms` is
recorded on every row) rather than from this default.

## Real contracts, measured rather than assumed

Seven facts below were established by reading a live session log and a live shell, and each one
contradicted a reasonable assumption. They are recorded here because the fixtures in
`test/fixtures/real-rows.json` and `test/real-fixtures.test.mjs` lock them in.

1. **`tool/call.data.arguments` is a JSON STRING.** DSH writes the model's raw argument text through
   (`dsh-agent-loop/lib/index.js:687-695`) and parses it only on the execution path. A reader that
   accepts only objects sees `{}` for *every* call — which does not merely lose a field, it turns
   "the agent ran the tests and they passed" into "the agent claimed tests it never ran", i.e. a
   fabricated accusation against an honest turn.

2. **Shell status markers sit at the END of the result.** `renderPwshResult`
   (`dsh-tool-pwsh/lib/index.js:59-79`) appends `[exit code: N]` as the final line, and omits it
   entirely on success. A prefix-truncating reader therefore drops the marker on any long output —
   and a failing test suite is exactly the case that produces long output. Measured on a real
   31k-char run: the head read ended mid-assertion, the absent marker meant "exit 0", and a
   **failing suite was recorded as passing**. Tool results are read from the tail for this reason.

3. **The exit code is the shell host's, not the child's.** A bare `node -e "process.exit(7)"`
   reports `[exit code: 1]` because pwsh normalises a non-zero child status. Appending
   `; exit $LASTEXITCODE` passes the real value through. So the marker is authoritative for
   ZERO versus NON-ZERO and must never be quoted as a child process's exact status. DSH's own
   `parseExitStatus` (`dsh-shell/lib/index.js:31-46`) reads this marker and nothing else.

4. **`git` availability is not the same as "no changes".** `collectGitFacts` returns `available`,
   and the default workspace here is *not* a repository — so every count is 0 and the naive reading
   is "a clean tree". `repo.available` is part of the TaskState, the fingerprint, and every log row
   so that "nothing changed" and "we could not look" can never be confused by a later analysis.

5. **A `user/message` is usually NOT the user.** This is the defect that did the most damage, because
   both of its effects were silent. Measured on one real session (4125 events, decoded with
   `tools/decode-session.mjs`), the `user/message` sources were:

   | source | count | what it is |
   |---|---|---|
   | `user` | 14 | the human — the ONLY task boundary |
   | `subagent-settled` | 13 | a child agent finishing |
   | `plugin (hindsight)` | 9 | memory injection |
   | `agent-message` | 6 | another agent |
   | `agent-instructions`, `skill-catalog`, `plugin (dsh-system-prompt)`, `plugin (compact)`, `plugin (agent-mailbox)` | 5/5/5/4/3 | DSH machinery |

   The code excluded only `plugin` and `tool` and accepted everything else as the human. So every
   `subagent-settled` and every `hindsight` injection started a "new user task" and reset the
   per-task assessment budget — the 3-per-task ceiling silently stopped existing, and because a
   reset is not an error and writes no row, the log looked healthy throughout. Worse, `goal` takes
   the *first* eligible message, and the second user-role message in that session is an
   `agent-instructions` block: Jev could be asked whether a **system reminder** had been completed.

   The fix is an allow-list, `isUserAuthored(source) → source?.kind === 'user'`
   (`lib/taskstate.js`). A future synthetic source now defaults to "not the human", which fails
   toward assessing less rather than toward an unbounded budget or a fabricated goal. Note that
   DSH's own `MessageSourceMap` is a *type* declaration: it lists `skill-invocation` and
   `team-message`, while the runtime emits `agent-instructions` and `skill-catalog`, which it does
   not name at all. That gap is the reason a deny-list cannot be kept correct by reading the types.

   **How the fix was verified on a live run**, not just in tests. A subagent session was created
   *after* the fixed plugin loaded, and it was made to spawn a nested subagent — which is what
   produces a `subagent-settled` message. Its session log then contained one human message and four
   synthetic ones (`agent-instructions`, `skill-catalog`, `agent-message`, `subagent-settled`),
   while its assessment row recorded `#task1`. Under the old deny-list that session would have
   counted five tasks and reset the budget four times. `npm run verify-boundary -- <session-id>`
   reproduces this: it decodes a session log, counts user-role messages by source, and compares the
   recorded `task_key` increments against what each revision would have counted.

6. **The exit code does not always belong to the command.** DSH's `[exit code: N]` marker carries the
   **shell host's** code, and in Windows PowerShell that is the code of the **last statement**. An
   agent that wraps a call to capture its output therefore hides the real result. Measured with
   `tools/measure-exit-shapes.mjs`, which runs each shape for real:

   | shape | observed | faithful? |
   |---|---|---|
   | `npm test` | 1 | yes |
   | `npm test 2>&1 \| Select-Object -Last 3` | 1 | yes |
   | `cd <dir>; npm test` | 1 | yes |
   | `npm test; exit $LASTEXITCODE` | 1 | yes |
   | `npm test; Write-Output "after"` | **0** | **masked** |
   | `npm test > $null 2>&1; Write-Output "after"` | **0** | **masked** |
   | `$out = npm test 2>&1; $code = $LASTEXITCODE; Write-Output "…"` | **0** | **masked** |

   On the first real-Jev round a subagent wrote that last shape, and a suite that really failed
   (npm exit 1) was recorded as `tests_passed: true`. The agent's claim was honest; **the plugin's
   evidence was wrong** — the one error this plugin exists to prevent, produced by the plugin
   itself.

   PowerShell 7 is not installed on this machine, so `dsh-pwsh-local` falls back to 5.1 and 5.1's
   behaviour is the contract that matters.

   The fix is not to stop trusting exit codes but to record *whose* code it is. With one statement
   the marker is the command's own; with several it belongs to the last one, unless that last
   statement is an explicit `exit $LASTEXITCODE` passthrough. `exitCodeIsAttributable()` implements
   exactly that rule and matches every measured shape. An unattributable command votes for
   **neither** outcome, so the verdict becomes `null` (unknown) — recording `true` was the bug, and
   recording `false` would fabricate an accusation against an honest turn. `facts.unattributable_exits_n`
   makes the rate measurable offline, and `tools/replay-real-commands.mjs` replays the verbatim
   commands from the live sessions to prove no failed run is misread.

   **The three states, and what each one means.** `tests_run` says whether anything ran at all;
   `tests_passed` is a separate tri-state whose `null` is a real answer rather than a missing value:

   | `tests_run` | `tests_passed` | meaning |
   |---|---|---|
   | `true` | `true` | a run succeeded, and the recorded exit code was genuinely that run's |
   | `true` | `false` | a run failed, and the recorded exit code was genuinely that run's |
   | `true` | `null` | a run happened and its result could not be honestly read — the agent wrapped the call |
   | `false` | `null` | no run was recorded |

   `null` never votes toward success or failure; it degrades `tests_passed` to "unknown" rather than
   guessing in either direction. `npm run verify-tristate` proves this end to end rather than by
   construction: it resolves the same shell DSH resolves, runs real commands in a child process,
   shapes the output with DSH's own rendering rules (`renderPwshResult`, transcribed from
   `dsh-tool-pwsh/lib/index.js:60-80`), and feeds the resulting events to the real `deriveEvidence`.
   It reports five cases — including one it expects to abstain on.

7. **An `assistant/message` carries the model's private reasoning, and it also has a `.text`.** The
   most common shape in a live session is `[reasoning, text, tool-call]` — 11 of 23 assistant messages
   in one 160-line session, with `[reasoning, tool-call]` at 5 and `[reasoning, text]` at 3. Both
   `reasoning` and `text` blocks expose a `.text` string, so a reader that concatenates *every* block
   with a `.text` produces the model thinking followed by the model replying, and on a 4000-character
   head read the thinking fills the budget and the reply is cut off entirely.

   Measured with `node tools/decode-session.mjs --match <session-id> --blocks`, which reports both
   rules side by side: on that session the two rules disagreed on **23 of 23** assistant messages —
   a 100% contamination rate. So `claim` was, every time, a **draft**:

   | rule | claim on a real turn |
   |---|---|
   | old (any block with `.text`) | `用户只发了"？"——可能是在问"怎么了/为什么停了"？我上一条回复被截断了…` |
   | new (`type === 'text'` only) | `上一轮回复被截断了，任务没停。现在直接下安装包。` |

   The consequence was visible in the numbers before the cause was: `evidence_matches_claim` sat at
   **0.10–0.34 on every real assessment**. Jev was being asked whether the agent's final summary was
   supported by the recorded evidence while being shown the model deliberating about which browser to
   download. A low probability there is the *correct answer to the question that was actually asked*,
   which makes this the most expensive kind of defect: the score looks like a calibration problem, so
   the instinct is to move a threshold — and no threshold can fix reading the wrong text.

   There is a second-order effect that is worse than the low score. `detectUnverifiedClaims` runs
   regexes over the claim, so a model *thinking* "I should check whether the tests pass before I say
   so" matched as a claim that tests passed with no test command recorded — a **fabricated accusation
   against an honest turn**, which the policy can then block on.

   The fix is an allow-list (`block.type === 'text'`), for the same reason `isUserAuthored` is one: a
   new private block type must not silently become user-facing prose. The cost is asymmetric — missing
   a block loses a little context, while admitting one puts thinking into the claim and can block an
   honest turn. A reasoning-only message now leaves the claim unchanged instead of overwriting it, so
   the last tool call of a turn cannot decide what Jev was asked about.

## What a turn produced (artifacts)

`repo.changed_files` was the only channel for "what did this turn produce", and it comes from
`git status`. On this machine the default working directory is **not a git repository**, so that
list was always empty: a turn that created a file reached Jev with no evidence of it at all. Jev was
then asked whether "the repository state satisfies the user's request", could see nothing, and
answered `requirements_satisfied` at **0.26-0.48 on every real turn** — low enough to trip the P4
block rule on turns that were in fact complete, back when P4 could steer. That median of 0.27 is also
why the P4 advisory is measured against the intervention band and not the observation one.

`lib/artifacts.js` fills that gap from the one source that needs no inference: the **structured
arguments** of the tools that declare a path.

| tool | argument | meaning |
|---|---|---|
| `write` | `file_path` | produced |
| `edit` | `file_path` | produced |
| `present` | `files[].path` | produced |
| `read`, `read_image` | `file_path` | touched only — not produced |

The exclusion is the design. **A shell command is never parsed for the side effects it might have
had.** `Invoke-WebRequest -OutFile x`, `New-Item x`, `Set-Content x` and `npm run build` all create
files, and nothing short of a shell interpreter can say which — measured on real logs, all 545
`pwsh` calls carried only `command/description/workdir/timeoutMs/run_in_background`, and **all 1375
tool results were plain prose** (`[text]`). Guessing would put a fabricated path into the state the
whole judgement rests on, which is the same class of error as reading a wrapped exit code as a pass.

Unknown tools are ignored (an allow-list, like `isUserAuthored`), so a future tool is
under-reported rather than mis-reported. `node tools/scan-tool-schemas.mjs` exists to find it: it
reports which argument names this machine has actually used and flags the ones that look like paths.

### What `verified_artifacts` does and does not mean

It means **a producing tool call for this path did not report an error**. `isError` is a real
structured field on the result block, so this is an observation. It does **not** mean the content
was checked: hashes, signatures and existence probes are performed here by `pwsh`, whose result is
prose. The field is shaped to accept `sha256` / `signature` / `exists` when a structured source
appears; nothing fills them today, and deriving them from text would be worse than omitting them.

### Verified on real sessions

`node tools/verify-artifacts.mjs --match <session-id>` replays a session through the plugin's own
reader and prints what Jev would be shown. Two real runs:

- A subagent that created a file: `created_or_written_paths: scratch\unverified-note.md`, with
  `repo.available: false` and `changed_files: []` — the exact case that used to carry nothing.
- A browser-download task: the artifact
  `C:\Users\lxb-tuf\Downloads\AdsPower-Global-8.7.23-x64.exe` was recorded **via `present`**, while
  the `pwsh` download command next to it contributed nothing.

That second result is worth stating plainly, because it is a real limit rather than a bug: **a
download is only evidenced when the agent declares the file with `present`.** An agent that
downloads with `pwsh` and never presents the result leaves no artifact, and the supervisor will not
invent one.

`touched_paths` is recorded but deliberately **not** part of the fingerprint: reading different files
says nothing about whether the work is finished and churns constantly, so including it would defeat
the deduplication the fingerprint exists for.

## What a command printed (output evidence)

`task_v 4` adds `output_tail`, `output_truncated` and `output_chars` to every entry in `commands[]`,
because a fact the claim referred to was never reaching the judge.

**The measurement that forced it.** Under `task_v 3`, every completed turn that was blocked was blocked
by `P6_evidence_mismatch`: `evidence_matches_claim` at 0.40-0.47 against a 0.50 threshold — C1 0.42,
C2 0.47, N2 0.40. In all three the claim quoted something a command had **printed** ("the script printed
hello, world", "12 files, 4078 lines total") while the state carried the command text and its exit code
and no output. Jev answered that the claim was unsupported by the recorded items, and **it was right** —
so the wording was not too strict and the threshold was not too low. A fact the agent's own words
referred to had simply never been put in front of the judge.

So this adds the missing evidence rather than relaxing the test:

| field | meaning |
|---|---|
| `output_tail` | the END of the result, bounded |
| `output_truncated` | whether what we kept is less than what the command printed |
| `output_chars` | the ORIGINAL character count |
| `output_hash` | FNV-1a over the bounded output — the fingerprint's input |

**The tail, not the head**, for the same reason `readToolResult` has always read from the tail: test
summaries, totals, counts and DSH's own `[exit code: N]` marker are all at the bottom. `output_chars` is
measured against the original result, not against the 20k tail window, or a 200k log would describe its
reader instead of itself.

**Two budgets.** 1500 characters per command, 4000 across all of them, spent **newest first** — the most
recent command is the one a closing claim refers to. Twelve commands at the per-command limit would be
18k characters inside a 12k-token state, and `fitState` would then have to degrade the goal and the claim
— the two texts the judgement is actually about — to make room for log tails. Older commands keep their
exit code and lose only their output, and the exit code is what `tests_passed` is derived from.

**The fingerprint takes the hash, never the text.** `materialFacts` is `JSON.stringify`-ed and hashed, so
live output would move the fingerprint on every unrelated byte a deterministic tool printed — a timestamp
inside a log line, a progress counter, a temp path — and each move costs a Jev call. `output_hash` is
computed from a command's own bounded output *before* the shared budget runs, so two identical turns
fingerprint identically no matter what a later command consumed.

**Redaction happens at the source.** A shell result can echo a token the agent printed, and the state is
both sent to Jev and written to the log, so `deriveEvidence` scrubs the configured secret out of the
output before it becomes a fact (`lib/redact.js`). `DecisionLog` keeps its row-level scrub as the last
line of defence, and the test asserts `log.redactions === 0` for a log configured with **no** secret —
which can only pass if the source already did the work.

## Known issue, deliberately not fixed yet

**The per-task assessment budget does not survive a restart.** `maxAssessments` is enforced from an
in-memory counter (`lib/state.js`), so restarting DSH resets it. Seen in the log: one `task_key`
appeared on five rows, the first four with `assessments_used_before: 0` and different `build_id`s.
During development, with frequent restarts, the "hard ceiling" is softer than the name suggests.

Not fixed on purpose, and it does not block shadow. Persisting it means writing state that the read
side has to tolerate, and DSH's session log is **fail-closed** — a custom write path that the reader
cannot parse makes the whole session unloadable, which is a far worse outcome than an extra API call.
Fix it with a session- or task-keyed durable store if that ever matters.

**A turn whose user request was not a task was steered once — `policy_v 3` is the response to it.** The
first live intervention, recorded 2026-09-20, is the worked example, and it is kept here rather than
quietly dropped because it is the strongest single piece of evidence behind the contraction. The user's
message was a four-character status confirmation; the agent's turn verified the restart and reported it,
and also restated test results produced by the PREVIOUS turn. Jev was shown `goal` = that four-character
confirmation beside `created_or_written_paths: []` and `tests_run: false`, and answered
`requirements_satisfied` **0.28** — below the intervention band that could then steer.
`evidence_matches_claim` came back **0.14**, and that number was correct: the claim named results nothing
in that turn's state could support.

So the judgement was defensible and the user experience was not, and both were true at once:

| what | verdict |
|---|---|
| `evidence_matches_claim 0.14` | **correct** — the claim did outrun the recorded evidence |
| the user's request had been fulfilled | **also correct** — the restart was verified and reported |
| interrupting that turn | **wrong** — the user asked for a status check, not for work |

**What changed since, and why this stopped being an open risk.** The fix was not the **non-task guard**
proposed below — it was removing a probability's ability to interrupt at all. Under `policy_v 3` the same
turn records `advisory_rule: P4_requirements_unmet` (and `P6_evidence_mismatch`) and is allowed to end,
because every rule this case tripped is advisory. The three readings in the table above are unchanged: they
were right and the ACTION was wrong, which is a distinction no threshold could act on and a contraction
does not have to.

So the non-task guard is **not built**, and would now need a different justification than this case:
`completion_supervisor_status` and the Hindsight tools produce no paths, a non-shell tool's output does not
enter the state at all, and a very short `goal` gives `requirements_satisfied` little to anchor on — so a
turn made only of verification still has nothing recorded to point at.

Escalation rule, as agreed. It is mostly historical now that the only steers left come from
`P1`/`P2`/`P3`, which compare against recorded facts rather than probabilities:

- **one more steer on a status-confirmation turn** → the FACT was wrong, since only facts steer now; fix
  the evidence extraction rather than adding a non-task rule
- **one steer on a clearly normal task** → back to shadow immediately, no discussion
- a correct steer → record it and continue

## Deliberately not implemented

Periodic assessment, stuck detection, worker switching, and model routing. The MVP is
`turn-stopping → TaskState → Jev → decision` — shipped first as a shadow observer, then as a guarded
intervenor, then at `policy_v 3` contracted back to deterministic enforcement with Jev in an
observation-only role — and it earns its way forward from there.

Also deliberately deferred: using the material/message tool split to skip assessments. The two facts
are recorded (`material_tool_calls`, `message_only_tool_calls`) but nothing acts on them yet, because
a real turn showed that a "conversational" subagent still carries a tool call — the harness instructs
it to report back with `send_message`. "Did it call a tool?" is therefore not a reliable proxy for
"did it do work", and the distribution has to be observed before a rule is allowed to save an API
call on it. The classifier is a deny-list, so an unknown future tool counts as material and is never
silently skipped.

## Known constraints

- **Never persist state via a custom `session.append(...)` event.** The write side has no whitelist
  so it lands on disk, but the read side is fail-closed (`dsh-session-persistence/lib/index.js:182-197`)
  and `append()` cannot set `ignorable` — the whole session log would become unloadable. This plugin
  appends nothing to the session log.
- **A committed turn cannot be reopened.** `agent/turn-stopping` is the only guard window.
- **`ctx.shell.run` requires `sandboxPolicy`** — `dsh-pwsh-local`'s `resolve()` has no default.
- **Desktop has no HMR** — config changes need a restart.
- **Never edit these files through PowerShell 5.1.** `Set-Content -Encoding UTF8` reads the existing
  file as ANSI (code page 936 here) and re-encodes what it read, so non-ASCII text is silently
  replaced. It cost real time twice: Chinese regex literals in `lib/log.js` became `SyntaxError:
  Invalid regular expression` (loud, and fixed), and em dashes became U+9225 + U+FFFD (silent — the
  code still ran, and only a reader would notice). PowerShell 5.1 also has no `` `u{...} `` escape, so
  writing one stores the six characters literally. Use the edit tool, or Node.
  `node tools/fix-mojibake.mjs --check` detects all of these; `--check` exits non-zero. Note that
  PowerShell's `Get-Content` also *displays* valid UTF-8 CJK as mojibake — verify with Node before
  concluding a file is damaged, because the log's Chinese text is intact and only the console is
  lying.

## Tests

```
npm test                              # pure, integration, and real-fixture regression suites
node tools/build-id.mjs --check       # is the running plugin older than these sources?
node tools/fix-mojibake.mjs --check   # did a shell round-trip mangle any text?
node tools/verify-tristate.mjs        # three-state test verdict, through a real shell
```

The test count is deliberately not written down here. It said 92 while the suite had grown to 114,
and a stale number in the one place a reader looks to decide whether the suite is healthy is worse
than no number: `npm test` prints the count itself.

No network and no DSH install required. The integration tests write the decision log to a real temp
file, so they also verify the row shape on disk.

`test/real-fixtures.test.mjs` is different from the other two files, and the difference is the point.
Its inputs are copied verbatim out of a live run (`test/fixtures/real-rows.json`) rather than written
by hand. Every defect found so far was a shape mismatch that a hand-written fixture would have
encoded *wrongly*: the original fixture passed `arguments` as an object because that is what it
assumed, so the suite stayed green while the plugin was broken in production. A fixture authored by
the code's author can only confirm the author's assumptions; one copied from the system can
contradict them.

Two of those regressions are written as executable counterfactuals — the test reconstructs the OLD,
broken reader and asserts the bad outcome, then asserts the fixed one. That way the bug is documented
as behaviour rather than as a paragraph that can drift out of date.

## Smoke-testing a change on this machine

Because Desktop has no HMR, every code change needs a DSH restart before it is observable. In order:

1. `npm test` — the shape contracts.
2. `node tools/build-id.mjs --write` — stamp the new revision.
3. `node tools/verify-tool-contract.mjs` — load the REAL `dsh-tools` and check every registered tool
   definition against its real schema validator. Worth doing before the restart, because a tool whose
   schema uses an unsupported keyword fails the whole plugin at load time, and the supported subset is
   narrow enough to surprise you (`minimum` and `maximum` are rejected). It also calls each
   `execute()` once.
4. Restart DSH.
5. `completion_supervisor_status` — confirm the mode line, that both bands are printed
   (`observation band (logged only)` and `intervention band (advisory only since policy_v 3)`), that the
   steering line names `P1, P2, P3` and nothing else, and that `BUILD_ID` matches
   step 2. A mismatch means the running plugin is older than the tree, and any log rows written since
   are from the previous build. `/supervisor` — or the tool, which renders the same report — reads
   the same `BUILD_ID` off the log
   instead of memory, and prints a `note:` while the newest row predates this process — a fresh
   restart before its first assessment, not a fault. It raises the stale-code CHECK only when a row
   written AFTER this process started names a different id.
6. Run a turn that uses `pwsh`, then read the newest log row: `facts.repo_available` must be present
   and `commands` must contain the real command with its exit code.
7. For the failing-test path, run the bundled deliberately-failing project:
   `cd test/fixtures/failing-project && npm test`. The row must read `tests_run: true`,
   `tests_passed: false`, and reach `P3_failing_tests`. Two simpler-looking commands do NOT work for
   this check, and both are recorded in the fixture: a `;`-separated trailing statement succeeds and
   becomes the final status (so the "failure" never happened), and a bare `process.exit(7)` is
   normalised to 1 by pwsh.
8. `node tools/analyse.mjs` — the skip breakdown should show `no_material_change` after a repeat
   stopping, not a second assessment, and the per-task budget section should attribute every new row
   to a task. The "what was asked about" section must show a goal that is the USER's request; a goal
   containing `system-reminder` means the source allow-list has regressed.
9. `npm run verify-boundary -- <session-id>` — checks a session with synthetic user-role messages
   still recorded a single `task_key`. This is the one check that cannot be done from the plugin log
   alone, because it needs the session log to count what the human actually sent.
10. `node tools/score-round.mjs` — the replay gate. `steered a task that was COMPLETE` must stay `0/8`.
    `steered a task that was INCOMPLETE` reads `2/4` under `policy_v 3` — it was `4/4` while `P4` steered
    — and `missed an incomplete task` is the `2/4` that paid for it. Any change to the policy, the
    question set or the TaskState has to move these numbers or explain why it did not.
11. `node tools/fix-mojibake.mjs --check` — exit 0. If it reports anything, a shell round-trip has
    damaged text and the affected file must be repaired before committing.
