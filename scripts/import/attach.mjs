/**
 * An ordinary file the user hands over (a document, a picture): copied into
 * memory/prilohy/<YYYY-MM>/ so the chat can point at it. Never overwrites.
 */
import { copyFile, mkdir, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { basename, extname, join, resolve } from 'node:path'
import { fileType } from './detect.mjs'
import { MEMORY_DIR, UserError, safeFileName } from './util.mjs'

/** → { ok, path, rel, type, sizeKB } */
export async function importFile(path) {
  const full = resolve(String(path ?? ''))
  let info
  try {
    info = await stat(full)
  } catch {
    throw new UserError(`Súbor neexistuje: ${path}`)
  }
  if (!info.isFile()) throw new UserError('Toto nie je súbor. Priečinok s dátami z appky si pozri príkazom inspect.')
  const now = new Date()
  const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
  const dir = join(MEMORY_DIR, 'prilohy', month)
  await mkdir(dir, { recursive: true })
  const ext = extname(full)
  const stem = safeFileName(basename(full, ext)) || 'subor'
  let name = `${stem}${ext}`
  for (let i = 2; existsSync(join(dir, name)); i++) name = `${stem}-${i}${ext}`
  await copyFile(full, join(dir, name))
  return { ok: true, path: join(dir, name), rel: `prilohy/${month}/${name}`, type: fileType(name) ?? 'iné', sizeKB: Math.max(1, Math.round(info.size / 1024)) }
}
