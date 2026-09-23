/**
 * Integration tests: the plugin wired to a fake DSH context.
 *
 * These exercise the real `apply()` — hook registration, throttle rules, the
 * fingerprint skip, the fail-open paths, and the log rows — with only the
 * OUTERMOST boundaries faked:
 *
 *   - `ctx`        a minimal Cordis-like context (on / inject / get / logger)
 *   - `ctx.shell`  returns canned git output instead of spawning a process
 *   - `fetch`      returns a canned Jev response instead of calling the network
 *
 * The log is written to a REAL temp file, so these tests also verify that rows
 * reach disk in the documented shape. No DSH install and no network are involved.
 *
 * The pure modules are covered by pure.test.mjs; what is under test HERE is the
 * wiring — the part a unit test of `decide()` cannot reach. Three behaviours are
 * worth guarding hardest:
 *   1. Shadow mode never steers.  (A regression here would touch a live turn.)
 *   2. Every failure fails open.  (A regression here would break a session.)
 *   3. Identical material facts skip the Jev call. (A regression costs money.)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { apply } from '../lib/index.js';
import { JEV_QUESTION_NAMES, QUESTION_SET_HASH } from '../lib/questions.js';

// ── test doubles ─────────────────────────────────────────────────────────────

/** A Jev body with all seven answers, defaulting to "yes, it is done". */
function jevBody(overrides = {}) {
  const base = Object.fromEntries(JEV_QUESTION_NAMES.map((name) => [name, { noul: 0.9 }]));
  base.blocking_issue_remaining = { noul: 0.05 };
  base.needs_more_verification = { noul: 0.05 };
  for (const [key, value] of Object.entries(overrides)) base[key] = { noul: value };
  return { answers: base, usage: { input_tokens: 4000 } };
}

/**
 * Build a fake context that records what the plugin does to it.
 * @param {object} [opts]
 */
function fakeContext({
  gitStatus = ' M src/upload.js\n',
  gitShortstat = ' 1 file changed, 10 insertions(+), 2 deletions(-)\n',
  shellThrows = false,
} = {}) {
  const handlers = new Map();
  const logs = { info: [], warn: [] };
  const tools = new Map();
  const commands = new Map();
  const shellCalls = [];

  const ctx = {
    on(event, handler) {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event).push(handler);
    },
    inject(services, callback) {
      // The plugin injects 'agents' and 'tools'; run the callback eagerly so the
      // tests do not have to model Cordis's dependency lifecycle.
      callback(ctx);
    },
    get(serviceName) {
      if (serviceName === 'sandboxPolicy') {
        return { resolve: () => ({ mode: 'danger-full-access', workspaceRoot: process.cwd() }) };
      }
      return undefined;
    },
    logger: {
      info: (message) => logs.info.push(String(message)),
      warn: (message) => logs.warn.push(String(message)),
    },
    shell: {
      resolve: (spec) => spec,
      async run(spec) {
        shellCalls.push(spec.command);
        if (shellThrows) throw new Error('shell unavailable');
        if (spec.command.includes('--porcelain')) return ok(gitStatus);
        if (spec.command.includes('--shortstat')) return ok(gitShortstat);
        return ok('');
      },
    },
    tools: {
      register(definition) {
        tools.set(definition.name, definition);
      },
    },
    // Registered through the same `scope` object as the tools, so a stub that models one and not
    // the other fails loudly at `apply()` instead of silently skipping a registration.
    commands: {
      register(definition) {
        commands.set(definition.name, definition);
      },
    },
  };

  return {
    ctx,
    logs,
    tools,
    commands,
    shellCalls,
    /** Fire an event and await every handler. */
    async emit(event, payload, ...rest) {
      for (const handler of handlers.get(event) ?? []) await handler(payload, ...rest);
    },
    handlersFor: (event) => handlers.get(event) ?? [],
  };
}

function ok(text) {
  return { exitCode: 0, timedOut: false, aborted: false, stdout: { text }, stderr: { text: '' } };
}

/** A fake session whose id and header the plugin reads. */
function fakeSession(id = 'sess-1', cwd = 'C:/repo') {
  return { id, header: { id, cwd } };
}

/** A fake agent with a `steer` recorder. */
function fakeAgent(session) {
  const steered = [];
  return { agent: { session, steer: (message) => steered.push(message) }, steered };
}

/**
 * tool/call + tool/result events as DSH appends them.
 *
 * `arguments` is serialised to a STRING because that is what the real session log
 * holds — `appendToolCall` writes the model's raw text through and parses it only on
 * the execution path. Passing an object here (as this helper originally did) hides
 * the exact defect that reached production.
 */
function toolPair({ callId = 'c1', name = 'edit', args = {}, text = 'ok', isError = false, turn = 1 } = {}) {
  return [
    { type: 'tool/call', data: { turn, step: 1, callId, name, arguments: JSON.stringify(args) } },
    {
      type: 'tool/result',
      data: {
        turn,
        step: 1,
        message: { content: [{ type: 'tool-result', toolCallId: callId, content: text, isError }] },
      },
    },
  ];
}

/** An assistant message carrying the completion claim. */
function claim(text, turn = 1) {
  return { type: 'assistant/message', data: { turn, step: 2, message: { content: [{ type: 'text', text }] } } };
}

/** A user-authored message (the ground-truth signal). */
function userMessage(text) {
  return { type: 'user/message', data: { role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } } };
}

/**
 * Wire the plugin with injected fetch, writing the decision log to a real temp
 * file.
 *
 * `apiKey` exists so a test can install a REALISTICALLY LONG key. The default
 * `test-key-000` is 12 characters, below the redaction threshold, so a key-leak test
 * written against it would pass without ever exercising the guard.
 *
 * @returns {{rig: object, logPath: string, readRows: () => object[], calls: object[], restore: () => void}}
 */
