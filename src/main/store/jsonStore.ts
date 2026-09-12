/**
 * Safe JSON persistence.
 *
 * Four rules, each one paid for by a real corrupt-or-lost-data bug:
 *
 *  1. A **single async write lock per file** — concurrent saves must never interleave.
 *  2. **Unique temp filename per write** — per-keystroke saves sharing one `.tmp` once
 *     wiped a whole settings file.
 *  3. **Backup to `.bak` before every write**, and fall back to it when the main file
 *     will not parse.
 *  4. A **strict read that throws** instead of returning defaults — a silent default is
 *     what turns a corrupt file into permanent data loss on the next save.
 */
import { promises as fs } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname } from 'node:path'

/** Serialises operations per file path. */
const chains = new Map<string, Promise<unknown>>()

export function withFileLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = chains.get(key) ?? Promise.resolve()
  // Run regardless of whether the previous operation resolved or rejected.
  const next = prev.then(fn, fn)
  chains.set(
    key,
    next.catch(() => undefined)
  )
  return next
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

export async function fileExists(file: string): Promise<boolean> {
  try {
    await fs.access(file)
    return true
  } catch {
    return false
  }
}

/**
 * `os.replace()` (rename) fails with EPERM/EBUSY on Windows while another process holds
 * the file open — antivirus and indexers do this constantly. Retry briefly.
 */
async function renameWithRetry(from: string, to: string, attempts = 5): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    try {
      await fs.rename(from, to)
      return
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      const retryable = code === 'EPERM' || code === 'EBUSY' || code === 'EACCES'
      if (!retryable || i === attempts - 1) throw err
      await delay(40 * (i + 1))
    }
  }
}

/**
 * Tolerant read. Returns `fallback` when the file is missing or unparseable — but only
 * after trying the `.bak`. Never use this before a write; use `readJsonStrict`.
 */
export async function readJson<T>(file: string, fallback: T): Promise<T> {
  const primary = await tryParse<T>(file)
  if (primary.ok) return primary.value

  const backup = await tryParse<T>(`${file}.bak`)
  if (backup.ok) {
    console.warn(`[jsonStore] ${file} unreadable, recovered from .bak`)
    return backup.value
  }

  if (primary.missing && backup.missing) return fallback
  console.error(`[jsonStore] ${file} and its .bak are both unreadable; using fallback`)
  return fallback
}

/**
 * Strict read for read-modify-write cycles. Throws rather than handing back defaults —
 * defaults merged into a save is exactly how a corrupt read becomes permanent loss.
 */
export async function readJsonStrict<T>(file: string): Promise<T> {
  const primary = await tryParse<T>(file)
  if (primary.ok) return primary.value

  const backup = await tryParse<T>(`${file}.bak`)
  if (backup.ok) {
    console.warn(`[jsonStore] ${file} unreadable, recovered from .bak`)
    return backup.value
  }

  throw new Error(
    `Refusing to load ${file}: ${primary.error ?? 'file missing'} (backup: ${
      backup.error ?? 'missing'
    })`
  )
}

async function tryParse<T>(
  file: string
): Promise<{ ok: true; value: T } | { ok: false; missing: boolean; error?: string }> {
  let raw: string
  try {
    raw = await fs.readFile(file, 'utf8')
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    return { ok: false, missing: code === 'ENOENT', error: code }
  }
  try {
    return { ok: true, value: JSON.parse(raw) as T }
  } catch (err) {
    return { ok: false, missing: false, error: (err as Error).message }
  }
}

/** Locked, backed-up, atomic write. */
export async function writeJson<T>(file: string, data: T): Promise<void> {
  return withFileLock(file, () => writeJsonUnlocked(file, data))
}

/**
 * The write itself — no lock.
 *
 * `updateJson` already holds the lock when it writes, and re-acquiring it there is a
 * self-deadlock: the queued inner write waits for the outer operation to finish, which is
 * itself waiting on the inner write. So the lock lives in the two entry points, and this
 * is what they both call.
 */
async function writeJsonUnlocked<T>(file: string, data: T): Promise<void> {
  await fs.mkdir(dirname(file), { recursive: true })

  // Back up the previous version FIRST — the history exists nowhere else.
  if (await fileExists(file)) {
    try {
      await fs.copyFile(file, `${file}.bak`)
    } catch (err) {
      console.warn(`[jsonStore] could not back up ${file}:`, (err as Error).message)
    }
  }

  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`
  try {
    await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8')
    await renameWithRetry(tmp, file)
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => undefined)
    throw err
  }
}

/** Read, hand to `mutate`, write back — all inside one lock so nothing is lost. */
export async function updateJson<T>(
  file: string,
  fallback: T,
  mutate: (current: T) => T | Promise<T>
): Promise<T> {
  return withFileLock(file, async () => {
    let current: T
    try {
      current = await readJsonStrict<T>(file)
    } catch {
      current = fallback
    }
    const next = await mutate(current)
    await writeJsonUnlocked(file, next)
    return next
  })
}
