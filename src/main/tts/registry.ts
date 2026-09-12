/**
 * The engine registry.
 *
 * `TTS_ENGINES` (shared) carries the metadata the UI renders; this file carries the
 * implementations. Registering a new engine is one line here plus one entry there.
 */
import { TTS_ENGINES } from '@shared/constants'
import type { AppSettings, EngineAvailability, TtsEngineMeta, TtsProviderId } from '@shared/types'
import { edgeEngine } from './engines/edge'
import { geminiEngine } from './engines/gemini'
import { kokoroEngine } from './engines/kokoro'
import { createUnavailableEngine, type TtsEngine } from './types'

const ENGINES: Record<TtsProviderId, TtsEngine> = {
  'edge-tts': edgeEngine,
  gemini: geminiEngine,
  kokoro: kokoroEngine,

  azure: createUnavailableEngine(
    'azure',
    'Azure Speech needs a key and region in Settings before it can be used.'
  ),
  ai33: createUnavailableEngine(
    'ai33',
    'ai33.pro needs an API key in Settings before it can be used.'
  ),
  famespeak: createUnavailableEngine(
    'famespeak',
    'FameSpeak needs an API key in Settings before it can be used.'
  )
}

export function getEngine(id: TtsProviderId): TtsEngine | null {
  return ENGINES[id] ?? null
}

export function listEngineMeta(): TtsEngineMeta[] {
  return TTS_ENGINES
}

export function engineMeta(id: TtsProviderId): TtsEngineMeta | undefined {
  return TTS_ENGINES.find((engine) => engine.id === id)
}

export type { EngineAvailability }

/** What the engine switcher bar shows: which engines can actually run right now. */
export async function engineAvailability(settings: AppSettings): Promise<EngineAvailability[]> {
  return Promise.all(
    TTS_ENGINES.map(async (meta) => {
      const engine = getEngine(meta.id)
      if (!engine) return { meta, available: false, reason: 'Engine not registered' }

      const available = await engine.isAvailable(settings)
      return {
        meta,
        available,
        // `unavailableReason` describes a blocker, so it is only meaningful — and only
        // reported — for an engine that is actually blocked. Asking an available engine
        // returns e.g. "the service-account file could not be read" for a file it is
        // happily using, which reads as a fault in the UI.
        reason: available ? '' : engine.unavailableReason(settings)
      }
    })
  )
}