function rig({ config = {}, fetchImpl, apiKey = 'test-key-000', ...ctxOpts } = {}) {
  const harness = fakeContext(ctxOpts);
  const calls = [];
  const dir = mkdtempSync(join(tmpdir(), 'completion-supervisor-test-'));
  const logPath = join(dir, 'assessments.jsonl');

  // The plugin resolves the key through `process.env` first, so that is the boundary
  // stubbed (the key file is a fallback and is not touched here).
  const previousKey = process.env.TYPESAFE_API_KEY;
  process.env.TYPESAFE_API_KEY = apiKey;

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    if (typeof fetchImpl === 'function') return fetchImpl(url, init, calls.length);
    return { ok: true, status: 200, async text() { return JSON.stringify(jevBody()); } };
  };

  apply(harness.ctx, {
    enabled: true,
    shadowMode: true,
    maxAssessments: 3,
    jevTimeoutMs: 5000,
    logPath,
    logEnabled: true,
    ...config,
  });

  const restore = () => {
    globalThis.fetch = originalFetch;
    if (previousKey === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = previousKey;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Best effort; a leftover temp dir is harmless.
    }
  };

  const readRows = () => {
    if (!existsSync(logPath)) return [];
    return readFileSync(logPath, 'utf8')
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line));
  };

  return { rig: harness, logPath, readRows, calls, restore };
}

/** Feed several session events through the plugin. */
async function emitEvents(harness, session, events) {
  for (const event of events) await harness.emit('session/event', session, event);
}

// ── the guard rails ──────────────────────────────────────────────────────────

test('shadow mode never steers, even when the policy wants to block', async () => {
  const { rig: harness, calls, readRows, restore } = rig({ config: { shadowMode: true } });
  try {
    const session = fakeSession();
    const { agent, steered } = fakeAgent(session);

    await emitEvents(harness, session, toolPair({ name: 'edit', args: { file_path: 'a.js' } }));
    await emitEvents(harness, session, [claim('Done. All tests pass.')]);
    await harness.emit('agent/turn-stopping', { agent, turn: 1, signal: undefined });

    assert.equal(steered.length, 0, 'shadow mode must not steer');
    assert.equal(calls.length, 1, 'the assessment should still happen');
    assert.ok(
      harness.logs.info.some((line) => line.includes('[shadow_mode] would verify_more')),
      `expected a shadow notice, got: ${JSON.stringify(harness.logs.info)}`,
    );
    // The intent is recorded even though it was not acted on, and — the pair that starts to matter
    // the moment steering is on — the row separates "the policy wanted to act" from "we acted".
    const rows = readRows();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].decision.action, 'verify_more');
    assert.equal(rows[0].decision.applied, false);
    assert.equal(rows[0].decision.would_steer, true, 'the policy did want to act');
    assert.equal(rows[0].decision.will_steer, false, 'and shadow mode is why it did not');
    assert.equal(rows[0].decision.steer_suppressed, 'shadow_mode');
    assert.equal(rows[0].shadow, true);
  } finally {
    restore();
  }
});

test('intervention mode steers once, with a message naming the real problem', async () => {
  const { rig: harness, restore } = rig({ config: { shadowMode: false } });
  try {
    const session = fakeSession();
    const { agent, steered } = fakeAgent(session);

    await emitEvents(harness, session, toolPair({ name: 'edit', args: { file_path: 'a.js' } }));
    await emitEvents(harness, session, [claim('Done. All tests pass.')]);
    await harness.emit('agent/turn-stopping', { agent, turn: 1, signal: undefined });

    assert.equal(steered.length, 1, 'intervention mode should steer exactly once');
    const message = steered[0];
    assert.match(message.content[0].text, /Completion check/);
    assert.match(message.content[0].text, /no test command/);
    // The source tag is what keeps our own message from being read as a user turn.
    assert.equal(message.source.kind, 'plugin');
    assert.equal(message.source.plugin, 'completion-supervisor');
    assert.equal(message.role, 'user');
    assert.equal(typeof message.id, 'string');
  } finally {
    restore();
  }
});

test('the self-trigger guard stops a steer from causing a second assessment', async () => {
  const { rig: harness, calls, restore } = rig({ config: { shadowMode: false } });
  try {
    const session = fakeSession();
    const { agent, steered } = fakeAgent(session);

    await emitEvents(harness, session, toolPair({ name: 'edit', args: { file_path: 'a.js' } }));
    await emitEvents(harness, session, [claim('Done. All tests pass.')]);

    await harness.emit('agent/turn-stopping', { agent, turn: 1, signal: undefined });
    assert.equal(calls.length, 1);
    assert.equal(steered.length, 1);

    // The turn stops again IN THE SAME TURN because of our steer. Assessing again
    // would loop, so the guard must skip it even though nothing else changed.
    await harness.emit('agent/turn-stopping', { agent, turn: 1, signal: undefined });
    assert.equal(steered.length, 1, 'must not steer twice in one turn');
  } finally {
    restore();
  }
});

test('a task is steered at most once, even across turns', async () => {
  // THE LOOP GUARD THE SELF-TRIGGER GUARD CANNOT SEE. `intervenedIn` stops a second steer inside one
  // turn. This stops the same DISAGREEMENT being repeated on the NEXT turn of the same task, which
  // is the failure mode that matters once steering is live: a steered turn reaches `turn-stopping`
  // again, so a supervisor that keeps insisting turns one disagreement into an unbounded exchange
  // and the agent has no way to end it.
  const { rig: harness, readRows, restore } = rig({ config: { shadowMode: false, maxSteersPerTask: 1 } });
  try {
    const session = fakeSession();
    const { agent, steered } = fakeAgent(session);

    await emitEvents(harness, session, toolPair({ name: 'edit', args: { file_path: 'a.js' } }));
    await emitEvents(harness, session, [claim('Done. All tests pass.')]);
    await harness.emit('agent/turn-stopping', { agent, turn: 1, signal: undefined });
    assert.equal(steered.length, 1, 'the first stopping of the task steers');

    // A NEW turn of the SAME task. The turn number differs but the user task does not, which is the
    // distinction the budget is keyed on. The state must also differ materially or the fingerprint
    // would skip the assessment and prove nothing about the budget.
    await emitEvents(
      harness,
      session,
      // A distinct callId as well as a distinct turn: the evidence reader keys calls by id, so
      // reusing `c1` would overwrite the first turn's call instead of adding a second one.
      toolPair({ callId: 'c2', name: 'edit', args: { file_path: 'b.js' }, turn: 2 }),
    );
    await emitEvents(harness, session, [claim('Still done. All tests pass.', 2)]);
    await harness.emit('agent/turn-stopping', { agent, turn: 2, signal: undefined });

    assert.equal(steered.length, 1, 'the budget for this task is spent, so it must not steer again');
    const rows = readRows().filter((row) => row.row === 'assessment');
    assert.equal(rows.length, 2, 'it still assessed — the cap is on SPEAKING, not on looking');
    assert.equal(rows[1].decision.would_steer, true, 'the policy still wanted to act');
    assert.equal(rows[1].decision.will_steer, false, 'and the budget is what stopped it');
    assert.equal(rows[1].decision.steer_suppressed, 'per_task_steer_budget');
    assert.equal(rows[1].steers_used_before, 1);
    assert.equal(rows[1].max_steers_per_task, 1);
  } finally {
    restore();
  }
});

