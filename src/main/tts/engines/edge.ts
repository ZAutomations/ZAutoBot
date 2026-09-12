/**
 * Edge TTS — free Microsoft neural voices, no key, no local dependency.
 *
 * It is the default engine because it is the only one that is free *and* returns per-word
 * timings, which is what makes the subtitles exact rather than estimated.
 */
import { createWriteStream, promises as fs } from 'node:fs'
import { dirname } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts'
import type {
  AppSettings,
  SynthesizeOptions,
  SynthesizeResult,
  TtsVoice,
  WordTiming
} from '@shared/types'
import { probeDuration } from '../../video/ffprobe'
import { resolveVoiceCharacter } from '../resolveVoice'
import type { TtsEngine } from '../types'

const FORMAT = OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3

/** Edge reports boundaries in 100-nanosecond ticks. */
const TICKS_PER_MS = 10_000

interface EdgeVoice {
  ShortName: string
  Gender?: string
  Locale?: string
  FriendlyName?: string
}

interface EdgeMetadataMessage {
  Metadata?: Array<{
    Type?: string
    Data?: {
      Offset?: number
      Duration?: number
      text?: { Text?: string }
    }
  }>
}

// ---------------------------------------------------------------------------
// Mood / prosody
// ---------------------------------------------------------------------------

/**
 * Mood shapes delivery where the engine allows it. Values are deliberately small — these
 * are narration adjustments, not performances.
 */
const MOOD_PROSODY: Array<{ pattern: RegExp; rate: number; pitch: number }> = [
  { pattern: /calm|sad|serene|peace|gentle|soft|somber|melanchol/, rate: -8, pitch: -2 },
  { pattern: /energ|excit|hype|action|fast|urgent|intense/, rate: 10, pitch: 2 },
  { pattern: /mysteri|dark|tense|suspense|eerie|horror|creep/, rate: -6, pitch: -4 },
  { pattern: /happy|warm|joy|bright|fun|upbeat|cheer/, rate: 6, pitch: 2 },
  { pattern: /drama|epic|cinematic|grand|majestic|sweep/, rate: -4, pitch: -1 },
  { pattern: /hope|rise|grow|progress|inspir|triumph/, rate: 2, pitch: 1 }
]

const RATE_LIMIT = 30

function signedPercent(value: number): string {
  const clamped = Math.max(-RATE_LIMIT, Math.min(RATE_LIMIT, Math.round(value)))
  return `${clamped >= 0 ? '+' : ''}${clamped}%`
}

function prosodyFor(options: SynthesizeOptions): {
  rate: string
  pitch: string
  volume: string
} {
  let rate = 0
  let pitch = 0

  const mood = MOOD_PROSODY.find((entry) => entry.pattern.test(options.mood ?? ''))
  if (mood) {
    rate = mood.rate
    pitch = mood.pitch
  }

  // An explicit speed always wins over the mood guess.
  if (typeof options.speed === 'number' && options.speed > 0) {
    rate = (options.speed - 1) * 100
  }
  if (typeof options.pitch === 'number') {
    pitch = options.pitch
  }

  const volume = typeof options.volume === 'number' ? (options.volume - 1) * 100 : 0

  return { rate: signedPercent(rate), pitch: signedPercent(pitch), volume: signedPercent(volume) }
}

// ---------------------------------------------------------------------------
// Metadata stream parsing
// ---------------------------------------------------------------------------

/**
 * The metadata stream emits one JSON object per WebSocket frame, but a stream `data`
 * event may batch or split them. Extract complete, brace-balanced objects and keep the
 * remainder for the next chunk.
 */
function extractJsonObjects(buffer: string): { objects: unknown[]; rest: string } {
  const objects: unknown[] = []
  let index = 0

  while (index < buffer.length) {
    while (index < buffer.length && /\s/.test(buffer[index])) index++
    if (buffer[index] !== '{') break

    let depth = 0
    let inString = false
    let escaped = false
    let end = -1

    for (let i = index; i < buffer.length; i++) {
      const char = buffer[i]
      if (inString) {
        if (escaped) escaped = false
        else if (char === '\\') escaped = true
        else if (char === '"') inString = false
        continue
      }
      if (char === '"') {
        inString = true
      } else if (char === '{') {
        depth++
      } else if (char === '}') {
        depth--
        if (depth === 0) {
          end = i
          break
        }
      }
    }

    if (end === -1) break
    try {
      objects.push(JSON.parse(buffer.slice(index, end + 1)))
    } catch {
      // A malformed frame is not worth failing a whole narration over.
    }
    index = end + 1
  }

  return { objects, rest: buffer.slice(index) }
}

