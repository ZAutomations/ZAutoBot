/**
 * The one ffmpeg runner. Every ffmpeg call in the app goes through here.
 *
 * Three rules from the spec, each one a bug that shipped:
 *
 *  1. Parse `-progress pipe:1`. The human-readable stderr stats line is
 *     carriage-return separated and yields nothing usable — the bar sits at its start
 *     value for the whole render.
 *  2. Pass `-nostdin` and ignore stdin. A child that inherits the app's stdin can consume
 *     input meant for the app itself.
 *  3. Every call gets a **timeout and a stall watchdog**. A silent ffmpeg otherwise hangs
 *     a job forever with no error and no way out.
 */
import { spawn } from 'node:child_process'
import { binaries } from './binaries'

export interface RunFfmpegOptions {
  args: string[]
  /** Used to turn `out_time_us` into a 0–1 fraction for the progress callback. */
  totalDurationSeconds?: number
  onProgress?: (info: { seconds: number; fraction: number }) => void
  isCancelled?: () => boolean
  /** Hard ceiling for the whole process. */
  timeoutMs?: number
  /** Kill if no progress line arrives for this long. */
  stallTimeoutMs?: number
  label?: string
}

export class FfmpegError extends Error {
  constructor(
    message: string,
    readonly exitCode: number | null,
    readonly stderrTail: string
  ) {
    super(message)
    this.name = 'FfmpegError'
  }
}

export class CancelledError extends Error {
  constructor() {
    super('Cancelled')
    this.name = 'CancelledError'
  }
}

const DEFAULT_TIMEOUT_MS = 20 * 60 * 1000
const DEFAULT_STALL_MS = 120 * 1000
/** Keep only the last N chars of stderr — enough to explain a failure, not enough to flood. */
const STDERR_TAIL_CHARS = 4000

export async function runFfmpeg(options: RunFfmpegOptions): Promise<void> {
  const {
    args,
    totalDurationSeconds,
    onProgress,
    isCancelled,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    stallTimeoutMs = DEFAULT_STALL_MS,
    label = 'ffmpeg'
  } = options

  const { ffmpeg } = binaries()

  const fullArgs = [
    '-hide_banner',
    '-nostdin',
    '-progress',
    'pipe:1',
    '-loglevel',
    'error',
    ...args
  ]

  return new Promise<void>((resolve, reject) => {
    const child = spawn(ffmpeg, fullArgs, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })

    let stderr = ''
    let settled = false
    let lastProgressAt = Date.now()

    const finish = (fn: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timeoutTimer)
      clearInterval(stallTimer)
      clearInterval(cancelTimer)
      fn()
    }

    const kill = (): void => {
      try {
        child.kill('SIGKILL')
      } catch {
        /* already gone */
      }
    }

    const timeoutTimer = setTimeout(() => {
      kill()
      finish(() =>
        reject(
          new FfmpegError(
            `${label} exceeded its ${Math.round(timeoutMs / 1000)}s timeout`,
            null,
            stderr.slice(-STDERR_TAIL_CHARS)
          )
        )
      )
    }, timeoutMs)

    const stallTimer = setInterval(() => {
      if (Date.now() - lastProgressAt > stallTimeoutMs) {
        kill()
        finish(() =>
          reject(
            new FfmpegError(
              `${label} stalled — no progress for ${Math.round(stallTimeoutMs / 1000)}s`,
              null,
              stderr.slice(-STDERR_TAIL_CHARS)
            )
          )
        )
      }
    }, Math.max(1000, Math.floor(stallTimeoutMs / 4)))

    // Cancellation is polled: ffmpeg has no signal handler of its own.
    const cancelTimer = isCancelled
      ? setInterval(() => {
          if (isCancelled()) {
            kill()
            finish(() => reject(new CancelledError()))
          }
        }, 250)
      : undefined

    let stdoutBuffer = ''
    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutBuffer += chunk.toString()
      const lines = stdoutBuffer.split('\n')
      stdoutBuffer = lines.pop() ?? ''

      for (const line of lines) {
        const eq = line.indexOf('=')
        if (eq <= 0) continue
        const key = line.slice(0, eq).trim()
        const value = line.slice(eq + 1).trim()
        if (key !== 'out_time_us' && key !== 'out_time_ms') continue

        lastProgressAt = Date.now()
        const seconds = Number(value) / 1_000_000
        if (!Number.isFinite(seconds)) continue
        onProgress?.({
          seconds,
          fraction: totalDurationSeconds
            ? Math.min(1, Math.max(0, seconds / totalDurationSeconds))
            : 0
        })
      }
    })

    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
      if (stderr.length > STDERR_TAIL_CHARS * 2) {
        stderr = stderr.slice(-STDERR_TAIL_CHARS)
      }
    })

    child.on('error', (err) => {
      finish(() =>
        reject(new FfmpegError(`${label} could not start: ${err.message}`, null, stderr))
      )
    })

    child.on('close', (code) => {
      if (isCancelled?.()) {
        finish(() => reject(new CancelledError()))
        return
      }
      if (code === 0) {
        finish(() => resolve())
        return
      }
      finish(() =>
        reject(
          new FfmpegError(
            `${label} failed with exit code ${code}`,
            code,
            stderr.slice(-STDERR_TAIL_CHARS)
          )
        )
      )
    })
  })
}

/** Build one `key=value` pair per line for a `subtitles=` / `ass=` filter argument. */
export function escapeFilterPath(filePath: string): string {
  // ffmpeg's filter parser eats backslashes and colons; both appear in Windows paths.
  return filePath.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'")
}