// ── the cost controls ────────────────────────────────────────────────────────

test('a second stopping with identical material facts skips the Jev call', async () => {
  const { rig: harness, calls, restore } = rig({});
  try {
    const session = fakeSession();
    const { agent } = fakeAgent(session);

    await emitEvents(harness, session, toolPair({ name: 'pwsh', args: { command: 'npm test' }, text: 'ok' }));
    await emitEvents(harness, session, [claim('Added retry; tests pass.')]);

    await harness.emit('agent/turn-stopping', { agent, turn: 1, signal: undefined });
    assert.equal(calls.length, 1);

    await harness.emit('agent/turn-stopping', { agent, turn: 1, signal: undefined });
    assert.equal(calls.length, 1, 'an unchanged state must not trigger a second assessment');
  } finally {
    restore();
  }
});

test('a material change does trigger a second assessment', async () => {
  const { rig: harness, calls, restore } = rig({});
  try {
    const session = fakeSession();
    const { agent } = fakeAgent(session);

    await emitEvents(
      harness,
      session,
      toolPair({ name: 'pwsh', args: { command: 'npm test' }, text: 'boom\n[exit code: 1]' }),
    );
    await emitEvents(harness, session, [claim('Working on it.')]);
    await harness.emit('agent/turn-stopping', { agent, turn: 1, signal: undefined });
    assert.equal(calls.length, 1);

    // The agent now really runs the tests and they pass: new material facts.
    await emitEvents(harness, session, toolPair({ callId: 'c2', name: 'pwsh', args: { command: 'npm test' }, text: 'ok' }));
    await emitEvents(harness, session, [claim('Fixed the failing test; suite is green.')]);

    await harness.emit('agent/turn-stopping', { agent, turn: 1, signal: undefined });
    assert.equal(calls.length, 2, 'changed evidence must be re-assessed');
  } finally {
    restore();
  }
});

test('the budget caps assessments, and a new user task resets it', async () => {
  const { rig: harness, calls, restore } = rig({ config: { maxAssessments: 2 } });
  try {
    const session = fakeSession();
    const { agent } = fakeAgent(session);

    const states = [
      { pair: toolPair({ callId: 'c1', name: 'edit', args: { file_path: 'a.js' } }), text: 'Step one.' },
      { pair: toolPair({ callId: 'c2', name: 'edit', args: { file_path: 'b.js' } }), text: 'Step two.' },
      { pair: toolPair({ callId: 'c3', name: 'edit', args: { file_path: 'c.js' } }), text: 'Step three.' },
    ];

    for (const entry of states) {
      await emitEvents(harness, session, entry.pair);
      await emitEvents(harness, session, [claim(entry.text)]);
      await harness.emit('agent/turn-stopping', { agent, turn: 1, signal: undefined });
    }
    assert.equal(calls.length, 2, 'must stop at the budget');

    // A new user message begins a new task, so the budget resets. Otherwise the
    // supervisor would be permanently spent after the session's first problem.
    // The events carry turn 2, matching the stopping below: `deriveEvidence`
    // filters by turn, so the new turn's work is what gets assessed.
    await harness.emit('session/event', session, userMessage('now do something else'));
    await emitEvents(
      harness,
      session,
      toolPair({ callId: 'c4', name: 'edit', args: { file_path: 'd.js' }, turn: 2 }),
    );
    await emitEvents(harness, session, [claim('Different work entirely.', 2)]);
    await harness.emit('agent/turn-stopping', { agent, turn: 2, signal: undefined });

    assert.equal(calls.length, 3, 'a new task must get a fresh budget');
  } finally {
    restore();
  }
});

test('a turn with no tool call is never assessed', async () => {
  const { rig: harness, calls, restore } = rig({});
  try {
    const session = fakeSession();
    const { agent } = fakeAgent(session);

    await emitEvents(harness, session, [claim('Sure, that makes sense.')]);
    await harness.emit('agent/turn-stopping', { agent, turn: 1, signal: undefined });

    assert.equal(calls.length, 0, 'conversational turns must not cost a Jev call');
  } finally {
    restore();
  }
});

// ── fail-open ────────────────────────────────────────────────────────────────

test('a Jev timeout fails open and does not steer', async () => {
  const { rig: harness, calls, readRows, restore } = rig({
    fetchImpl: async () => {
      const error = new Error('timed out');
      error.name = 'TimeoutError';
      throw error;
    },
  });
  try {
    const session = fakeSession();
    const { agent, steered } = fakeAgent(session);

    await emitEvents(harness, session, toolPair({ name: 'edit', args: { file_path: 'a.js' } }));
    await emitEvents(harness, session, [claim('All tests pass.')]);
    await harness.emit('agent/turn-stopping', { agent, turn: 1, signal: undefined });

    assert.equal(steered.length, 0, 'a Jev failure must never steer');
    assert.equal(calls.length, 1, 'it should still have tried');
    assert.ok(harness.logs.warn.some((line) => line.includes('assessment unavailable')));

    // The deterministic contradiction is still recorded, because it needs no Jev.
    const rows = readRows();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].jev, null);
    assert.equal(rows[0].jev_error.kind, 'timeout');
    assert.equal(rows[0].decision.action, 'verify_more');
  } finally {
    restore();
  }
});

test('an HTTP error fails open', async () => {
  const { rig: harness, readRows, restore } = rig({
    fetchImpl: async () => ({ ok: false, status: 500, async text() { return 'internal error'; } }),
  });
  try {
    const session = fakeSession();
    const { agent, steered } = fakeAgent(session);

    await emitEvents(harness, session, toolPair({ name: 'edit', args: { file_path: 'a.js' } }));
    await emitEvents(harness, session, [claim('Done.')]);
    await harness.emit('agent/turn-stopping', { agent, turn: 1, signal: undefined });

    assert.equal(steered.length, 0);
    const rows = readRows();
    assert.equal(rows[0].jev_error.kind, 'http');
    assert.equal(rows[0].jev_error.message.includes('500'), true);
  } finally {
    restore();
  }
});

