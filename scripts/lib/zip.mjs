/**
 * Small ZIP reader over a file descriptor, no dependencies (zlib is built in).
 *
 * Data exports are often larger than 4 GB, so this never loads the archive into memory:
 * it reads the End Of Central Directory (with the ZIP64 variant), lists the entries from
 * the central directory and then reads or streams one entry at a time.
 *
 *   const zip = await openZip('/path/export.zip')
 *   zip.entries                      [{ name, size, compressedSize, method, isDir, ... }]
 *   await zip.read(entry)            Buffer (stored or deflated)
 *   zip.stream(entry)                Readable of the uncompressed bytes
 *   await zip.extract(entry, dest)   writes the entry to a file
 *   await zip.close()
 *
 * Not supported: encrypted entries, split archives (.z01), methods other than stored/deflate.
 */
import { createWriteStream } from 'node:fs'
import { mkdir, open } from 'node:fs/promises'
import { dirname } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createInflateRaw, inflateRawSync } from 'node:zlib'

const SIG_LOCAL = 0x04034b50
const SIG_CENTRAL = 0x02014b50
const SIG_EOCD = 0x06054b50
const SIG_EOCD64 = 0x06064b50
const SIG_EOCD64_LOCATOR = 0x07064b50
const MAX_CENTRAL = 1_500_000_000
/** Entries up to this compressed size are inflated in one go, bigger ones are streamed. */
const SYNC_LIMIT = 48 * 1024 * 1024

// Upper half of code page 437, the default name encoding of old ZIP tools.
const CP437 =
  'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ '

const utf8Strict = new TextDecoder('utf-8', { fatal: true })

function decodeName(bytes, flagUtf8) {
  let ascii = true
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] > 0x7f) {
      ascii = false
      break
    }
  }
  if (ascii) return bytes.toString('latin1')
  if (flagUtf8) return bytes.toString('utf8')
  // macOS Archive Utility and many web exporters write UTF-8 without setting the flag
  try {
    return utf8Strict.decode(bytes)
  } catch {
    let out = ''
    for (let i = 0; i < bytes.length; i++) out += bytes[i] < 0x80 ? String.fromCharCode(bytes[i]) : CP437[bytes[i] - 0x80]
    return out
  }
}

const u64 = (buf, at) => Number(buf.readBigUInt64LE(at))
/** Error whose message is meant for the user (Slovak, complete sentence). */
const fail = (message) => Object.assign(new Error(message), { user: true })

/** True when the file starts like a ZIP archive. */
export async function isZipFile(path) {
  let fh
  try {
    fh = await open(path, 'r')
    const head = Buffer.alloc(4)
    const { bytesRead } = await fh.read(head, 0, 4, 0)
    if (bytesRead < 4) return false
    const sig = head.readUInt32LE(0)
    return sig === SIG_LOCAL || sig === SIG_EOCD
  } catch {
    return false
  } finally {
    await fh?.close().catch(() => {})
  }
}

