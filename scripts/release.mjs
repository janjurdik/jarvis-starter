#!/usr/bin/env node
/**
 * Author's tool: prepares a new version for publishing. Users never need it.
 *
 *   node scripts/release.mjs <patch|minor|major|x.y.z> [--dry-run]
 *       bumps the version in package.json (and package-lock.json), adds a CHANGELOG.md section,
 *       creates updates/<version>.md for migration notes, regenerates jarvis.manifest.json and
 *       prints the git commands to publish. It never runs git itself.
 *
 *   node scripts/release.mjs --manifest-only [--version x.y.z]
 *       only regenerates jarvis.manifest.json for the files as they are now
 *       (version: the given one, else package.json)
 *
 *   node scripts/release.mjs --check
 *       exits with 1 when jarvis.manifest.json does not match the files (run it before pushing)
 *
 *   node scripts/release.mjs --manifest-for <git revision> --version x.y.z
 *       writes updates/manifests/<version>.json for an already published version that had no
 *       manifest, so installs of that version can still be merged three-way
 *
 * The manifest lists every shipped file (tracked files plus new files that are not ignored, which
 * is what `git add -A` commits) with the sha256 of its content, text files with LF line ends.
 */
import { spawnSync } from 'node:child_process'
import { MANIFEST, REPO, abs, exists, fileHash, git, isNoise, isProtected, parseArgs, parseVersion, readBuf, readJson, safeRel, writeFile } from './update/core.mjs'
import { hashFiles, manifestText, packageVersion, readManifest, shippedFiles } from './update/manifest.mjs'

const argv = process.argv.slice(2)
const values = {}
const plain = []
for (let i = 0; i < argv.length; i++) {
  const m = /^--(version|manifest-for)(?:=(.*))?$/.exec(argv[i])
  if (!m) plain.push(argv[i])
  else values[m[1]] = m[2] ?? argv[++i] ?? ''
}
const { flags, rest } = parseArgs(plain)
const dry = flags.has('dry-run')
const fail = (message) => {
  console.error(`✗ ${message}`)
  process.exit(1)
}
const write = (rel, text) => {
  if (dry) console.log(`  (dry run) would write ${rel}`)
  else writeFile(abs(rel), text)
}

async function manifestFor(version) {
  const files = hashFiles(REPO, await shippedFiles(REPO))
  return { name: readJson(abs('package.json'))?.name ?? 'jarvis-starter', version, released: new Date().toISOString(), files }
}

// ── --check ──
if (flags.has('check')) {
  const saved = readManifest(abs(MANIFEST))
  if (!saved) fail(`${MANIFEST} is missing or broken. Run: node scripts/release.mjs --manifest-only`)
  const now = await manifestFor(saved.version)
  const wrong = [...new Set([...Object.keys(saved.files), ...Object.keys(now.files)])].filter((rel) => saved.files[rel] !== now.files[rel]).sort()
  const pkg = packageVersion()
  if (pkg !== saved.version) console.error(`✗ package.json says ${pkg}, the manifest says ${saved.version}`)
  for (const rel of wrong.slice(0, 40)) console.error(`✗ ${!(rel in now.files) ? 'listed but gone' : !(rel in saved.files) ? 'not listed' : 'changed'}: ${rel}`)
  if (wrong.length || pkg !== saved.version) fail('The manifest does not match the files. Run: node scripts/release.mjs --manifest-only')
  console.log(`✓ ${MANIFEST} matches ${Object.keys(now.files).length} files of version ${saved.version}`)
  process.exit(0)
}

// ── --manifest-for <rev> ──
if ('manifest-for' in values) {
  const rev = values['manifest-for']
  const version = values.version
  if (!rev || !parseVersion(version)) fail('Usage: node scripts/release.mjs --manifest-for <git revision> --version x.y.z')
  const bin = await git()
  if (!bin) fail('git is needed for --manifest-for')
  const run = (args, opts = {}) => spawnSync(bin, args, { cwd: REPO, maxBuffer: 256 * 1024 * 1024, windowsHide: true, ...opts })
  const sha = run(['rev-parse', '--verify', `${rev}^{commit}`], { encoding: 'utf8' })
  if (sha.status !== 0) fail(`Unknown revision: ${rev}`)
  const tree = run(['ls-tree', '-r', '-z', '--name-only', rev], { encoding: 'utf8' })
  const files = {}
  for (const rel of tree.stdout.split('\0').filter(Boolean).sort()) {
    if (!safeRel(rel) || rel === MANIFEST || isProtected(rel) || isNoise(rel)) continue
    const blob = run(['show', `${rev}:${rel}`])
    if (blob.status === 0) files[rel] = fileHash(blob.stdout)
  }
  const date = run(['show', '-s', '--format=%cI', rev], { encoding: 'utf8' }).stdout.trim()
  const out = `updates/manifests/${version.replace(/^v/, '')}.json`
  write(out, manifestText({ name: readJson(abs('package.json'))?.name ?? 'jarvis-starter', version: version.replace(/^v/, ''), released: date || null, ref: sha.stdout.trim(), files }))
  console.log(`✓ ${out}: ${Object.keys(files).length} files of ${rev} (${sha.stdout.trim().slice(0, 7)})`)
  process.exit(0)
}