test('a malformed Jev response fails open', async () => {
  const { rig: harness, readRows, restore } = rig({
    fetchImpl: async () => ({ ok: true, status: 200, async text() { return '{"answers":{}}'; } }),
  });
  try {
    const session = fakeSession();
    const { agent, steered } = fakeAgent(session);

    await emitEvents(harness, session, toolPair({ name: 'edit', args: { file_path: 'a.js' } }));
    await emitEvents(harness, session, [claim('Done.')]);
    await harness.emit('agent/turn-stopping', { agent, turn: 1, signal: undefined });

    // A partial answer set must never be read as "confidently fine".
    assert.equal(steered.length, 0);
    assert.equal(readRows()[0].jev_error.kind, 'malformed');
  } finally {
    restore();
  }
});

test('git failures degrade the facts without aborting the assessment', async () => {
  const { rig: harness, calls, readRows, restore } = rig({ shellThrows: true });
  try {
    const session = fakeSession();
    const { agent, steered } = fakeAgent(session);

    await emitEvents(harness, session, toolPair({ name: 'pwsh', args: { command: 'npm test' }, text: 'ok' }));
    await emitEvents(harness, session, [claim('Tests pass.')]);
    await harness.emit('agent/turn-stopping', { agent, turn: 1, signal: undefined });

    // A missing diff is a weaker signal, not a reason to skip supervision.
    assert.equal(calls.length, 1);
    assert.equal(steered.length, 0);
    assert.equal(typeof readRows()[0].state_tokens_est, 'number');
  } finally {
    restore();
  }
});

