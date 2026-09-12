/**
 * The public TTS surface: voice lists, previews, and the fallback chain.
 *
 * `withFallback` is the whole point of this module. The chain is:
 *
 *     chosen engine -> one immediate retry -> Kokoro -> Edge
 *
 * A video never ships silent. A bad key, an exhausted quota or a rate-limited voice list
 * downgrades the *voice*, never the run.
 */
import { TTS_FALLBACK_CHAIN } from '@shared/constants'
import type {
  AppSettings,
  SynthesizeOptions,
  SynthesizeResult,
  TtsProviderId,
  TtsVoice
} from '@shared/types'
import { engineMeta, getEngine } from './registry'
import type { TtsEngine } from './types'

export * from './registry'
export * from './resolveVoice'
export * from './types'

export interface SynthesizeAttempt {
  engine: TtsProviderId
  error: string
}

export interface FallbackResult extends SynthesizeResult {
  attempts: SynthesizeAttempt[]
  /** True when something other than the requested engine produced the audio. */
  downgraded: boolean
}

/** Voice lists are cached per engine — a failed fetch must not take synthesis with it. */
const voiceCache = new Map<TtsProviderId, { voices: TtsVoice[]; at: number }>()
const VOICE_CACHE_TTL_MS = 30 * 60 * 1000

export async function listVoices(
  engineId: TtsProviderId,
  settings: AppSettings,
  force = false
): Promise<TtsVoice[]> {
  const cached = voiceCache.get(engineId)
  if (!force && cached && Date.now() - cached.at < VOICE_CACHE_TTL_MS) {
    return cached.voices
  }

  const engine = getEngine(engineId)
  if (!engine) return []

  try {
    const voices = await engine.listVoices(settings)
    voiceCache.set(engineId, { voices, at: Date.now() })
    return voices
  } catch (err) {
    console.warn(`[tts] voice list for ${engineId} failed:`, (err as Error).message)
    // Serve the stale list rather than handing back nothing.
    return cached?.voices ?? []
  }
}

export function clearVoiceCache(engineId?: TtsProviderId): void {
  if (engineId) voiceCache.delete(engineId)
  else voiceCache.clear()
}

/** Swap the output path's extension for the one this engine actually produces. */
function pathForEngine(outputPath: string, engineId: TtsProviderId): string {
  const extension = engineMeta(engineId)?.extension ?? 'mp3'
  return outputPath.replace(/\.[a-z0-9]+$/i, '') + '.' + extension
}

/**
 * Build the attempt order: the chosen engine twice (the immediate retry), then each
 * fallback that is not already in the list.
 */
function buildChain(preferred: TtsProviderId): TtsProviderId[] {
  const order: TtsProviderId[] = [preferred, preferred]
  for (const fallback of TTS_FALLBACK_CHAIN) {
    if (!order.includes(fallback)) order.push(fallback)
  }
  return order
}

export async function synthesizeWithFallback(input: {
  text: string
  engine: TtsProviderId
  voiceId: string
  options: SynthesizeOptions
  settings: AppSettings
}): Promise<FallbackResult> {
  const { text, engine, voiceId, options, settings } = input

  const attempts: SynthesizeAttempt[] = []
  const chain = buildChain(engine)

  for (const candidateId of chain) {
    if (options.isCancelled?.()) throw new Error('Cancelled')

    const engineImpl: TtsEngine | null = getEngine(candidateId)
    if (!engineImpl) {
      attempts.push({ engine: candidateId, error: 'Engine not registered' })
      continue
    }

    if (!(await engineImpl.isAvailable(settings))) {
      attempts.push({
        engine: candidateId,
        error: engineImpl.unavailableReason(settings) || 'Engine unavailable'
      })
      continue
    }

    try {
      const result = await engineImpl.synthesize(text, voiceId, {
        ...options,
        outputPath: pathForEngine(options.outputPath, candidateId)
      }, settings)

      return {
        ...result,
        attempts,
        downgraded: candidateId !== engine
      }
    } catch (err) {
      if (options.isCancelled?.()) throw err
      const message = (err as Error).message || String(err)
      console.warn(`[tts] ${candidateId} failed: ${message}`)
      attempts.push({ engine: candidateId, error: message })
    }
  }

  const summary = attempts.map((a) => `${a.engine}: ${a.error}`).join(' | ')
  throw new Error(`Every voice engine failed. ${summary}`)
}

/** Preview must NOT fall back — a preview in another engine's voice is a lie. */
export async function previewVoice(input: {
  text: string
  engine: TtsProviderId
  voiceId: string
  options: SynthesizeOptions
  settings: AppSettings
}): Promise<SynthesizeResult> {
  const engineImpl = getEngine(input.engine)
  if (!engineImpl) throw new Error(`Unknown engine: ${input.engine}`)
  if (!(await engineImpl.isAvailable(input.settings))) {
    throw new Error(engineImpl.unavailableReason(input.settings) || 'Engine unavailable')
  }
  return engineImpl.synthesize(input.text, input.voiceId, input.options, input.settings)
}
