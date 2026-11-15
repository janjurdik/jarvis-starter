/**
 * Three-way text merge: the user's file, the pristine file they started from and the new upstream
 * file. `git merge-file` does the work when git is there, a line based diff3 in plain JS otherwise.
 * Conflicts come back wrapped in markers that name the three sides in Slovak.
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { P, git, hasCRLF, isBinary, rmDir, toLF } from './core.mjs'

export const LABELS = { local: 'tvoje', base: 'pôvodné', incoming: 'nové' }
const OPEN = `<<<<<<< ${LABELS.local}`
const BASE = `||||||| ${LABELS.base}`
const MID = '======='
const CLOSE = `>>>>>>> ${LABELS.incoming}`

/** True when the text still carries conflict markers written by the updater. */
export function hasMarkers(buf) {
  if (!buf || isBinary(buf)) return false
  const text = buf.toString('utf8')
  return new RegExp(`^${OPEN}\\r?$`, 'm').test(text) && new RegExp(`^${CLOSE}\\r?$`, 'm').test(text)
}

/** Lines with their line ends, so a missing final newline is a real difference. */
const lines = (text) => text.match(/[^\n]*\n|[^\n]+/g) ?? []

/**
 * Longest common subsequence of two line arrays as index pairs [i, j], by Myers' O(ND) algorithm.
 * Files that differ in more than `maxEdits` lines are treated as different in the middle: enough
 * for a merge, and it keeps memory small.
 */
export function lcs(a, b, maxEdits = 3000) {
  const ids = new Map()
  const id = (line) => {
    let n = ids.get(line)
    if (n === undefined) ids.set(line, (n = ids.size))
    return n
  }
  const A = a.map(id)
  const B = b.map(id)
  let head = 0
  while (head < A.length && head < B.length && A[head] === B[head]) head++
  let endA = A.length
  let endB = B.length
  while (endA > head && endB > head && A[endA - 1] === B[endB - 1]) {
    endA--
    endB--
  }
  const pairs = []
  for (let i = 0; i < head; i++) pairs.push([i, i])
  const n = endA - head
  const m = endB - head
  if (n > 0 && m > 0) {
    const max = Math.min(n + m, maxEdits)
    const size = 2 * max + 3
    const mid = max + 1
    const v = new Int32Array(size)
    const trace = []
    let found = -1
    for (let d = 0; d <= max && found < 0; d++) {
      for (let k = -d; k <= d; k += 2) {
        let x = k === -d || (k !== d && v[mid + k - 1] < v[mid + k + 1]) ? v[mid + k + 1] : v[mid + k - 1] + 1
        let y = x - k
        while (x < n && y < m && A[head + x] === B[head + y]) {
          x++
          y++
        }
        v[mid + k] = x
        if (x >= n && y >= m) {
          found = d
          break
        }
      }
      trace.push(v.slice(mid - d - 1, mid + d + 2))
    }
    if (found >= 0) {
      const middle = []
      let x = n
      let y = m
      for (let d = found; d > 0; d--) {
        const prev = trace[d - 1]
        const at = (k) => prev[k + d]
        const k = x - y
        const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1
        const prevX = at(prevK)
        const prevY = prevX - prevK
        while (x > prevX && y > prevY) {
          x--
          y--
          middle.push([head + x, head + y])
        }
        x = prevX
        y = prevY
      }
      while (x > 0 && y > 0) {
        x--
        y--
        middle.push([head + x, head + y])
      }
      for (let i = middle.length - 1; i >= 0; i--) pairs.push(middle[i])
    }
  }
  for (let i = endA, j = endB; i < A.length; i++, j++) pairs.push([i, j])
  return pairs
}

const same = (x, y) => x.length === y.length && x.every((line, i) => line === y[i])
/** A block of lines that is safe to put a marker after: it always ends with a line end. */
const block = (part) => (part.length && !part[part.length - 1].endsWith('\n') ? [...part.slice(0, -1), `${part[part.length - 1]}\n`] : part)

