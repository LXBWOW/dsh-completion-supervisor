/**
 * Completion Supervisor — deterministic artifacts.
 *
 * THE PROBLEM THIS SOLVES
 * -----------------------
 * The supervisor tells Jev what a turn produced by sending `repo.changed_files`, which
 * comes from `git status`. On this machine the working directory is **not a git
 * repository**, so that list is empty — and a turn that created a file therefore reaches
 * Jev with no evidence of it at all. Jev is then asked whether "the repository state
 * satisfies the user's request", can see nothing, and answers low. That low answer trips
 * the P4 block rule, so every completed turn is judged unfinished.
 *
 * Measured: `requirements_satisfied` 0.26-0.48 across every real turn, and moving the
 * finish threshold from 0.70 to 0.90 changed the outcome of zero rows, because P4 returns
 * first. The evidence was missing, not the threshold wrong.
 *
 * THE RULE: RECORD WHAT THE TOOL SCHEMA SAYS, NEVER WHAT A COMMAND PROBABLY DID
 * ---------------------------------------------------------------------------
 * A path is recorded only when it arrives as a STRUCTURED tool argument:
 *
 *   write   {"content": …, "file_path": …}          -> produced
 *   edit    {"file_path": …, "old_string": …}       -> produced
 *   present {"files": [{"path": …, …}]}             -> produced
 *   read    {"file_path": …}                        -> touched (not produced)
 *
 * Everything else is deliberately ignored, and the exclusions are the point:
 *
 *   - A `pwsh` command is NOT parsed for side effects. `Invoke-WebRequest -OutFile x` and
 *     `Remove-Item x` and `npm run build` all create or destroy files, and no regex can be
 *     trusted to tell which — measured on real logs, 545 pwsh calls carried only
 *     `command/description/workdir/timeoutMs/run_in_background`, and every one of the 1375
 *     tool results was plain prose (`[text]`). Guessing here would put a fabricated
 *     artifact into the state that the whole judgement rests on, which is the same class
 *     of error as reading a wrapped exit code as a pass.
 *   - An unknown tool is ignored entirely (an ALLOW-list, like `isUserAuthored` and the
 *     user-facing block filter). A future tool that writes files is therefore silently
 *     under-reported rather than silently mis-reported, and `tools/scan-tool-schemas.mjs`
 *     exists to find it: it reports which argument names on this machine look like paths.
 *
 * WHAT `verified_artifacts` DOES AND DOES NOT MEAN
 * -----------------------------------------------
 * It means: a producing tool call for this path did not report an error. `isError` is a
 * real structured field on `tool/result` (`{type:'tool-result', toolCallId, content,
 * isError}`), so this is an observation, not an inference.
 *
 * It does NOT mean the content was checked. Hashes, signatures and existence probes are
 * exactly the things a first version cannot supply, because the tool that performs them on
 * this machine is `pwsh` and its result is prose. The field is shaped to accept
 * `sha256` / `signature` / `exists` when a structured source appears; nothing populates
 * them today, and inventing them from text would be worse than leaving them out.
 */

/** Maximum distinct paths reported per category — a bound, not a target. */
const MAX_PATHS = 12;

/** Maximum material actions recorded. */
const MAX_ACTIONS = 16;

/**
 * Tools whose arguments carry a filesystem path, and what that path means.
 *
 * Keyed by tool name with the argument to read, so the rule stays declarative and an
 * audit can see the whole allow-list at once. `produced` is the distinction that matters:
 * a read proves the agent touched a file, a write proves the turn made one.
 */
const PATH_SOURCES = Object.freeze({
  write: Object.freeze({ key: 'file_path', verb: 'wrote', produced: true }),
  edit: Object.freeze({ key: 'file_path', verb: 'edited', produced: true }),
  // `present` takes an array of {path, description}; the path is nested one level down.
  present: Object.freeze({ key: 'files', verb: 'presented', produced: true, itemKey: 'path' }),
  read: Object.freeze({ key: 'file_path', verb: 'read', produced: false }),
  read_image: Object.freeze({ key: 'file_path', verb: 'read', produced: false }),
});

/** Longest path recorded, after relativisation. Beyond this it is truncated for the log. */
const MAX_PATH_CHARS = 160;

/**
 * Read the paths a single tool call declares.
 *
 * @param {object} args - already-parsed arguments.
 * @param {object} source - the PATH_SOURCES entry.
 * @returns {string[]}
 */
function pathsFromArguments(args, source) {
  if (args === null || typeof args !== 'object') return [];
  const raw = args[source.key];
  const values = source.itemKey === undefined
    ? [raw]
    : (Array.isArray(raw) ? raw.map((item) => item?.[source.itemKey]) : []);
  const paths = [];
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (trimmed.length === 0) continue;
    paths.push(trimmed.length > MAX_PATH_CHARS ? trimmed.slice(0, MAX_PATH_CHARS) : trimmed);
  }
  return paths;
}

