/**
 * Locating ffmpeg / ffprobe.
 *
 * In a packaged build the binaries ship in `resources/bin`. In dev they are usually just
 * on PATH, so a bare name is a valid answer — `spawn` resolves it there.
 */
import { app } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

export interface BinaryPaths {
  ffmpeg: string
  ffprobe: string
}

let cached: BinaryPaths | null = null

function findBinary(name: string): string {
  const exe = process.platform === 'win32' ? `${name}.exe` : name

  const candidates = [
    // Packaged: <app>/resources/bin
    process.resourcesPath ? join(process.resourcesPath, 'bin', exe) : null,
    // Dev: <project>/resources/bin
    join(app.getAppPath(), 'resources', 'bin', exe),
    // Dev fallback: cwd/resources/bin
    join(process.cwd(), 'resources', 'bin', exe)
  ].filter((c): c is string => Boolean(c))

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }

  // Nothing bundled — let the OS resolve it from PATH.
  return exe
}

export function binaries(): BinaryPaths {
  if (!cached) {
    cached = { ffmpeg: findBinary('ffmpeg'), ffprobe: findBinary('ffprobe') }
  }
  return cached
}

/** True when a real file was found (PATH resolution is not verified here). */
export function hasBundledBinaries(): boolean {
  const { ffmpeg, ffprobe } = binaries()
  return existsSync(ffmpeg) && existsSync(ffprobe)
}
