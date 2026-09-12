/**
 * Turning a chosen file into skill markdown.
 *
 * `.md`/`.txt` are read as-is. A `.skill` is a ZIP holding a `SKILL.md` (the format the
 * skill-marketplace tools ship), and `.zip` is accepted for the same reason. PDFs are
 * best-effort: text is pulled out of the content streams, because most skill PDFs are
 * exported text documents rather than scans.
 *
 * The ZIP is walked by hand with `zlib.inflateRawSync` — the format's central directory
 * makes it a table lookup, and a zip dependency for one file type is not worth it.
 */
import { promises as fs } from 'node:fs'
import { inflateRawSync, inflateSync } from 'node:zlib'

const EOCD_SIGNATURE = 0x06054b50
const CENTRAL_HEADER_SIGNATURE = 0x02014b50
const LOCAL_HEADER_SIGNATURE = 0x04034b50

/** Pull the text out of a file the user chose as a skill. */
export async function extractSkillText(filePath: string, fileName: string): Promise<string> {
  const lower = fileName.toLowerCase()
  const bytes = await fs.readFile(filePath)

  if (lower.endsWith('.zip') || lower.endsWith('.skill')) {
    return fromZip(bytes) ?? throwEmpty('the archive holds no readable text file')
  }

  if (lower.endsWith('.pdf')) {
    return fromPdf(bytes) ?? throwEmpty('the PDF holds no extractable text (is it a scan?)')
  }

  // Everything else is text, whatever the extension claims.
  const text = bytes.toString('utf8')
  if (!text.trim()) throwEmpty('the file is empty')
  return text
}

function throwEmpty(reason: string): never {
  throw new Error(`Could not read a skill from this file: ${reason}.`)
}

interface ZipEntry {
  name: string
  compressedSize: number
  uncompressedSize: number
  localOffset: number
  method: number
}

function fromZip(bytes: Buffer): string | null {
  const entries = centralDirectory(bytes)
  if (entries.length === 0) return null

  // Prefer SKILL.md, then any markdown, then the largest text-ish entry.
  const byName = (pattern: RegExp): ZipEntry[] =>
    entries.filter((entry) => pattern.test(entry.name) && !entry.name.startsWith('__MACOSX'))

  const pick =
    byName(/(^|\/)skill\.md$/i)[0] ??
    byName(/\.md$/i)[0] ??
    byName(/\.(md|txt|json)$/i)
      .sort((a, b) => b.uncompressedSize - a.uncompressedSize)[0]
  if (!pick) return null

  const data = entryBytes(bytes, pick)
  if (!data) return null
  return data.toString('utf8')
}

/** Walk the central directory — the index at the end of every ZIP. */
function centralDirectory(bytes: Buffer): ZipEntry[] {
  // The EOCD sits within the last 65,535 bytes; find it by signature scanning backwards.
  const scanStart = Math.max(0, bytes.length - 66_000)
  let eocd = -1
  for (let i = bytes.length - 22; i >= scanStart; i--) {
    if (bytes.readUInt32LE(i) === EOCD_SIGNATURE) {
      eocd = i
      break
    }
  }
  if (eocd === -1) return []

  const count = bytes.readUInt16LE(eocd + 10)
  let offset = bytes.readUInt32LE(eocd + 16)

  const entries: ZipEntry[] = []
  for (let i = 0; i < count; i++) {
    if (offset + 46 > bytes.length) break
    if (bytes.readUInt32LE(offset) !== CENTRAL_HEADER_SIGNATURE) break

    const method = bytes.readUInt16LE(offset + 10)
    const compressedSize = bytes.readUInt32LE(offset + 20)
    const uncompressedSize = bytes.readUInt32LE(offset + 24)
    const nameLength = bytes.readUInt16LE(offset + 28)
    const extraLength = bytes.readUInt16LE(offset + 30)
    const commentLength = bytes.readUInt16LE(offset + 32)
    const localOffset = bytes.readUInt32LE(offset + 42)
    const name = bytes.subarray(offset + 46, offset + 46 + nameLength).toString('utf8')

    entries.push({ name, compressedSize, uncompressedSize, localOffset, method })
    offset += 46 + nameLength + extraLength + commentLength
  }
  return entries
}

/** Inflate one entry, following its local header to the actual bytes. */
function entryBytes(bytes: Buffer, entry: ZipEntry): Buffer | null {
  if (entry.localOffset + 30 > bytes.length) return null
  if (bytes.readUInt32LE(entry.localOffset) !== LOCAL_HEADER_SIGNATURE) return null

  const nameLength = bytes.readUInt16LE(entry.localOffset + 26)
  const extraLength = bytes.readUInt16LE(entry.localOffset + 28)
  const dataStart = entry.localOffset + 30 + nameLength + extraLength
  const data = bytes.subarray(dataStart, dataStart + entry.compressedSize)

  try {
    if (entry.method === 0) return data // stored
    if (entry.method === 8) return inflateRawSync(data) // deflated
    return null
  } catch {
    return null
  }
}

/**
 * PDF text, best-effort: inflate every stream, then collect the strings from `Tj` and
 * `TJ` operators. Text PDFs (what skills are) yield their content this way; a scanned
 * image PDF yields nothing and says so.
 */
function fromPdf(bytes: Buffer): string | null {
  const parts: string[] = []

  // `stream\n…\nendstream` pairs, raw or Flate-compressed.
  const streamPattern = /stream\r?\n?/g
  let match: RegExpExecArray | null
  while ((match = streamPattern.exec(bytes.toString('latin1'))) !== null) {
    const start = match.index + match[0].length
    const end = bytes.indexOf('endstream', start)
    if (end === -1) break
    streamPattern.lastIndex = end

    let content: Buffer | null = null
    const raw = bytes.subarray(start, end)
    try {
      content = inflateSync(raw)
    } catch {
      content = raw // an uncompressed stream is legal
    }
    if (content) parts.push(pdfTextOperators(content.toString('latin1')))
  }

  const text = parts.join('\n').replace(/\n{3,}/g, '\n\n').trim()
  return text || null
}

/** Strings inside `(...) Tj` and `[ (..) 1 (..) ] TJ` operators, decoded from PDF escapes. */
function pdfTextOperators(content: string): string {
  const out: string[] = []
  // A TJ array holds several strings with kerning numbers between them.
  const arrayPattern = /\[((?:[^\[\]\\]|\\.)*)\]\s*TJ/g
  const simplePattern = /\(((?:[^()\\]|\\.)*)\)\s*Tj/g

  let match: RegExpExecArray | null
  while ((match = arrayPattern.exec(content)) !== null) {
    const strings = match[1].match(/\(((?:[^()\\]|\\.)*)\)/g) ?? []
    out.push(strings.map((s) => unescapePdf(s.slice(1, -1))).join(''))
  }
  while ((match = simplePattern.exec(content)) !== null) {
    out.push(unescapePdf(match[1]))
  }

  return out.join('')
}

function unescapePdf(text: string): string {
  return text
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '')
    .replace(/\\t/g, '\t')
    .replace(/\\([()\\])/g, '$1')
    .replace(/\\(\d{1,3})/g, (_, code: string) => String.fromCharCode(parseInt(code, 8)))
}
