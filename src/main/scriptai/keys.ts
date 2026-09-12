/**
 * The Script AI key pool.
 *
 * Gemini's free tier allows five requests a minute per key. A pool of keys with rotation
 * spreads that out; the rules below are what keep rotation honest:
 *
 * - at least `MIN_REQUEST_SPACING_MS` between request *starts*, so the per-minute budget
 *   is respected even across keys (they all run under the same user's project);
 * - on a 429/RESOURCE_EXHAUSTED the offending key is benched for the delay Google asked
 *   for (`retryDelay`), and the next key takes over mid-conversation — the transcript
 *   lives client-side, so the model never notices the handover;
 * - a 5xx is a server hiccup, not a quota signal: wait briefly and try again.
 */
import type { AppSettings } from '@shared/types'

/**
 * Free tier: 5 requests/minute. 13s spacing leaves headroom for the one in flight.
 * Read when a pool is built, not at module load — the development test shrinks it so the
 * test does not spend its runtime waiting out spacing that protects a real quota.
 */
function minSpacingMs(): number {
  return Number(process.env['ZBOT_SCRIPTAI_SPACING_MS']) || 13_000
}
/** A short pause after a 5xx — enough to clear a blip, not long enough to feel stalled. */
const SERVER_ERROR_RETRY_MS = 3_000

interface Benched {
  until: number
}

export class KeyPool {
  private readonly keys: string[]
  private readonly benched = new Map<string, Benched>()
  private readonly spacing = minSpacingMs()
  private cursor = 0
  private lastRequestAt = 0

  constructor(keys: string[]) {
    this.keys = keys.map((key) => key.trim()).filter(Boolean)
  }

  get size(): number {
    return this.keys.length
  }

  /**
   * The key to use for the next request, and how long to wait before sending it.
   *
   * Benched keys are skipped; if every key is benched, the soonest bench expiry wins —
   * waiting for one is better than failing a conversation that was nearly finished.
   */
  async acquire(): Promise<{ key: string; waitMs: number }> {
    if (this.keys.length === 0) throw new Error('No Script AI key is configured.')

    // Respect the spacing rule first, then pick the key — the two waits can overlap.
    const spacingWait = Math.max(0, this.lastRequestAt + this.spacing - Date.now())

    const now = Date.now()
    let free = this.keys.find((key, index) => {
      const bench = this.benched.get(key)
      if (!bench) return true
      if (bench.until <= now) {
        this.benched.delete(key)
        return true
      }
      // Remember the soonest-expiring bench for the all-benched case below.
      void index
      return false
    })

    let benchWait = 0
    if (!free) {
      const soonest = [...this.benched.values()].reduce((a, b) =>
        a.until < b.until ? a : b
      )
      benchWait = soonest.until - now
      // The bench will have expired by the time the wait is over.
      free = this.keys.find((key) => this.benched.get(key)?.until === soonest.until)
      if (free) this.benched.delete(free)
    }

    if (!free) throw new Error('No usable Script AI key — all are waiting out a quota limit.')

    this.lastRequestAt = Date.now()
    return { key: free, waitMs: Math.max(spacingWait, benchWait) }
  }

  /** Google said no for this key. Bench it for the delay it reported, or a default. */
  bench(key: string, retryDelayMs?: number): void {
    const wait = retryDelayMs ?? 60_000
    this.benched.set(key, { until: Date.now() + wait })
  }

  /** A 5xx is nobody's fault. Same key, brief pause. */
  get serverErrorRetryMs(): number {
    return SERVER_ERROR_RETRY_MS
  }

  /** How long until some key is usable again — for the "still working" progress line. */
  nextAvailableMs(): number {
    const now = Date.now()
    const soonestBench = [...this.benched.values()].reduce<number | null>(
      (soonest, bench) =>
        soonest === null || bench.until < soonest ? bench.until : soonest,
      null
    )
    const spacing = this.lastRequestAt + this.spacing
    return Math.max(0, Math.max(soonestBench ?? 0, spacing) - now)
  }
}

/** The pool for a run: every configured key, deduplicated. */
export function poolFromSettings(settings: AppSettings): KeyPool {
  const keys = [...new Set(settings.scriptAiKeys.map((key) => key.trim()).filter(Boolean))]
  return new KeyPool(keys)
}