test('without an API key the plugin catches contradictions and makes no network call', async () => {
  // HERMETIC ON PURPOSE. The plugin has TWO key sources — the environment and a file —
  // so a test that only clears the environment variable is not testing "no key", it is
  // testing "the machine I run on happens not to have a key file". On a machine where
  // the operator has one, this test made a REAL network call with a REAL key and failed,
  // which is exactly what happened the first time the suite ran after the key file was
  // installed. Both sources are therefore pointed at nothing here.
  const harness = fakeContext();
  const previousKey = process.env.TYPESAFE_API_KEY;
  const previousKeyFile = process.env.DSH_TYPESAFE_KEY_FILE;
  const originalFetch = globalThis.fetch;
  let fetched = false;
  globalThis.fetch = async () => {
    fetched = true;
    return { ok: true, status: 200, async text() { return JSON.stringify(jevBody()); } };
  };
  delete process.env.TYPESAFE_API_KEY;
  process.env.DSH_TYPESAFE_KEY_FILE = join(tmpdir(), 'completion-supervisor-absent-key.env');

  try {
    apply(harness.ctx, { enabled: true, shadowMode: false, logPath: 'C:/tmp/x.jsonl', logEnabled: false });
    const session = fakeSession();
    const { agent, steered } = fakeAgent(session);

    await emitEvents(harness, session, toolPair({ name: 'edit', args: { file_path: 'a.js' } }));
    await emitEvents(harness, session, [claim('All tests pass.')]);
    await harness.emit('agent/turn-stopping', { agent, turn: 1, signal: undefined });

    assert.equal(fetched, false, 'no key means no network call');
    // The deterministic contradiction is still caught, so a key-less install is
    // useful rather than inert.
    assert.equal(steered.length, 1);
    assert.match(steered[0].content[0].text, /no test command/);
    assert.ok(harness.logs.warn.some((line) => line.includes('TYPESAFE_API_KEY is not set')));
  } finally {
    globalThis.fetch = originalFetch;
    if (previousKey === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = previousKey;
    if (previousKeyFile === undefined) delete process.env.DSH_TYPESAFE_KEY_FILE;
    else process.env.DSH_TYPESAFE_KEY_FILE = previousKeyFile;
  }
});

// ── registration and reporting ───────────────────────────────────────────────

test('a disabled plugin registers no hooks and no tools', async () => {
  const harness = fakeContext();
  apply(harness.ctx, { enabled: false });
  assert.equal(harness.handlersFor('agent/turn-stopping').length, 0);
  assert.equal(harness.handlersFor('session/event').length, 0);
  assert.equal(harness.tools.size, 0);
});

test('the status tool reports mode, key presence and versions', async () => {
  const { rig: harness, restore } = rig({ config: { shadowMode: true } });
  try {
    const status = harness.tools.get('completion_supervisor_status');
    assert.ok(status, 'the status tool should be registered');
    const text = await status.execute();
    assert.match(text, /SHADOW \(logs only, never steers\)/);
    assert.match(text, /max assessments per user task: 3/);
    // The steer budget is reported separately from the assessment budget, and both bands are still
    // printed. Under policy_v 3 they are both diagnostics — the line that says who may actually
    // steer is now the P1/P2/P3 one — which is why `advisory only` is asserted here rather than the
    // v2 wording that claimed the narrow band could interrupt.
    assert.match(text, /max steers per user task: 1/);
    assert.match(text, /observation band \(logged only\): req < 0\.4 or blk >= 0\.65/);
    assert.match(text, /intervention band \(advisory only since policy_v 3\): req < 0\.3 or blk >= 0\.75/);
    assert.match(text, /may steer \(computed facts only\): P1, P2, P3/);
    assert.match(text, /advisory rules \(recorded, never steer\): P4, P5, P6, P7/);
    assert.match(text, /policy_v=3/);
    assert.match(text, /prompt_v=2/);
  } finally {
    restore();
  }
});

test('the health tool is read-only: it reports on a log it refuses to create', async () => {
  // A path that does not exist, so the assertion at the end can prove the tool only ever opens the
  // log for reading. This is the one property that matters about it: it cannot change a decision,
  // and "cannot change a decision" has to be checkable rather than asserted in a comment.
  const missing = join(tmpdir(), `cs-health-absent-${process.pid}-${Date.now()}.jsonl`);
  const harness = fakeContext();
  apply(harness.ctx, { shadowMode: false, logPath: missing });

  const health = harness.tools.get('completion_supervisor_health');
  assert.ok(health, 'the health tool should be registered');

  const text = await health.execute({ limit: 10 });
  assert.match(text, /^Completion Supervisor Health/);
  assert.match(text, /Last 10 assessments/);
  assert.match(text, /Mode: INTERVENTION/);
  assert.match(text, /Health: CHECK/, 'an absent log is reported as a verdict, not thrown');
  assert.match(text, /no log file at/);
  // The contract that matters most. Deciding whether a steer was wrong needs the task's meaning,
  // which is not in the log, so this command must never claim to have decided it.
  assert.doesNotMatch(text, /false_positive/i);
  assert.equal(existsSync(missing), false, 'reporting on a log must not create one');
  // And it is still wired exactly as before: registration added a tool, not a hook.
  assert.equal(harness.handlersFor('agent/turn-stopping').length, 1);
});

test('the health tool reads a log from before this process as normal, not as stale code', async () => {
  // The live case that produced a false alarm on the very first run of this tool, reproduced from
  // the timestamps that caused it: the newest row names the PREVIOUS build and was written after
  // that build was stamped but before this process started. An old process keeps appending after a
  // new build lands, so the row's age relative to the BUILD says nothing. Relative to the PROCESS
  // it says everything, and the honest verdict is a note.
  const dir = mkdtempSync(join(tmpdir(), 'cs-health-prev-'));
  const logPath = join(dir, 'assessments.jsonl');
  writeFileSync(
    logPath,
    `${JSON.stringify({
      log_v: 2,
      build_id: 'PREVIOUS_BUILD',
      row: 'assessment',
      assessment_id: 'old',
      at: '2020-01-01T00:00:00.000Z', // before now, i.e. before this plugin instance loaded
      shadow: false,
      policy_v: 2,
      task_v: 4,
      asked: { goal: 'previous session', claim: 'done' },
      jev: { probabilities: { requirements_satisfied: 0.9, blocking_issue_remaining: 0.05 }, model: 'jev-1.13.0' },
      jev_error: null,
      decision: { action: 'finish', rule: 'P8_finish', enforce: true, will_steer: false, would_steer: false },
      latency_ms: { total: 100, jev: 100 },
    })}\n`,
    'utf8',
  );

  try {
    const harness = fakeContext();
    apply(harness.ctx, { shadowMode: false, logPath });
    const text = await harness.tools.get('completion_supervisor_health').execute({});

    assert.match(text, /^note: no row has been written since this process started/m);
    assert.match(text, /Health: OK/);
    assert.doesNotMatch(text, /Health: CHECK/);
    assert.doesNotMatch(text, /something else is appending to this log/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the /supervisor command renders the same report as the tool, without a turn', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cs-command-'));
  const logPath = join(dir, 'assessments.jsonl');
  writeFileSync(
    logPath,
    `${JSON.stringify({
      log_v: 2,
      build_id: 'PREVIOUS_BUILD',
      row: 'assessment',
      assessment_id: 'old',
      at: '2020-01-01T00:00:00.000Z',
      shadow: false,
      policy_v: 2,
      task_v: 4,
      asked: { goal: 'previous session', claim: 'done' },
      jev: { probabilities: { requirements_satisfied: 0.9, blocking_issue_remaining: 0.05 }, model: 'jev-1.13.0' },
      jev_error: null,
      decision: { action: 'finish', rule: 'P8_finish', enforce: true, will_steer: false, would_steer: false },
      latency_ms: { total: 100, jev: 100 },
    })}\n`,
    'utf8',
  );

  try {
    const harness = fakeContext();
    apply(harness.ctx, { shadowMode: false, logPath });

    const command = harness.commands.get('supervisor');
    assert.ok(command, 'the /supervisor command should be registered');
    assert.match(command.description, /health summary/);

    const plain = await command.handler({ rawInput: '' });
    assert.equal(plain.kind, 'success');
    assert.match(plain.text, /^Completion Supervisor Health/);

    // The command and the tool MUST NOT drift. They exist for two different readers — a person at
    // the prompt and the agent mid-investigation — and the moment their numbers differ, one of them
    // is lying to somebody who has no way to tell which. Same builder, so assert identical bytes.
    const viaTool = await harness.tools.get('completion_supervisor_health').execute({});
    assert.equal(plain.text, viaTool, 'the command and the tool render the same report');

    const limited = await command.handler({ rawInput: '1' });
    assert.equal(limited.kind, 'success');
    assert.match(limited.text, /Last 1 assessments/);

    // A typo must be answered, not silently reinterpreted as "use the default".
    const rejected = await command.handler({ rawInput: '10 20' });
    assert.equal(rejected.kind, 'error');
    assert.match(rejected.text, /Usage: \/supervisor/);
    assert.match(rejected.text, /1\.\.500/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a partial config is filled from the schema, so the budget cannot vanish', async () => {
  // Regression: apply() used to copy the caller's object verbatim. Any field the
  // caller omitted became `undefined`, and an undefined `maxAssessments` makes the
  // rule `assessmentsUsed >= maxAssessments` compare against NaN — permanently
  // false — so the per-task ceiling silently stopped existing. Defaults must be
  // applied by apply() itself, not assumed to have been applied by the loader.
  const harness = fakeContext();
  apply(harness.ctx, { logEnabled: false });

  const status = harness.tools.get('completion_supervisor_status');
  const text = await status.execute();
  assert.match(text, /max assessments per user task: 3/, 'budget default must exist');
  assert.match(text, /jev model requested: jev-latest/, 'model default must exist');
  assert.match(text, /jev timeout: 5000ms/, 'timeout default must exist');
  assert.match(text, /state token budget: 12000/, 'budget default must exist');
  assert.match(text, /mode: SHADOW/, 'shadow must stay on when unspecified');
  // The derived question-set hash must be visible, because it is the field that says
  // whether rows are comparable even if a `prompt_v` bump was forgotten.
  assert.match(text, /question set: v2 hash [0-9a-f]{16}/, 'question set hash must be reported');
  // Before any Jev call the concrete model behind the alias is genuinely unknown, and
  // the status must say so rather than implying `jev-latest` is a version.
  assert.match(text, /no Jev response yet in this process/);
});

test('a config the schema rejects still loads, with every default', async () => {
  // A bad config must degrade to a defaulted shadow observer, never to a plugin
  // that fails to mount and takes the profile's boot down with it.
  const harness = fakeContext();
  apply(harness.ctx, { maxAssessments: 'not-a-number', shadowMode: 'yes' });
  const text = await harness.tools.get('completion_supervisor_status').execute();
  assert.match(text, /max assessments per user task: 3/);
  assert.match(text, /mode: SHADOW/);
  assert.equal(harness.handlersFor('agent/turn-stopping').length, 1);
});

test('a response that names no model records null, and the status says so', async () => {
  // The default Jev stub deliberately omits `model`, because this is the case most
  // likely to be got wrong: filling the field from the request would assert a concrete
  // version the API never confirmed, and a later reader would treat calibration as
  // still valid when in fact nothing is known about which model produced the numbers.
  const { rig: harness, readRows, restore } = rig({});
  try {
    const session = fakeSession();
    const { agent } = fakeAgent(session);

    await emitEvents(harness, session, toolPair({ name: 'edit', args: { file_path: 'a.js' } }));
    await emitEvents(harness, session, [claim('Done.')]);
    await harness.emit('agent/turn-stopping', { agent, turn: 1, signal: undefined });

    const row = readRows()[0];
    assert.equal(row.jev.model, null, 'an unnamed model must stay null, not become the alias');
    assert.equal(row.jev.model_requested, 'jev-latest');
    // Every new row carries its question set, so rows can be grouped safely even if a
    // `PROMPT_VERSION` bump is forgotten later.
    assert.equal(row.question_set_hash, QUESTION_SET_HASH);
    assert.equal(row.question_set_v, row.prompt_v);

    const text = await harness.tools.get('completion_supervisor_status').execute();
    assert.match(text, /last response came from model: \(the response did not name one\)/);
  } finally {
    restore();
  }
});

test('when the response names a version, the status reports that concrete id', async () => {
  const { rig: harness, readRows, restore } = rig({
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({ ...jevBody(), model: 'jev-2026-01-15' });
      },
    }),
  });
  try {
    const session = fakeSession();
    const { agent } = fakeAgent(session);

    await emitEvents(harness, session, toolPair({ name: 'edit', args: { file_path: 'a.js' } }));
    await emitEvents(harness, session, [claim('Done.')]);
    await harness.emit('agent/turn-stopping', { agent, turn: 1, signal: undefined });

    assert.equal(readRows()[0].jev.model, 'jev-2026-01-15');

    // The point of putting it in the status tool: "which model is behind jev-latest?"
    // must be answerable immediately, because the answer decides whether a threshold
    // derived last week is still valid.
    const text = await harness.tools.get('completion_supervisor_status').execute();
    assert.match(text, /last response came from model: jev-2026-01-15/);
    assert.match(text, /jev model requested: jev-latest/);
  } finally {
    restore();
  }
});

