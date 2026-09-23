/**
 * Completion Supervisor — git evidence collection.
 *
 * Three read-only git commands, run concurrently, each independently timed out
 * and independently allowed to fail. A repository fact that cannot be read
 * becomes `null` rather than aborting the assessment: a missing diff is a weaker
 * signal, not a reason to skip supervision entirely.
 *
 * WHY NOT A FULL DIFF
 * -------------------
 * Foreman sends Jev up to 20,000 characters of `git diff`. For its question set
 * that is justified — it needs to judge whether work is drifting off-track.
 * Ours is narrower: "is the user's request satisfied?" A file list plus insertion
 * and deletion counts carries almost all of the signal at a fraction of the
 * tokens, and tokens are the binding constraint on how much state we can send.
 * If a future question genuinely needs the diff text, add a bounded stage to
 * `fitState` rather than inflating the default state.
 *
 * SANDBOX NOTE
 * ------------
 * `ctx.shell.run` requires a `sandboxPolicy` in its spec — `dsh-pwsh-local`'s
 * `resolve()` has no default for it. We obtain it the way the real shell tools do
 * (`dsh-tool-pwsh/lib/index.js:194,199`: `ctx.get("sandboxPolicy")?.resolve({session})`).
 * Running every command through `ctx.shell.run(ctx.shell.resolve({...}))` also
 * means we inherit whatever sandbox semantics the deployment has mounted instead
 * of inventing our own.
 */

/** Per-command timeout. Short: this runs while a turn is trying to close. */
const GIT_TIMEOUT_MS = 5000;

/** Cap on captured stdout per command. */
const GIT_MAX_BYTES = 65536;

/**
 * Run one read-only command and return its trimmed output, or null on any failure.
 * @param {object} ctx
 * @param {object} agent
 * @param {string} command
 * @param {string} cwd
 * @param {AbortSignal|undefined} signal
 * @returns {Promise<string|null>}
 */
async function runGit(ctx, agent, command, cwd, signal) {
  const spec = {
    command,
    workdir: cwd,
    timeoutMs: GIT_TIMEOUT_MS,
    stdoutMaxBytes: GIT_MAX_BYTES,
    ...(signal === undefined ? {} : { signal }),
  };

  try {
    const sandboxPolicy = ctx.get('sandboxPolicy')?.resolve(
      agent === undefined ? {} : { session: agent.session },
    );
    const resolved = ctx.shell.resolve(
      sandboxPolicy === undefined ? spec : { ...spec, sandboxPolicy },
    );
    const outcome = await ctx.shell.run(resolved);
    if (outcome?.exitCode !== 0) return null;
    const text = outcome?.stdout?.text;
    return typeof text === 'string' ? text : '';
  } catch {
    // Any failure — sandbox denial, missing git, timeout, abort — degrades this
    // one fact to null. The assessment continues without it.
    return null;
  }
}

/**
 * Parse `git status --porcelain` into changed files plus untracked files.
 *
 * Porcelain format is `XY <path>`; `??` means untracked. We keep the two sets
 * separate because untracked files are a distinct signal — a newly created file
 * the agent forgot to add is a common way for work to be silently incomplete.
 *
 * @param {string|null} text
 * @returns {{changed: string[], untracked: string[]}}
 */
export function parseStatus(text) {
  if (typeof text !== 'string' || text.length === 0) return { changed: [], untracked: [] };
  const changed = [];
  const untracked = [];
  for (const raw of text.split('\n')) {
    if (raw.length < 4) continue;
    const code = raw.slice(0, 2);
    // The path begins after the two status columns and one space. Renames use
    // "old -> new"; keep the new path, which is what exists on disk.
    let path = raw.slice(3).trim();
    const arrow = path.indexOf(' -> ');
    if (arrow !== -1) path = path.slice(arrow + 4).trim();
    path = path.replace(/^"(.*)"$/, '$1');
    if (path.length === 0) continue;
    if (code === '??') untracked.push(path);
    else changed.push(path);
  }
  return { changed, untracked };
}

/**
 * Parse `git diff --shortstat` output, e.g.
 * " 3 files changed, 120 insertions(+), 8 deletions(-)".
 * @param {string|null} text
 * @returns {{insertions: number|null, deletions: number|null}}
 */
export function parseShortstat(text) {
  if (typeof text !== 'string' || text.trim().length === 0) {
    return { insertions: null, deletions: null };
  }
  const insertions = /(\d+)\s+insertions?\(\+\)/.exec(text);
  const deletions = /(\d+)\s+deletions?\(-\)/.exec(text);
  return {
    insertions: insertions === null ? 0 : Number(insertions[1]),
    deletions: deletions === null ? 0 : Number(deletions[1]),
  };
}

/**
 * Collect repository facts concurrently.
 *
 * @param {object} ctx - the plugin context (needs `shell` and `sandboxPolicy`).
 * @param {object} agent
 * @param {string} cwd
 * @param {AbortSignal|undefined} signal
 * @returns {Promise<{changed_files: string[], untracked: string[], insertions: number|null, deletions: number|null, available: boolean}>}
 */
export async function collectGitFacts(ctx, agent, cwd, signal) {
  const [statusText, statText] = await Promise.all([
    runGit(ctx, agent, 'git status --porcelain', cwd, signal),
    runGit(ctx, agent, 'git diff --shortstat HEAD', cwd, signal),
  ]);

  const { changed, untracked } = parseStatus(statusText);
  const { insertions, deletions } = parseShortstat(statText);

  return {
    changed_files: changed,
    untracked,
    insertions,
    deletions,
    // Whether we could talk to git at all. Recorded because "no files changed"
    // and "git was unreachable" must never look the same to a reader.
    available: statusText !== null,
  };
}