/** Classic diff3 over lines. Returns { text, conflicts }. */
export function diff3(localText, baseText, incomingText) {
  const a = lines(localText)
  const o = lines(baseText)
  const b = lines(incomingText)
  const toA = new Int32Array(o.length).fill(-1)
  const toB = new Int32Array(o.length).fill(-1)
  for (const [i, j] of lcs(o, a)) toA[i] = j
  for (const [i, j] of lcs(o, b)) toB[i] = j
  const out = []
  let conflicts = 0
  let io = 0
  let ia = 0
  let ib = 0
  const unstable = (endO, endA, endB) => {
    const pa = a.slice(ia, endA)
    const po = o.slice(io, endO)
    const pb = b.slice(ib, endB)
    if (same(pa, pb) || same(pb, po)) out.push(...pa)
    else if (same(pa, po)) out.push(...pb)
    else {
      conflicts++
      out.push(`${OPEN}\n`, ...block(pa), `${BASE}\n`, ...block(po), `${MID}\n`, ...block(pb), `${CLOSE}\n`)
    }
  }
  for (;;) {
    let run = 0
    while (io + run < o.length && toA[io + run] === ia + run && toB[io + run] === ib + run) run++
    if (run > 0) {
      out.push(...o.slice(io, io + run))
      io += run
      ia += run
      ib += run
      continue
    }
    let j = io
    while (j < o.length && (toA[j] === -1 || toB[j] === -1)) j++
    if (j >= o.length) {
      if (ia < a.length || io < o.length || ib < b.length) unstable(o.length, a.length, b.length)
      break
    }
    unstable(j, toA[j], toB[j])
    io = j
    ia = toA[j]
    ib = toB[j]
  }
  return { text: out.join(''), conflicts }
}

/** Two files without a common ancestor: equal lines stay, every difference becomes a marked block. */
export function twoWay(localText, incomingText) {
  const a = lines(localText)
  const b = lines(incomingText)
  const out = []
  let conflicts = 0
  let ia = 0
  let ib = 0
  const flush = (endA, endB) => {
    if (endA === ia && endB === ib) return
    conflicts++
    out.push(`${OPEN}\n`, ...block(a.slice(ia, endA)), `${MID}\n`, ...block(b.slice(ib, endB)), `${CLOSE}\n`)
  }
  for (const [i, j] of lcs(a, b)) {
    flush(i, j)
    out.push(a[i])
    ia = i + 1
    ib = j + 1
  }
  flush(a.length, b.length)
  return { text: out.join(''), conflicts }
}

/** `git merge-file` on three temporary files. Returns null when git is missing or fails. */
async function gitMerge(localText, baseText, incomingText) {
  const bin = await git()
  if (!bin) return null
  const dir = join(P.tmp, `merge-${process.pid}`)
  try {
    mkdirSync(dir, { recursive: true })
    for (const [name, text] of [['local', localText], ['base', baseText], ['incoming', incomingText]]) writeFileSync(join(dir, name), text)
    const res = spawnSync(bin, ['merge-file', '-p', '--diff3', '-L', LABELS.local, '-L', LABELS.base, '-L', LABELS.incoming, 'local', 'base', 'incoming'], { cwd: dir, maxBuffer: 256 * 1024 * 1024, windowsHide: true })
    // Exit code = number of conflicts (capped at 127). Anything else is an error.
    if (res.error || res.status === null || res.status < 0 || res.status > 127) return null
    return { text: res.stdout.toString('utf8'), conflicts: res.status }
  } catch {
    return null
  } finally {
    rmDir(dir)
  }
}

/**
 * Merges one file. Buffers in, { auto, merged, conflicts, engine } out:
 *   clean      both changes fit together, `merged` is the result
 *   conflicts  overlapping changes, `merged` carries markers
 *   no-base    no pristine version to compare with, `merged` is a two-way comparison with markers
 *   binary     not text, nothing to merge
 * The result keeps the line ends of the user's file.
 */
export async function mergeFile({ local, base, incoming }) {
  if (isBinary(local) || isBinary(incoming) || (base && isBinary(base))) return { auto: 'binary', merged: null, conflicts: 1, engine: null }
  const crlf = hasCRLF(local)
  const finish = (text) => Buffer.from(crlf ? text.replace(/\n/g, '\r\n') : text, 'utf8')
  const a = toLF(local).toString('utf8')
  const b = toLF(incoming).toString('utf8')
  if (!base) {
    const res = twoWay(a, b)
    return { auto: 'no-base', merged: finish(res.text), conflicts: res.conflicts, engine: 'node' }
  }
  const o = toLF(base).toString('utf8')
  const viaGit = await gitMerge(a, o, b)
  const res = viaGit ?? diff3(a, o, b)
  return { auto: res.conflicts ? 'conflicts' : 'clean', merged: finish(res.text), conflicts: res.conflicts, engine: viaGit ? 'git' : 'node' }
}

/** How many lines were added and removed going from `from` to `to`. Null for binary content. */
export function diffStat(from, to) {
  if (isBinary(from) || isBinary(to)) return null
  const a = lines(toLF(from).toString('utf8'))
  const b = lines(toLF(to).toString('utf8'))
  const common = lcs(a, b, 5000).length
  return { added: b.length - common, removed: a.length - common }
}