test('the request carries all seven questions in one call, plus the facts', async () => {
  const { rig: harness, calls, restore } = rig({});
  try {
    const session = fakeSession();
    const { agent } = fakeAgent(session);

    await emitEvents(harness, session, toolPair({ name: 'pwsh', args: { command: 'npm test' }, text: 'ok' }));
    await emitEvents(harness, session, [claim('Tests pass.')]);
    await harness.emit('agent/turn-stopping', { agent, turn: 1, signal: undefined });

    assert.equal(calls.length, 1, 'exactly one request per assessment');
    const { url, body } = calls[0];
    assert.match(url, /api\.typesafe\.ai\/v1\/systemone$/);
    assert.deepEqual(Object.keys(body.questions).sort(), [...JEV_QUESTION_NAMES].sort());
    // The state carries the deterministic facts Jev is meant to judge.
    assert.equal(body.state.evidence.tests_run, true);
    assert.equal(body.state.evidence.tests_passed, true);
    assert.ok(Array.isArray(body.state.repo.changed_files));
    assert.equal(typeof body.state.task_v, 'number');
    assert.equal(typeof body.state.goal, 'string');
  } finally {
    restore();
  }
});

test('a write-only turn reaches Jev with its artifact, even when git cannot answer', async () => {
  // The end-to-end version of the v3 change, in the configuration that motivated it: the working
  // directory is NOT a repository (`shellThrows` makes the git probe fail), so the repository
  // facts are empty. Before v3 that was the entire evidence base for "what did this turn
  // produce", and Jev answered `requirements_satisfied` low enough to block turns that had done
  // exactly what was asked.
  const { rig: harness, calls, readRows, restore } = rig({ shellThrows: true });
  try {
    const session = fakeSession('sess-artifact', 'C:/repo');
    const { agent } = fakeAgent(session);

    await emitEvents(
      harness,
      session,
      toolPair({
        name: 'write',
        args: { content: 'three lines\n', file_path: 'C:/repo/scratch/note.md' },
        text: 'File created successfully.',
      }),
    );
    await emitEvents(harness, session, [claim('Created scratch/note.md.')]);
    await harness.emit('agent/turn-stopping', { agent, turn: 1, signal: undefined });

    const { state } = calls[0].body;
    assert.equal(state.repo.available, false, 'this fixture must have no repository, or it proves nothing');
    assert.deepEqual(state.repo.changed_files, []);
    assert.deepEqual(
      state.activity.created_or_written_paths,
      ['scratch/note.md'],
      'the produced path must reach Jev beside the empty repository facts',
    );
    assert.equal(state.task_v, 4);

    // And the log carries it in full, so an offline reader does not conclude from
    // `changed_files_n: 0` that the turn produced nothing.
    const row = readRows()[0];
    assert.equal(row.task_v, 4);
    assert.equal(row.fingerprint_v, 3);
    assert.deepEqual(row.facts.created_or_written_paths, ['scratch/note.md']);
    assert.deepEqual(row.facts.verified_artifacts.map((entry) => entry.path), ['scratch/note.md']);
    assert.deepEqual(row.facts.material_actions, [
      { tool: 'write', verb: 'wrote', path: 'scratch/note.md', ok: true },
    ]);
  } finally {
    restore();
  }
});

// ── ground truth backfill ────────────────────────────────────────────────────

test('the user follow-up is backfilled as an outcome row', async () => {
  const { rig: harness, readRows, restore } = rig({ config: { shadowMode: false } });
  try {
    const session = fakeSession();
    const { agent } = fakeAgent(session);

    await emitEvents(harness, session, toolPair({ name: 'pwsh', args: { command: 'npm test' }, text: 'ok' }));
    await emitEvents(harness, session, [claim('Done; tests pass.')]);
    await harness.emit('agent/turn-stopping', { agent, turn: 1, signal: undefined });

    // The user comes back because it does not work: a false pass.
    await harness.emit('session/event', session, userMessage('that still does not work'));

    const rows = readRows();
    const outcomes = rows.filter((row) => row.row === 'outcome');
    assert.equal(outcomes.length, 1, 'the follow-up must be recorded as an outcome');

    const assessment = rows.find((row) => row.row === 'assessment');
    assert.equal(outcomes[0].assessment_id, assessment.assessment_id, 'linked by id');
    assert.equal(outcomes[0].ground_truth.verdict, 'false_pass');
    assert.equal(outcomes[0].ground_truth.followup_kind, 'user_reported_problem');
  } finally {
    restore();
  }
});