export async function openZip(path) {
  const fh = await open(path, 'r')
  try {
    const { size } = await fh.stat()
    const readAt = async (pos, len) => {
      const buf = Buffer.allocUnsafe(len)
      let got = 0
      while (got < len) {
        const { bytesRead } = await fh.read(buf, got, len - got, pos + got)
        if (!bytesRead) break
        got += bytesRead
      }
      if (got < len) throw fail('Archív je poškodený alebo neúplný (nečakaný koniec súboru).')
      return buf
    }

    // End Of Central Directory: the last 22 bytes plus an optional comment of up to 64 KB
    const tailLen = Math.min(size, 22 + 0xffff)
    if (tailLen < 22) throw fail('Súbor nie je ZIP archív.')
    const tail = await readAt(size - tailLen, tailLen)
    let eocd = -1
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === SIG_EOCD && i + 22 + tail.readUInt16LE(i + 20) <= tail.length) {
        eocd = i
        break
      }
    }
    if (eocd < 0) throw fail('Súbor nie je ZIP archív alebo je neúplný (sťahovanie možno ešte neskončilo).')
    const eocdPos = size - tailLen + eocd
    let total = tail.readUInt16LE(eocd + 10)
    let cdSize = tail.readUInt32LE(eocd + 12)
    let cdOffset = tail.readUInt32LE(eocd + 16)

    // ZIP64: a locator sits right before the classic record and points to the 64-bit one
    if (eocdPos >= 20) {
      const loc = await readAt(eocdPos - 20, 20)
      if (loc.readUInt32LE(0) === SIG_EOCD64_LOCATOR) {
        const rec = await readAt(u64(loc, 8), 56)
        if (rec.readUInt32LE(0) !== SIG_EOCD64) throw fail('Archív je poškodený (ZIP64 záznam).')
        total = u64(rec, 32)
        cdSize = u64(rec, 40)
        cdOffset = u64(rec, 48)
      }
    }
    if (cdSize > MAX_CENTRAL) throw fail('Archív má priveľa súborov.')
    if (cdOffset + cdSize > size) throw fail('Archív je poškodený alebo neúplný.')

    const cd = cdSize ? await readAt(cdOffset, cdSize) : Buffer.alloc(0)
    const entries = []
    let at = 0
    while (at + 46 <= cd.length && cd.readUInt32LE(at) === SIG_CENTRAL) {
      const flags = cd.readUInt16LE(at + 8)
      const method = cd.readUInt16LE(at + 10)
      let compressedSize = cd.readUInt32LE(at + 20)
      let uncompressed = cd.readUInt32LE(at + 24)
      const nameLen = cd.readUInt16LE(at + 28)
      const extraLen = cd.readUInt16LE(at + 30)
      const commentLen = cd.readUInt16LE(at + 32)
      let offset = cd.readUInt32LE(at + 42)
      const nameBytes = cd.subarray(at + 46, at + 46 + nameLen)
      let name = decodeName(nameBytes, Boolean(flags & 0x800))
      // extra fields: ZIP64 sizes (0x0001) and the Info-ZIP unicode path (0x7075)
      let x = at + 46 + nameLen
      const xEnd = x + extraLen
      while (x + 4 <= xEnd) {
        const id = cd.readUInt16LE(x)
        const len = cd.readUInt16LE(x + 2)
        const body = x + 4
        if (id === 0x0001) {
          let p = body
          if (uncompressed === 0xffffffff && p + 8 <= body + len) {
            uncompressed = u64(cd, p)
            p += 8
          }
          if (compressedSize === 0xffffffff && p + 8 <= body + len) {
            compressedSize = u64(cd, p)
            p += 8
          }
          if (offset === 0xffffffff && p + 8 <= body + len) offset = u64(cd, p)
        } else if (id === 0x7075 && len > 5) {
          name = cd.subarray(body + 5, body + len).toString('utf8')
        }
        x = body + len
      }
      name = name.replace(/\\/g, '/').replace(/^\/+/, '')
      entries.push({ name, size: uncompressed, compressedSize, method, flags, offset, isDir: name.endsWith('/') })
      at = xEnd + commentLen
    }
    if (entries.length < total && entries.length === 0 && total > 0) throw fail('Archív je poškodený (zoznam súborov sa nedá prečítať).')

    const dataStart = async (entry) => {
      if (entry._data !== undefined) return entry._data
      const head = await readAt(entry.offset, 30)
      if (head.readUInt32LE(0) !== SIG_LOCAL) throw fail(`Archív je poškodený (${entry.name}).`)
      entry._data = entry.offset + 30 + head.readUInt16LE(26) + head.readUInt16LE(28)
      return entry._data
    }
    const check = (entry) => {
      if (entry.flags & 1) throw fail('Archív je chránený heslom. Rozbaľ ho najprv ručne a vyber rozbalený priečinok.')
      if (entry.method !== 0 && entry.method !== 8) throw fail(`Archív používa kompresiu, ktorú neviem čítať (metóda ${entry.method}). Rozbaľ ho ručne a vyber rozbalený priečinok.`)
    }

    /** Readable of the uncompressed bytes of one entry. */
    function stream(entry) {
      check(entry)
      if (!entry.compressedSize) return Readable.from([])
      const out = entry.method === 8 ? createInflateRaw() : null
      const raw = Readable.from(
        (async function* () {
          const start = await dataStart(entry)
          const step = 1 << 20
          for (let done = 0; done < entry.compressedSize; done += step) {
            yield await readAt(start + done, Math.min(step, entry.compressedSize - done))
          }
        })(),
        { objectMode: false },
      )
      if (!out) return raw
      raw.on('error', (err) => out.destroy(err))
      return raw.pipe(out)
    }

    /** Whole entry as a Buffer. Throws when it is larger than `maxBytes`. */
    async function read(entry, { maxBytes = 1_800_000_000 } = {}) {
      check(entry)
      if (entry.size > maxBytes) throw fail(`Súbor ${entry.name} je príliš veľký.`)
      if (!entry.compressedSize) return Buffer.alloc(0)
      if (entry.compressedSize <= SYNC_LIMIT) {
        const raw = await readAt(await dataStart(entry), entry.compressedSize)
        return entry.method === 8 ? inflateRawSync(raw) : raw
      }
      const chunks = []
      for await (const chunk of stream(entry)) chunks.push(chunk)
      return Buffer.concat(chunks)
    }

    /** First `bytes` of the uncompressed entry (enough to sniff a format). */
    async function head(entry, bytes = 4096) {
      check(entry)
      if (!entry.compressedSize) return Buffer.alloc(0)
      if (entry.method === 0) return readAt(await dataStart(entry), Math.min(bytes, entry.compressedSize))
      const chunks = []
      let got = 0
      const s = stream(entry)
      for await (const chunk of s) {
        chunks.push(chunk)
        got += chunk.length
        if (got >= bytes) break
      }
      s.destroy()
      return Buffer.concat(chunks).subarray(0, bytes)
    }

    async function extract(entry, dest) {
      await mkdir(dirname(dest), { recursive: true })
      await pipeline(stream(entry), createWriteStream(dest))
      return dest
    }

    return { path, size, entries, read, head, stream, extract, close: () => fh.close().catch(() => {}) }
  } catch (err) {
    await fh.close().catch(() => {})
    throw err
  }
}