/**
 * Make a path relative to the session's working directory when it is inside it.
 *
 * Why this is worth doing rather than sending what the tool received: the evidence goes
 * into a prompt with a token budget, and this machine's absolute paths are ~70 characters
 * of constant prefix. `scratch/note.md` and
 * `C:\Users\lxb-tuf\Desktop\git cloud\dsh-completion-supervisor\scratch\note.md` carry the
 * same fact, and the shorter form leaves room for the facts that differ.
 *
 * Comparison is case-insensitive because Windows paths are, and a case-only mismatch would
 * otherwise leak the full absolute path instead of shortening it.
 *
 * THE BOUNDARY CHECK IS LOAD-BEARING. A plain `startsWith` is not enough: this workspace is
 * `…\dsh-completion-supervisor`, and `…\dsh-completion-supervisor-other\a.md` also starts with
 * it. Without requiring a separator after the root, that sibling's file would be reported as
 * `-other\a.md` — a path that does not exist anywhere, handed to Jev as evidence. A test
 * covers exactly that case, and it failed on the first version of this function.
 *
 * @param {string} path
 * @param {string|null} cwd
 * @returns {string}
 */
export function relativizePath(path, cwd) {
  if (typeof path !== 'string' || path.length === 0) return path;
  if (typeof cwd !== 'string' || cwd.length === 0) return path;
  const root = cwd.replace(/[\\/]+$/, '');
  if (root.length === 0) return path;
  if (path.length <= root.length) return path;
  if (path.slice(0, root.length).toLowerCase() !== root.toLowerCase()) return path;
  const boundary = path.charAt(root.length);
  if (boundary !== '\\' && boundary !== '/') return path;
  const rest = path.slice(root.length + 1);
  // An empty remainder means the path WAS the working directory; keep it as-is rather than
  // reducing it to nothing, because "" reads as "no path" and the directory is a real place.
  return rest.length > 0 ? rest : path;
}

/**
 * Deduplicate, keeping the LAST occurrence of each path.
 *
 * Last, not first, because a path edited three times is most meaningfully described by its
 * most recent operation, and because the summary is bounded: keeping the newest entries is
 * what makes the bound safe.
 *
 * @param {string[]} paths
 * @param {number} limit
 * @returns {string[]}
 */
function dedupeTail(paths, limit) {
  const seen = new Set();
  const out = [];
  for (let index = paths.length - 1; index >= 0; index -= 1) {
    const path = paths[index];
    if (seen.has(path)) continue;
    seen.add(path);
    out.push(path);
    if (out.length >= limit) return out.reverse();
  }
  return out.reverse();
}

/**
 * Derive the deterministic artifact facts for one turn.
 *
 * @param {Array<{name: string, args: unknown, ok: boolean}>} calls - the turn's tool calls,
 *   already filtered to the turn, each with its parsed arguments and whether its result
 *   reported an error.
 * @param {{cwd?: string|null}} [opts]
 * @returns {{touched_paths: string[], created_or_written_paths: string[], material_actions: object[], verified_artifacts: object[]}}
 */
export function deriveArtifacts(calls, opts = {}) {
  const cwd = typeof opts.cwd === 'string' && opts.cwd.length > 0 ? opts.cwd : null;

  const touched = [];
  const produced = [];
  const actions = [];
  const confirmed = [];

  for (const call of Array.isArray(calls) ? calls : []) {
    const name = typeof call?.name === 'string' ? call.name : '';
    const source = PATH_SOURCES[name];
    if (source === undefined) continue;
    for (const rawPath of pathsFromArguments(call?.args, source)) {
      const path = relativizePath(rawPath, cwd);
      actions.push({ tool: name, verb: source.verb, path, ok: call.ok !== false });
      if (source.produced) {
        produced.push(path);
        // Only a producing call that reported success confirms an artifact. A failed write
        // is recorded as an action but must never count as something the turn delivered.
        if (call.ok !== false) confirmed.push({ path, tool: name, ok: true });
      } else {
        touched.push(path);
      }
    }
  }

  return {
    touched_paths: dedupeTail(touched, MAX_PATHS),
    created_or_written_paths: dedupeTail(produced, MAX_PATHS),
    material_actions: actions.slice(-MAX_ACTIONS),
    verified_artifacts: dedupeVerified(confirmed, MAX_PATHS),
  };
}

/**
 * Deduplicate confirmed artifacts by path, keeping the first tool that confirmed each.
 *
 * A file written and then edited is one artifact; reporting it twice would make the state
 * look busier than the turn was.
 *
 * @param {Array<{path: string, tool: string, ok: boolean}>} entries
 * @param {number} limit
 * @returns {object[]}
 */
function dedupeVerified(entries, limit) {
  const seen = new Map();
  for (const entry of entries) {
    if (!seen.has(entry.path)) seen.set(entry.path, entry);
  }
  return [...seen.values()].slice(0, limit);
}

/**
 * A one-line-per-path rendering of the artifacts, for the steer message and for logs.
 *
 * Returns an empty array when nothing was produced, so a caller can distinguish "no
 * artifacts" from "not reported" rather than printing an empty heading.
 *
 * @param {object} artifacts
 * @returns {string[]}
 */
export function describeArtifacts(artifacts) {
  const lines = [];
  const produced = artifacts?.created_or_written_paths ?? [];
  if (produced.length > 0) {
    lines.push(`files created or written (${produced.length}): ${produced.join(', ')}`);
  }
  const confirmed = artifacts?.verified_artifacts ?? [];
  if (confirmed.length > 0) {
    lines.push(`artifacts confirmed by a successful tool call (${confirmed.length}): ${confirmed.map((entry) => entry.path).join(', ')}`);
  }
  return lines;
}
