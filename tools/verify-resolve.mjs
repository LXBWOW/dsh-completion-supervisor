// Temporary diagnostic: verify DSH can resolve and load the supervisor bundle
// using DSH's OWN resolution code paths (not a reimplementation).
import { createRequire } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const APP = 'C:/Program Files/DSH Desktop/resources/app'
const INSTALL_ANCHOR = join(APP, 'package.json')
const PROFILE_DIR = 'C:/Users/lxb-tuf/.dsh/profiles/desktop'

// --- 1. reimplement resolveBundleDir exactly as dsh-app-boot does -----------
const anchors = [INSTALL_ANCHOR, join(PROFILE_DIR, 'package.json')]

function resolveBundleDir(packageName) {
  for (const anchor of anchors) {
    const paths = createRequire(anchor).resolve.paths(packageName) ?? []
    for (const searchPath of paths) {
      const candidate = join(searchPath, packageName)
      if (existsSync(join(candidate, 'package.json'))) return candidate
    }
  }
  return undefined
}

for (const name of [
  'dsh-completion-supervisor',
  'dsh-agent-mailbox',
  '@deepseek-ai/dsh-base',
]) {
  const dir = resolveBundleDir(name)
  if (dir === undefined) {
    console.log(`RESOLVE FAIL  ${name}`)
    continue
  }
  const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  const declared = manifest.dsh?.bundle?.patch
  console.log(`RESOLVE OK    ${name}`)
  console.log(`  dir          ${dir}`)
  console.log(`  bundle.patch ${declared}`)
  if (declared === undefined) console.log('  !! FAILS LOUD: declares no dsh.bundle')
  else
    console.log(
      `  patch file   ${existsSync(join(dir, declared)) ? 'exists' : 'MISSING'}`,
    )
}

// --- 2. drive DSH's real loadProfile ---------------------------------------
console.log('\n--- DSH loadProfile (real code) ---')
try {
  const bootUrl =
    'file:///' +
    join(APP, 'node_modules/@deepseek-ai/dsh-app-boot/lib/index.js').replace(
      /\\/g,
      '/',
    )
  const boot = await import(bootUrl)
  const profile = boot.loadProfile('dsh', 'desktop', INSTALL_ANCHOR)
  console.log('profile.dir    ', profile.dir)
  console.log('patchReload    ', profile.patchReload)
  console.log('layer count    ', profile.layers.length)

  const target = profile.layers.find(
    (l) => l.packageName === 'dsh-completion-supervisor',
  )
  if (target === undefined) {
    console.log('!! supervisor is NOT in the loaded layers')
  } else {
    console.log('supervisor layer:')
    console.log('  packageDir   ', target.packageDir)
    console.log('  patchPath    ', target.patchPath)
    console.log('  patches      ', JSON.stringify(target.patches))
  }

  const entries = boot.composeEntries([
    ...profile.layers.flatMap((l) => l.patches),
    ...profile.patches,
  ])
  console.log('\ncomposed entry count', entries.length)
  const row = entries.find((e) => e.id === 'completion-supervisor')
  console.log('composed row:', JSON.stringify(row, null, 2))
} catch (error) {
  console.log('EXCEPTION:', error?.message ?? String(error))
}
