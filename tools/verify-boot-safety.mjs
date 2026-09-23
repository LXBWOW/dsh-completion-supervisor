// Temporary diagnostic #2b: boot-safety checks that would otherwise only fail
// when DSH restarts with the plugin mounted.
//
// Correction vs the first attempt: `shell` / `sandboxPolicy` / `sessionProjections`
// are Cordis SERVICE names, not profile entry names. They are provided by packages
// mounted INSIDE @deepseek-ai/dsh-base (dsh-shell/lib/index.js:86 declares
// `super(ctx, "shell")`; dsh-sandbox-policy/lib/index.js:111 declares
// `sandboxPolicy`), so searching the composed profile tree for them is the wrong
// test. What matters is that the PROVIDER PACKAGES appear in the mounted set.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'

import { resolveApiKey } from '../lib/jev.js'

const APP = 'C:/Program Files/DSH Desktop/resources/app'
const INSTALL_ANCHOR = join(APP, 'package.json')

const boot = await import(
  'file:///' +
    join(APP, 'node_modules/@deepseek-ai/dsh-app-boot/lib/index.js').replace(
      /\\/g,
      '/',
    )
)

let failures = 0
function check(label, ok, detail) {
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${label}${detail === undefined ? '' : `  — ${detail}`}`,
  )
  if (!ok) failures += 1
}

const profile = boot.loadProfile('dsh', 'desktop', INSTALL_ANCHOR)
const entries = boot.composeEntries([
  ...profile.layers.flatMap((l) => l.patches),
  ...profile.patches,
])

// --- 1. bundle-list rewrite safety -----------------------------------------
// desktopBundleList() lives in a private chunk, so exercise the CONTRACT instead
// of the symbol: required bundles first, then every third-party entry in prior
// order. Our entry must satisfy both halves.
console.log('--- 1. bundle-list rewrite safety ---')
const manifest = JSON.parse(readFileSync(join(profile.dir, 'package.json'), 'utf8'))
const current = manifest.dsh.profile.bundles
const REQUIRED = [
  '@deepseek-ai/dsh-base',
  '@deepseek-ai/dsh-web-app',
]
check('required bundles are first', REQUIRED.every((n, i) => current[i] === n))
check(
  'our entry is in the persistent list',
  current.includes('dsh-completion-supervisor'),
)
check(
  'our entry is not a required/obsolete name (survives the filter)',
  !['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@deepseek-ai/dsh-desktop-app'].includes(
    'dsh-completion-supervisor',
  ),
)
check(
  'our entry is last (no later bundle can clobber the row)',
  current[current.length - 1] === 'dsh-completion-supervisor',
  `last=${current[current.length - 1]}`,
)

// --- 2. composed tree ------------------------------------------------------
console.log('\n--- 2. composed entry tree ---')
const ids = entries.map((e) => e.id).filter((v) => typeof v === 'string')
const dupes = ids.filter((v, i) => ids.indexOf(v) !== i)
check('no duplicate entry ids', dupes.length === 0, dupes.join(', ') || 'none')
const mine = entries.filter((e) => e.name === 'dsh-completion-supervisor')
check('supervisor row present exactly once', mine.length === 1, `count=${mine.length}`)
// The composed value is a DEPLOYMENT fact, not a constant of the plugin: the plugin's own default is
// `true` (observe only), and this machine turned intervention on deliberately, which is what the
// whole rollout section of the README is about. So this asserts the field is a real boolean and
// reports which phase is composed, instead of pinning a value a legitimate config change breaks.
// It went stale exactly that way — it kept failing after intervention was switched on, for a reason
// that had nothing to do with boot safety.
const composedShadow = mine[0]?.config?.shadowMode
check(
  'supervisor shadowMode is a boolean',
  typeof composedShadow === 'boolean',
  `${String(composedShadow)} (${composedShadow === false ? 'INTERVENTION' : 'SHADOW'})`,
)

// --- 3. provider packages for every service this plugin acquires -----------
console.log('\n--- 3. provider packages in the mounted closure ---')
// The plugin calls ctx.inject(["agents"]) and ctx.inject(["tools"]), and reaches
// shell/sandboxPolicy/sessionProjections through them or optionally. Every provider
// must be present in the mounted entry list (directly or via a base sub-layer).
const names = new Set(entries.map((e) => e.name).filter(Boolean))
const layerDirs = new Set(
  profile.layers.map((l) => l.packageName),
)
// A provider mounted inside dsh-base is NOT a separate profile layer, so also
// accept it being resolvable from the install anchor.
function providerMounted(pkg) {
  if (names.has(pkg) || layerDirs.has(pkg)) return 'entry'
  try {
    createRequire(INSTALL_ANCHOR).resolve(pkg + '/package.json')
    return 'installed'
  } catch {
    return null
  }
}
for (const pkg of [
  '@deepseek-ai/dsh-agent-loop', //  agents
  '@deepseek-ai/dsh-tools', //       tools
  '@deepseek-ai/dsh-shell', //       shell
  '@deepseek-ai/dsh-sandbox-policy', // sandboxPolicy
  '@deepseek-ai/dsh-session-projection', // sessionProjections
]) {
  const how = providerMounted(pkg)
  check(`${pkg} available`, how !== null, how ?? 'MISSING')
}

// --- 4. apply() dry run on a stub ctx -------------------------------------
console.log('\n--- 4. apply() dry run on a stub ctx ---')
const req = createRequire(join(profile.dir, 'package.json'))
const mod = await import(
  'file:///' + req.resolve('dsh-completion-supervisor').replace(/\\/g, '/')
)

const registered = { events: [], tools: [], commands: [], injects: [] }
const logs = []
const stubCtx = {
  logger: {
    info: (m) => logs.push(['info', m]),
    warn: (m) => logs.push(['warn', m]),
  },
  on(name) {
    registered.events.push(name)
    return () => {}
  },
  inject(deps, cb) {
    registered.injects.push(deps.join(','))
    // Hand back ONLY the services asked for. A stub that always returns every service cannot fail
    // when the plugin reaches for one that is absent in a real deployment, which is the exact case
    // `inject = []` plus per-feature `ctx.inject` exists to survive.
    const scope = {}
    if (deps.includes('agents')) scope.agents = {}
    if (deps.includes('tools')) {
      scope.tools = {
        register(def) {
          registered.tools.push(def.name)
        },
      }
    }
    if (deps.includes('commands')) {
      scope.commands = {
        register(def) {
          registered.commands.push(def.name)
        },
      }
    }
    cb(scope)
  },
}
try {
  mod.apply(stubCtx, mine[0].config)
  check('apply() did not throw', true)
  check(
    'subscribed to session/event',
    registered.events.includes('session/event'),
    registered.events.join(', '),
  )
  check(
    'subscribed to agent/turn-stopping',
    registered.events.includes('agent/turn-stopping'),
  )
  check('acquired agents service', registered.injects.includes('agents'))
  check(
    'registered status tool',
    registered.tools.includes('completion_supervisor_status'),
  )
  check(
    'registered the /supervisor command',
    registered.commands.includes('supervisor'),
    registered.commands.join(', ') || '(none)',
  )
  const warned = logs.filter(([lvl]) => lvl === 'warn')
  // Whether a boot warning is EXPECTED depends on whether this machine has a key, which is not a
  // property of the code. "Exactly one warning" was true while the key was missing and became false
  // the moment one was installed. The invariant that actually holds either way: the plugin warns if
  // and only if it cannot find a key.
  let keyPresent = false
  try {
    keyPresent = resolveApiKey().key.length > 0
  } catch {
    keyPresent = false
  }
  check(
    'a missing key warns, and a present key does not (fail-open path)',
    keyPresent ? warned.length === 0 : warned.length === 1,
    keyPresent ? `key present, ${warned.length} warning(s)` : `no key, ${warned.length} warning(s)`,
  )
  for (const [lvl, m] of logs) console.log(`    [${lvl}] ${m}`)
} catch (error) {
  check('apply() did not throw', false, String(error?.message ?? error))
}

console.log(
  `\n=== ${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'} ===`,
)
process.exitCode = failures === 0 ? 0 : 1
