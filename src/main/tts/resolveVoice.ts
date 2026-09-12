/**
 * Voice resolution.
 *
 * The rule this exists for: an unpicked or unknown voice must cost the run its *preferred*
 * voice, never the run itself. Once, an empty voice id returned `undefined`, the engine
 * threw, and the whole video died after the images were already generated.
 */
import type { TtsProviderId, TtsVoice } from '@shared/types'

export interface VoiceCharacter {
  id: string
  name: string
  locale: string
  gender?: 'Male' | 'Female' | 'Unknown'
  /** True when we made this character up from an id we do not have metadata for. */
  isSynthetic: boolean
  /** True when the user never picked a voice and we substituted the engine default. */
  isDefault: boolean
}

export const DEFAULT_NARRATOR_NAME = 'Default narrator'

/**
 * The voice used when nothing is picked — chosen per engine, never `undefined`.
 *
 * `Sulafat` is Google's own "warm · storytelling/narration" voice, which is what this app
 * makes. Kokoro's `am_eric` is the closest match to a neutral male narrator.
 */
export const DEFAULT_VOICE_BY_ENGINE: Record<TtsProviderId, string> = {
  'edge-tts': 'en-US-ChristopherNeural',
  gemini: 'Sulafat',
  kokoro: 'am_eric',
  azure: 'en-US-ChristopherNeural',
  ai33: '',
  famespeak: ''
}

const LOCALE_PATTERN = /^([a-z]{2})-([A-Z]{2})/
/** Kokoro ids look like `am_eric` / `af_bella` — the first letter is the language. */
const KOKORO_PATTERN = /^([a-z]{2})_/

function localeFromVoiceId(id: string, engine: TtsProviderId): string {
  if (engine === 'kokoro') {
    const match = KOKORO_PATTERN.exec(id)
    return match ? match[1] : 'en'
  }
  const match = LOCALE_PATTERN.exec(id)
  return match ? `${match[1]}-${match[2]}` : 'en-US'
}

/** `en-US-ChristopherNeural` -> `Christopher`; `am_eric` -> `Eric`. */
function prettifyVoiceId(id: string, engine: TtsProviderId): string {
  let core = id

  if (engine === 'edge-tts' || engine === 'azure') {
    // Strip the locale prefix and the trailing "Neural"/"Multilingual" marker.
    const parts = id.split('-')
    if (parts.length > 2) core = parts.slice(2).join(' ')
    core = core.replace(/\b(Neural|Multilingual)\b/gi, '').trim()
  } else if (engine === 'kokoro') {
    core = id.replace(/^[a-z]{2}_/, '')
  }

  if (!core) core = id
  return core
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
}

/**
 * Always returns a usable character.
 *
 * - empty id            -> the engine default, named "Default narrator"
 * - id in `knownVoices` -> that voice's real metadata
 * - anything else       -> a synthetic character derived from the id, so a remote voice
 *                          list that failed to load cannot break generation
 */
export function resolveVoiceCharacter(
  id: string | undefined | null,
  engine: TtsProviderId,
  knownVoices?: TtsVoice[]
): VoiceCharacter {
  const trimmed = (id ?? '').trim()

  if (!trimmed) {
    const fallbackId = DEFAULT_VOICE_BY_ENGINE[engine] || DEFAULT_VOICE_BY_ENGINE['edge-tts']
    return {
      id: fallbackId,
      name: DEFAULT_NARRATOR_NAME,
      locale: localeFromVoiceId(fallbackId, engine),
      isSynthetic: false,
      isDefault: true
    }
  }

  const known = knownVoices?.find((voice) => voice.id === trimmed)
  if (known) {
    return {
      id: known.id,
      name: known.name,
      locale: known.locale,
      gender: known.gender,
      isSynthetic: false,
      isDefault: false
    }
  }

  return {
    id: trimmed,
    name: prettifyVoiceId(trimmed, engine),
    locale: localeFromVoiceId(trimmed, engine),
    isSynthetic: true,
    isDefault: false
  }
}