// ── --manifest-only ──
if (flags.has('manifest-only')) {
  const version = (values.version || packageVersion() || '').replace(/^v/, '')
  if (!parseVersion(version)) fail('No version: pass --version x.y.z')
  const manifest = await manifestFor(version)
  write(MANIFEST, manifestText(manifest))
  console.log(`✓ ${MANIFEST}: version ${version}, ${Object.keys(manifest.files).length} files`)
  if (packageVersion() !== version) console.log(`  Note: package.json still says ${packageVersion()}. Set it to ${version} and run this again, the manifest covers package.json too.`)
  process.exit(0)
}

// ── full release ──
const current = packageVersion()
if (!current) fail('package.json has no version')
const [major, minor, patch] = parseVersion(current)
const wish = rest[0]
const next = wish === 'major' ? `${major + 1}.0.0` : wish === 'minor' ? `${major}.${minor + 1}.0` : wish === 'patch' ? `${major}.${minor}.${patch + 1}` : parseVersion(wish) ? wish.replace(/^v/, '') : null
if (!next) fail('Usage: node scripts/release.mjs <patch|minor|major|x.y.z> [--dry-run]')
const today = new Date().toISOString().slice(0, 10)
console.log(`\n  Release ${current} → ${next}${dry ? '  (dry run, nothing is written)' : ''}\n`)

// package.json: only the version line changes, the formatting stays.
const pkgText = readBuf(abs('package.json')).toString('utf8')
write('package.json', pkgText.replace(/("version"\s*:\s*")[^"]+(")/, `$1${next}$2`))
const lock = readJson(abs('package-lock.json'))
if (lock) {
  lock.version = next
  if (lock.packages?.['']) lock.packages[''].version = next
  write('package-lock.json', `${JSON.stringify(lock, null, 2)}\n`)
}
console.log(`  ✓ package.json${lock ? ' and package-lock.json' : ''}: ${next}`)

// CHANGELOG.md: a new section on top, to be filled in by hand.
const logText = (readBuf(abs('CHANGELOG.md')) ?? Buffer.from('# Zoznam zmien\n\nČo je v ktorej verzii Jarvisa nové. Najnovšia verzia je hore.\n')).toString('utf8')
if (new RegExp(`^##\\s+\\[?v?${next.replace(/\./g, '\\.')}\\b`, 'm').test(logText)) {
  console.log(`  · CHANGELOG.md already has a section for ${next}`)
} else {
  const section = `## ${next} (${today})\n\n- DOPLŇ: čo je nové, jednou vetou tak, aby tomu rozumel bežný človek\n- DOPLŇ: ďalšia novinka alebo oprava\n\n`
  const at = logText.search(/^## /m)
  write('CHANGELOG.md', at === -1 ? `${logText.trimEnd()}\n\n${section}` : `${logText.slice(0, at)}${section}${logText.slice(at)}`)
  console.log(`  ✓ CHANGELOG.md: section ${next} added, fill it in`)
}

// updates/<version>.md: migration notes for Claude.
const noteFile = `updates/${next}.md`
if (exists(abs(noteFile))) {
  console.log(`  · ${noteFile} already exists`)
} else {
  write(
    noteFile,
    `# Aktualizácia na ${next}\n\nPoznámky pre Clauda, ktorý robí aktualizáciu. Formát je v updates/README.md.\n\n## Čo sa zmenilo\n\n- DOPLŇ: zmeny podľa významu, nie podľa súborov\n\n## Na čo si dať pozor v upravených súboroch\n\n- DOPLŇ, alebo napíš: Nič špeciálne.\n\n## Čo treba spraviť po nahratí\n\n- DOPLŇ, alebo napíš: Nič.\n\n## Čo povedať používateľovi\n\n- DOPLŇ: dve až tri vety o tom, čo nové môže skúsiť\n`,
  )
  console.log(`  ✓ ${noteFile}: skeleton created, fill it in`)
}

// The manifest comes last: it covers the files written above.
if (!dry) {
  const manifest = await manifestFor(next)
  writeFile(abs(MANIFEST), manifestText(manifest))
  console.log(`  ✓ ${MANIFEST}: ${Object.keys(manifest.files).length} files`)
} else {
  console.log(`  (dry run) would regenerate ${MANIFEST}`)
}

console.log(`
  Next:
    1. Fill in CHANGELOG.md and ${noteFile} (search for DOPLŇ).
    2. Regenerate the manifest, because you just edited files it covers:
         node scripts/release.mjs --manifest-only
         node scripts/release.mjs --check
    3. Publish (the tag is what installs fetch their pristine files from):
         git add -A
         git commit -m "Release v${next}"
         git tag v${next}
         git push origin main
         git push origin v${next}
`)