test('our own steered message is not mistaken for a user follow-up', async () => {
  const { rig: harness, readRows, restore } = rig({ config: { shadowMode: false } });
  try {
    const session = fakeSession();
    const { agent } = fakeAgent(session);

    await emitEvents(harness, session, toolPair({ name: 'edit', args: { file_path: 'a.js' } }));
    await emitEvents(harness, session, [claim('All tests pass.')]);
    await harness.emit('agent/turn-stopping', { agent, turn: 1, signal: undefined });

    const assessment = readRows().find((row) => row.row === 'assessment');
    assert.ok(assessment, 'the assessment row should exist');

    // Feeding our own plugin-sourced message back must produce no outcome row:
    // otherwise every intervention would be logged as the user complaining.
    await harness.emit('session/event', session, {
      type: 'user/message',
      data: {
        role: 'user',
        content: [{ type: 'text', text: '[Completion check] ...' }],
        source: { kind: 'plugin', plugin: 'completion-supervisor' },
      },
    });

    assert.equal(readRows().filter((row) => row.row === 'outcome').length, 0);
  } finally {
    restore();
  }
});

// ── the fingerprint skip, verified from the log ──────────────────────────────

test('the same material state stopping twice skips the second assessment and logs why', async () => {
  // Requested behaviour, and previously unverifiable: skips only touched in-memory
  // counters, so the log could not answer "did the rule fire, and what did it
  // suppress?". A rule whose rejections are invisible is a rule that cannot be
  // evaluated — which is the whole point of a shadow phase.
  //
  // HOW THIS SITUATION ACTUALLY ARISES (worth being precise about): in shadow mode
  // the loop reaches `agent/turn-stopping` once per turn and then breaks, so the
  // same turn cannot stop twice unless something steered it. The realistic case is
  // therefore a SECOND turn within the same user task that produced the same
  // evidence — the agent re-ran the same command and made the same claim without
  // changing anything. That is what this test builds: identical facts, different
  // turn number.
  const { rig: harness, calls, readRows, restore } = rig({});
  try {
    const session = fakeSession();
    const { agent } = fakeAgent(session);

    const sameWork = (turn) =>
      toolPair({ callId: `c${turn}`, name: 'edit', args: { file_path: 'a.js' }, turn });

    await emitEvents(harness, session, sameWork(1));
    await emitEvents(harness, session, [claim('Done. All tests pass.')]);
    await harness.emit('agent/turn-stopping', { agent, turn: 1, signal: undefined });
    assert.equal(calls.length, 1, 'the first stopping must be assessed');

    // Turn 2: the same edit to the same file and the same claim. Nothing material
    // moved — only the turn number and the wall clock.
    await emitEvents(harness, session, sameWork(2));
    await emitEvents(harness, session, [claim('Done. All tests pass.', 2)]);
    await harness.emit('agent/turn-stopping', { agent, turn: 2, signal: undefined });

    assert.equal(calls.length, 1, 'identical facts must not produce a second Jev call');

    const rows = readRows();
    const assessments = rows.filter((row) => row.row === 'assessment');
    const skips = rows.filter((row) => row.row === 'skip');
    assert.equal(assessments.length, 1);
    assert.equal(skips.length, 1, 'the skip must be on disk, not only in memory');
    assert.equal(skips[0].reason, 'no_material_change');
    assert.equal(skips[0].turn, 2);
    // The skip row carries the counters, so a later reading can check that the
    // suppressed assessment was not the one that mattered.
    assert.equal(skips[0].assessments_used, 1, 'the skip must not consume budget');
    assert.equal(skips[0].tool_calls_total, 1);
  } finally {
    restore();
  }
});

test('a material change re-assesses, so the skip rule is not over-firing', async () => {
  const { rig: harness, calls, readRows, restore } = rig({});
  try {
    const session = fakeSession();
    const { agent } = fakeAgent(session);

    await emitEvents(harness, session, toolPair({ name: 'edit', args: { file_path: 'a.js' } }));
    await emitEvents(harness, session, [claim('Done.')]);
    await harness.emit('agent/turn-stopping', { agent, turn: 1, signal: undefined });
    assert.equal(calls.length, 1);

    // The same turn continues and the agent runs the tests: the evidence really did
    // change, so this MUST be assessed rather than skipped.
    await emitEvents(
      harness,
      session,
      toolPair({ callId: 'c2', name: 'pwsh', args: { command: 'npm test' }, text: 'pass\n', turn: 2 }),
    );
    await emitEvents(harness, session, [claim('Tests pass.', 2)]);
    await harness.emit('agent/turn-stopping', { agent, turn: 2, signal: undefined });

    assert.equal(calls.length, 2, 'a changed state must be assessed again');
    const skips = readRows().filter((row) => row.row === 'skip');
    assert.equal(skips.length, 0, 'nothing should have been skipped');
  } finally {
    restore();
  }
});

// ── the per-task budget ─────────────────────────────────────────────────────

test('a new user message resets the assessment budget', async () => {
  // The budget is per USER TASK, not per session. Without the reset, the very first
  // question in a long session would consume the allowance permanently and every
  // later turn would be silently unsupervised.
  const { rig: harness, calls, readRows, restore } = rig({ config: { maxAssessments: 1 } });
  try {
    const session = fakeSession();
    const { agent } = fakeAgent(session);

    // Task 1: exhaust the entire budget (which is 1).
    await emitEvents(harness, session, toolPair({ name: 'edit', args: { file_path: 'a.js' } }));
    await emitEvents(harness, session, [claim('Done with the first thing.')]);
    await harness.emit('agent/turn-stopping', { agent, turn: 1, signal: undefined });
    assert.equal(calls.length, 1);

    // Still task 1, and the budget is spent.
    await emitEvents(
      harness,
      session,
      toolPair({ callId: 'c2', name: 'pwsh', args: { command: 'npm test' }, text: 'pass\n', turn: 2 }),
    );
    await emitEvents(harness, session, [claim('Tests pass.', 2)]);
    await harness.emit('agent/turn-stopping', { agent, turn: 2, signal: undefined });
    assert.equal(calls.length, 1, 'the budget must hold within one task');
    assert.ok(readRows().some((row) => row.row === 'skip' && row.reason === 'budget_exhausted'));

    // Task 2: a NEW user message. The budget resets, so this turn is supervised even
    // though the previous task used everything it had.
    await emitEvents(harness, session, [
      { type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: 'Now do a different thing entirely.' }], source: { kind: 'user' } } },
    ]);
    await emitEvents(harness, session, toolPair({ callId: 'c3', name: 'edit', args: { file_path: 'b.js' }, turn: 3 }));
    await emitEvents(harness, session, [claim('Second thing done.', 3)]);
    await harness.emit('agent/turn-stopping', { agent, turn: 3, signal: undefined });

    assert.equal(calls.length, 2, 'a new user task must get a fresh budget');
    const rows = readRows();
    const taskKeys = new Set(rows.filter((r) => r.row === 'skip').map((r) => r.task_key));
    assert.ok(taskKeys.size >= 1, 'skip rows must carry the task key they belonged to');
  } finally {
    restore();
  }
});