function collectWordTimings(messages: EdgeMetadataMessage[]): WordTiming[] {
  const words: WordTiming[] = []

  for (const message of messages) {
    for (const entry of message.Metadata ?? []) {
      if (entry.Type !== 'WordBoundary') continue
      const text = entry.Data?.text?.Text
      if (!text) continue

      const startMs = (entry.Data?.Offset ?? 0) / TICKS_PER_MS
      const durationMs = (entry.Data?.Duration ?? 0) / TICKS_PER_MS
      words.push({ text, startMs, endMs: startMs + durationMs })
    }
  }

  return words
}

function cleanVoiceName(voice: EdgeVoice): string {
  let name = voice.FriendlyName ?? voice.ShortName
  name = name.replace(/^Microsoft\s+/, '')
  const dash = name.indexOf(' - ')
  if (dash > 0) name = name.slice(0, dash)
  return name.replace(/\s+Online\b/, '').trim() || voice.ShortName
}

function mapGender(gender?: string): TtsVoice['gender'] {
  if (gender === 'Male') return 'Male'
  if (gender === 'Female') return 'Female'
  return 'Unknown'
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

export const edgeEngine: TtsEngine = {
  id: 'edge-tts',

  async isAvailable() {
    // No key and no local dependency — availability is purely a network question, and a
    // network failure during synthesis is what the fallback chain is for.
    return true
  },

  unavailableReason() {
    return ''
  },

  async listVoices(): Promise<TtsVoice[]> {
    const tts = new MsEdgeTTS()
    try {
      const voices = (await tts.getVoices()) as EdgeVoice[]
      return voices
        .map((voice) => ({
          id: voice.ShortName,
          name: cleanVoiceName(voice),
          locale: voice.Locale ?? '',
          gender: mapGender(voice.Gender)
        }))
        .sort((a, b) => a.locale.localeCompare(b.locale) || a.name.localeCompare(b.name))
    } finally {
      tts.close()
    }
  },

  async synthesize(
    text: string,
    voiceId: string,
    options: SynthesizeOptions,
    _settings: AppSettings
  ): Promise<SynthesizeResult> {
    // Never `undefined` — an unpicked voice costs the run its preferred voice, not the run.
    const character = resolveVoiceCharacter(voiceId, 'edge-tts')
    const { rate, pitch, volume } = prosodyFor(options)

    const tts = new MsEdgeTTS()
    const messages: EdgeMetadataMessage[] = []
    let metadataBuffer = ''

    try {
      await tts.setMetadata(character.id, FORMAT, { wordBoundaryEnabled: true })

      if (options.isCancelled?.()) throw new Error('Cancelled')

      const { audioStream, metadataStream } = tts.toStream(text, { rate, pitch, volume })

      metadataStream?.on('data', (chunk: Buffer | string) => {
        metadataBuffer += chunk.toString()
        const { objects, rest } = extractJsonObjects(metadataBuffer)
        metadataBuffer = rest
        for (const object of objects) messages.push(object as EdgeMetadataMessage)
      })

      await fs.mkdir(dirname(options.outputPath), { recursive: true })
      await pipeline(audioStream, createWriteStream(options.outputPath))
    } finally {
      try {
        tts.close()
      } catch {
        /* socket already gone */
      }
    }

    if (options.isCancelled?.()) throw new Error('Cancelled')

    const durationSeconds = await probeDuration(options.outputPath)
    const wordTimings = collectWordTimings(messages)

    return {
      audioPath: options.outputPath,
      durationSeconds,
      wordTimings: wordTimings.length ? wordTimings : undefined,
      engine: 'edge-tts',
      voiceId: character.id
    }
  },

  async test() {
    try {
      const tts = new MsEdgeTTS()
      try {
        const voices = await tts.getVoices()
        return { ok: true, message: `Connected — ${voices.length} voices available.` }
      } finally {
        tts.close()
      }
    } catch (err) {
      return { ok: false, message: (err as Error).message }
    }
  }
}
