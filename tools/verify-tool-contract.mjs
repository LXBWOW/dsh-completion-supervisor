// Temporary diagnostic #3: load REAL dsh-tools and validate EVERY tool this plugin
// registers against the real schema checker + register() contract.
//
// What this closes: the stub ctx in probe #2 accepted anything. The real
// `register()` (dsh-tools/lib/index.js:2769-2778) enforces output.render,
// assertSupportedJsonSchema(output.schema), a positive timeoutMs, and the
// reserved `run_code` name. A definition that violates any of them throws AT LOAD
// TIME, which in DSH means the plugin fails to mount.
//
// It captures ALL registered tools, not just the first: the supported-schema
// subset is narrow (type/oneOf/properties/required/additionalProperties/items/
// enum/const plus annotations — `minimum`/`maximum` are rejected outright), so a
// second tool is a second chance to fail at load, and the health tool's `limit`
// parameter is exactly the kind of thing that invites an unsupported keyword.
import { join } from 'node:path'
import { createRequire } from 'node:module'

const APP = 'C:/Program Files/DSH Desktop/resources/app'
const req = createRequire(join(APP, 'package.json'))

let failures = 0
function check(label, ok, detail) {
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${label}${detail === undefined ? '' : `  — ${detail}`}`,
  )
  if (!ok) failures += 1
}

// Load real dsh-tools.
const toolsUrl =
  'file:///' + req.resolve('@deepseek-ai/dsh-tools').replace(/\\/g, '/')
const tools = await import(toolsUrl)
console.log('dsh-tools exports:', Object.keys(tools).sort().join(', '))

// Pull the schema assertion (exported or not, it must exist in the module graph).
const assertSchema =
  tools.assertSupportedJsonSchema ?? tools.assertObjectJsonSchema
check(
  'found a real schema assertion to run',
  typeof assertSchema === 'function',
  typeof assertSchema,
)

// --- rebuild the exact tool definitions the plugin registers ----------------
// NOTE: resolve the PLUGIN from the profile dir, not from the app dir — the app's
// package.json knows nothing about profile-local bundles.
const profileReq = createRequire(
  'C:/Users/lxb-tuf/.dsh/profiles/desktop/package.json',
)
const pluginMod = await import(
  'file:///' +
    profileReq.resolve('dsh-completion-supervisor').replace(/\\/g, '/')
)

// Capture the definitions by driving apply() with a ctx whose tools.register just
// records. (Same trick as probe #2, but now the recorded objects are checked
// against the REAL validator rather than eyeballed.)
const registered = []
const registeredCommands = []
const stubCtx = {
  logger: { info() {}, warn() {} },
  on: () => () => {},
  inject(deps, cb) {
    // Only what was asked for. The commands service is optional in a real deployment, and this stub
    // has to be able to model its absence rather than always handing back everything.
    const scope = {}
    if (deps.includes('tools')) scope.tools = { register: (def) => { registered.push(def) } }
    if (deps.includes('commands')) scope.commands = { register: (def) => { registeredCommands.push(def) } }
    cb(scope)
  },
}
pluginMod.apply(stubCtx, { logEnabled: false, shadowMode: true })

check('plugin registered a tool', registered.length > 0, `${registered.length} tool(s)`)
console.log('    registered:', registered.map((d) => d.name).join(', '))

for (const definition of registered) {
  const label = definition.name
  console.log(`\n--- ${label} ---`)
  check(`${label}: name present`, typeof definition.name === 'string', definition.name)
  check(`${label}: name is not the reserved run_code`, definition.name !== 'run_code')
  check(
    `${label}: description present`,
    typeof definition.description === 'string' && definition.description.length > 0,
    `${definition.description?.length ?? 0} chars`,
  )
  check(`${label}: execute is a function`, typeof definition.execute === 'function')
  check(`${label}: output.render is a function`, typeof definition.output?.render === 'function')

  // output.schema AND parameters both pass through the real checker inside register().
  for (const [what, schema] of [
    ['output.schema', definition.output?.schema],
    ['parameters', definition.parameters],
  ]) {
    if (schema === undefined) {
      check(`${label}: ${what} present`, false)
      continue
    }
    try {
      assertSchema(schema)
      check(`${label}: ${what} passes the REAL schema validator`, true)
    } catch (error) {
      check(
        `${label}: ${what} passes the REAL schema validator`,
        false,
        String(error?.message ?? error),
      )
    }
  }

  // render() must return the block shape the harness expects.
  try {
    const rendered = definition.output.render({}, 'HELLO')
    check(
      `${label}: render() returns [{type:"text", text}]`,
      Array.isArray(rendered) && rendered[0]?.type === 'text' && typeof rendered[0]?.text === 'string',
      JSON.stringify(rendered)?.slice(0, 80),
    )
  } catch (error) {
    check(`${label}: render() returns an array of blocks`, false, String(error?.message ?? error))
  }

  // execute() must work with no args and with the documented argument shape.
  for (const args of [undefined, {}, { limit: 5 }]) {
    try {
      const value = await definition.execute(args)
      check(
        `${label}: execute(${JSON.stringify(args)}) returns a string`,
        typeof value === 'string',
        `${typeof value === 'string' ? value.split('\n').length : '?'} lines`,
      )
      if (args?.limit === 5 && typeof value === 'string') {
        console.log('    --- output ---')
        for (const line of value.split('\n')) console.log(`    ${line}`)
      }
    } catch (error) {
      check(
        `${label}: execute(${JSON.stringify(args)}) returns a string`,
        false,
        String(error?.message ?? error),
      )
    }
  }
}

// The health tool must actually be there: it is the operator's only window on the log.
check(
  'the read-only health tool is registered',
  registered.some((d) => d.name === 'completion_supervisor_health'),
)

// And it must not be able to act: no writing, no model. Asserted on the definition
// rather than trusted, because "read-only" is a claim this tool makes about itself.
const health = registered.find((d) => d.name === 'completion_supervisor_health')
if (health !== undefined) {
  const text = await health.execute({ limit: 5 })
  check(
    'health: reports a verdict',
    typeof text === 'string' && /^Health: (OK|CHECK|UNAVAILABLE)$/m.test(text),
    text.split('\n').find((l) => l.startsWith('Health:')),
  )
  check(
    'health: never claims a steer was a false positive',
    !/false_positive|false positive/i.test(text),
  )
}

// --- the slash command, checked against its REAL contract ---------------------
//
// `normalizeDefinition` in dsh-commands/lib/index.js:142 rejects a definition outright for a name
// outside /^[a-z][a-z0-9_-]*$/, a non-string or empty description, a non-function handler, or an
// `input.hint` that is missing/blank. That rejection happens inside `register()`, so a bad command
// definition fails the plugin at load time exactly like a bad tool schema — which is why the rules
// are asserted here rather than assumed.
console.log('\n--- /supervisor command ---')
check('the slash command is registered', registeredCommands.length === 1, `${registeredCommands.length}`)
const command = registeredCommands[0]
if (command !== undefined) {
  check(
    'command: name matches the runtime pattern',
    typeof command.name === 'string' && /^[a-z][a-z0-9_-]*$/.test(command.name),
    command.name,
  )
  check(
    'command: description is non-empty',
    typeof command.description === 'string' && command.description.trim().length > 0,
    command.description,
  )
  check('command: handler is a function', typeof command.handler === 'function')
  check(
    'command: input.hint is a non-empty string',
    command.input !== undefined &&
      typeof command.input.hint === 'string' &&
      command.input.hint.trim().length > 0,
    command.input?.hint,
  )

  const plain = await command.handler({ rawInput: '' })
  check(
    'command: bare invocation returns a success result',
    plain?.kind === 'success' && typeof plain.text === 'string',
    plain?.kind,
  )
  check(
    'command: the result carries the verdict',
    /^Health: (OK|CHECK|UNAVAILABLE)$/m.test(plain?.text ?? ''),
    (plain?.text ?? '').split('\n').find((l) => l.startsWith('Health:')),
  )
  check(
    'command: never claims a steer was a false positive',
    !/false_positive|false positive/i.test(plain?.text ?? ''),
  )

  const limited = await command.handler({ rawInput: '5' })
  check(
    'command: an integer argument sets the window',
    limited?.kind === 'success' && /Last 5 assessments/.test(limited.text ?? ''),
    (limited?.text ?? '').split('\n').find((l) => l.startsWith('Last ')),
  )

  const bad = await command.handler({ rawInput: 'nonsense' })
  check(
    'command: a non-numeric argument is an error result naming the usage',
    bad?.kind === 'error' && /Usage: \/supervisor/.test(bad.text ?? ''),
    bad?.text?.split('\n')[0],
  )
}

console.log(
  `\n=== ${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'} ===`,
)
process.exitCode = failures === 0 ? 0 : 1