test('an assessment row records which task it was charged to, and what the budget compared', async () => {
  // WHY THIS IS A TEST AND NOT JUST A FIELD: the per-task budget claim was, until
  // now, only checkable from the skip rows — and a task that never tripped a rule
  // writes no skip row at all. So "3 assessments across 3 tasks" (the reset working)
  // and "3 assessments in 1 task" (the ceiling working) produced the same row count
  // and the same absence of evidence. Attribution on the assessment row is what
  // separates them.
  const { rig: harness, calls, readRows, restore } = rig({ config: { maxAssessments: 3 } });
  try {
    const session = fakeSession();
    const { agent } = fakeAgent(session);

    // The user message that opens task 1. Without it there is no task to charge an
    // assessment to, and the attribution would be null rather than a key — the
    // field would be present but prove nothing.
    await emitEvents(harness, session, [
      { type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: 'Fix the first thing.' }], source: { kind: 'user' } } },
    ]);

    // Task 1, two assessments: an edit, then the tests it ran.
    await emitEvents(harness, session, toolPair({ name: 'edit', args: { file_path: 'a.js' } }));
    await emitEvents(harness, session, [claim('Done.')]);
    await harness.emit('agent/turn-stopping', { agent, turn: 1, signal: undefined });

    await emitEvents(
      harness,
      session,
      toolPair({ callId: 'c2', name: 'pwsh', args: { command: 'npm test' }, text: 'ok\n', turn: 2 }),
    );
    await emitEvents(harness, session, [claim('Tests pass.', 2)]);
    await harness.emit('agent/turn-stopping', { agent, turn: 2, signal: undefined });

    // Task 2: a new user message, then one more assessment.
    await emitEvents(harness, session, [
      { type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: 'Something else now.' }], source: { kind: 'user' } } },
    ]);
    await emitEvents(harness, session, toolPair({ callId: 'c3', name: 'edit', args: { file_path: 'b.js' }, turn: 3 }));
    await emitEvents(harness, session, [claim('Second done.', 3)]);
    await harness.emit('agent/turn-stopping', { agent, turn: 3, signal: undefined });

    assert.equal(calls.length, 3, 'all three turns carry new material facts');

    const rows = readRows().filter((row) => row.row === 'assessment');
    assert.equal(rows.length, 3);
    for (const row of rows) {
      assert.equal(typeof row.task_key, 'string', 'every assessment records its task');
      assert.ok(row.task_key.length > 0);
      assert.equal(typeof row.assessments_used_before, 'number');
      assert.equal(row.max_assessments, 3);
    }

    // The two turns of task 1 share a key and count up from zero: 0, then 1. That
    // sequence is the budget actually being spent, visible without a skip row.
    assert.equal(rows[0].assessments_used_before, 0, 'the first assessment of a task starts the count');
    assert.equal(rows[1].assessments_used_before, 1, 'the second must see the first');
    assert.equal(rows[0].task_key, rows[1].task_key, 'both belong to the same user task');

    // The third belongs to a DIFFERENT task and its counter restarted, which is the
    // reset showing up in the data rather than in a rule name.
    assert.notEqual(rows[2].task_key, rows[0].task_key, 'a new user message must open a new task key');
    assert.equal(rows[2].assessments_used_before, 0, 'the new task gets a fresh budget');
  } finally {
    restore();
  }
});

// ── the key must never reach a log row ───────────────────────────────────────

test('an API error that echoes the key does not put the key in the log', async () => {
  // THE REALISTIC LEAK, reproduced end to end. `parseJevResponse` embeds up to 200
  // characters of an HTTP error body into the thrown message, and that message is
  // written to the row AND passed to `ctx.logger.warn`. An API that quotes the header
  // it rejected therefore puts the key into both sinks — not because anyone chose to
  // log it, but because an error string carried it there.
  //
  // No real endpoint needed: the fetch stub stands in for the API.
  const KEY = 'apikey_0123456789abcdef0123456789abcdef_deadbeefdeadbeef';
  const { rig: harness, logPath, readRows, restore } = rig({
    apiKey: KEY,
    fetchImpl: async () => ({
      ok: false,
      status: 401,
      async text() {
        return JSON.stringify({ error: 'invalid token', received: `Bearer ${KEY}` });
      },
    }),
  });
  try {
    const session = fakeSession();
    const { agent, steered } = fakeAgent(session);

    await emitEvents(harness, session, toolPair({ name: 'edit', args: { file_path: 'a.js' } }));
    await emitEvents(harness, session, [claim('Done.')]);
    await harness.emit('agent/turn-stopping', { agent, turn: 1, signal: undefined });

    // The failure still fails open, and is still recorded as a failure.
    assert.equal(steered.length, 0, 'an API error must never steer');
    const rows = readRows();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].jev_error.kind, 'http');

    // The row is written to disk, so check the RAW text rather than the parsed object:
    // a key hidden in a field the assertions do not name would still be a leak.
    const raw = readFileSync(logPath, 'utf8');
    assert.ok(!raw.includes(KEY), 'the key must not appear anywhere in the log file');
    assert.ok(raw.includes('[redacted-key]'), 'and the redaction must be visible, not silent');
    // The rest of the error must SURVIVE: over-redacting would hide the diagnosis.
    assert.match(raw, /invalid token/);

    // Every logger line is a second sink, and it is the one that is easy to forget.
    for (const line of harness.logs.warn) {
      assert.ok(!line.includes(KEY), `a logger line leaked the key: ${line.slice(0, 80)}`);
    }
    for (const line of harness.logs.info) {
      assert.ok(!line.includes(KEY), `a logger line leaked the key: ${line.slice(0, 80)}`);
    }
  } finally {
    restore();
  }
});

