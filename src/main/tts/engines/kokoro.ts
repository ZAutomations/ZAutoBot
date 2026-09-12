/**
 * Kokoro — an 82M-parameter TTS model that runs entirely on this machine.
 *
 * It is the safety net for the whole product: when an API key is missing, a quota is spent
 * or the network is down, Kokoro still speaks. That is why it sits first in the fallback
 * chain behind Edge.
 *
 * The model itself comes from Hugging Face the first time and is then cached; the 28 voice
 * embeddings ship inside the `kokoro-js` package, so only the ~86 MB q8 model is ever
 * fetched. Point `kokoroModelDir` at a local transformers.js-format folder to stay offline
 * from the very first run.
 *
 * Synthesis runs through `generate()`, once per sentence-sized piece, rather than through
 * kokoro-js's `stream()` — see `splitForKokoro` for why.
 */
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { KokoroTTS } from 'kokoro-js'
import type { AppSettings, SynthesizeOptions, SynthesizeResult, TtsVoice } from '@shared/types'
import { probeDuration } from '../../video/ffprobe'
import { resolveVoiceCharacter } from '../resolveVoice'
import { EngineUnavailableError, type TtsEngine } from '../types'
import { wavFromFloatChunks } from '../wav'

/** The upstream model. `q8` is ~86 MB against fp32's ~326 MB, at no audible cost. */
const DEFAULT_MODEL = 'onnx-community/Kokoro-82M-v1.0-ONNX'
const DEFAULT_DTYPE = 'q8'

/** Kokoro is an 82M model — CPU inference is fast, but loading happens once and is not. */
let modelPromise: Promise<KokoroTTS> | null = null
let loadedFrom = ''

/**
 * The 28 shipped voices. Hard-coded on purpose: reading them off the model would mean
 * loading 86 MB just to fill a dropdown, and these ids are part of the package.
 */
const VOICES: Array<{ id: string; name: string; locale: string; gender: 'Male' | 'Female' }> = [
  { id: 'af_heart', name: 'Heart', locale: 'en-US', gender: 'Female' },
  { id: 'af_alloy', name: 'Alloy', locale: 'en-US', gender: 'Female' },
  { id: 'af_aoede', name: 'Aoede', locale: 'en-US', gender: 'Female' },
  { id: 'af_bella', name: 'Bella', locale: 'en-US', gender: 'Female' },
  { id: 'af_jessica', name: 'Jessica', locale: 'en-US', gender: 'Female' },
  { id: 'af_kore', name: 'Kore', locale: 'en-US', gender: 'Female' },
  { id: 'af_nicole', name: 'Nicole', locale: 'en-US', gender: 'Female' },
  { id: 'af_nova', name: 'Nova', locale: 'en-US', gender: 'Female' },
  { id: 'af_river', name: 'River', locale: 'en-US', gender: 'Female' },
  { id: 'af_sarah', name: 'Sarah', locale: 'en-US', gender: 'Female' },
  { id: 'af_sky', name: 'Sky', locale: 'en-US', gender: 'Female' },
  { id: 'am_adam', name: 'Adam', locale: 'en-US', gender: 'Male' },
  { id: 'am_echo', name: 'Echo', locale: 'en-US', gender: 'Male' },
  { id: 'am_eric', name: 'Eric', locale: 'en-US', gender: 'Male' },
  { id: 'am_fenrir', name: 'Fenrir', locale: 'en-US', gender: 'Male' },
  { id: 'am_liam', name: 'Liam', locale: 'en-US', gender: 'Male' },
  { id: 'am_michael', name: 'Michael', locale: 'en-US', gender: 'Male' },
  { id: 'am_onyx', name: 'Onyx', locale: 'en-US', gender: 'Male' },
  { id: 'am_puck', name: 'Puck', locale: 'en-US', gender: 'Male' },
  { id: 'am_santa', name: 'Santa', locale: 'en-US', gender: 'Male' },
  { id: 'bf_alice', name: 'Alice', locale: 'en-GB', gender: 'Female' },
  { id: 'bf_emma', name: 'Emma', locale: 'en-GB', gender: 'Female' },
  { id: 'bf_isabella', name: 'Isabella', locale: 'en-GB', gender: 'Female' },
  { id: 'bf_lily', name: 'Lily', locale: 'en-GB', gender: 'Female' },
  { id: 'bm_daniel', name: 'Daniel', locale: 'en-GB', gender: 'Male' },
  { id: 'bm_fable', name: 'Fable', locale: 'en-GB', gender: 'Male' },
  { id: 'bm_george', name: 'George', locale: 'en-GB', gender: 'Male' },
  { id: 'bm_lewis', name: 'Lewis', locale: 'en-GB', gender: 'Male' }
]

function modelSource(settings: AppSettings): string {
  return settings.kokoroModelDir?.trim() || DEFAULT_MODEL
}

/**
 * Kokoro holds roughly 510 phonemes at once, so a full narration has to be fed in pieces.
 *
 * This deliberately does *not* use kokoro-js's own `stream()`: as of 1.2.1 it yields one
 * chunk and then never settles, which hangs the pipeline instead of failing it. Calling
 * `generate()` per piece is both correct and cancellable between pieces.
 *
 * Stage one breaks the text into units that each fit; stage two packs them back together
 * so we still make as few model calls as possible.
 */
export function splitForKokoro(text: string, limit = 300): string[] {
  const units: string[] = []

  for (const sentence of text.trim().split(/(?<=[.!?…])\s+/)) {
    if (!sentence) continue
    if (sentence.length <= limit) {
      units.push(sentence)
      continue
    }

    // Too long for one call — try its clauses before falling back to bare words.
    for (const clause of sentence.split(/(?<=[,;:])\s+/)) {
      if (clause.length <= limit) {
        units.push(clause)
        continue
      }

      let piece = ''
      for (const word of clause.split(/\s+/)) {
        if (piece && `${piece} ${word}`.length > limit) {
          units.push(piece)
          piece = word
        } else {
          piece = piece ? `${piece} ${word}` : word
        }
      }
      if (piece) units.push(piece)
    }
  }

  const chunks: string[] = []
  let current = ''
  for (const unit of units) {
    if (current && `${current} ${unit}`.length > limit) {
      chunks.push(current)
      current = unit
    } else {
      current = current ? `${current} ${unit}` : unit
    }
  }
  if (current) chunks.push(current)

  return chunks
}

/**
 * Load once per process and keep the promise, so two scenes synthesizing at the same time
 * share one load instead of racing two 86 MB model initialisations.
 */
async function getModel(settings: AppSettings): Promise<KokoroTTS> {
  const source = modelSource(settings)

  if (modelPromise && loadedFrom === source) return modelPromise

  loadedFrom = source
  modelPromise = KokoroTTS.from_pretrained(source, {
    dtype: DEFAULT_DTYPE,
    device: 'cpu'
  }).catch((err: Error) => {
    // A failed load must not be cached, or every later scene inherits the first failure.
    modelPromise = null
    throw new Error(`Kokoro could not load its model (${source}): ${err.message}`)
  })

  return modelPromise
}

export const kokoroEngine: TtsEngine = {
  id: 'kokoro',

  async isAvailable(settings) {
    const dir = settings.kokoroModelDir?.trim()
    if (!dir) return true // falls back to the cached download
    try {
      await fs.access(dir)
      return true
    } catch {
      return false
    }
  },

  unavailableReason(settings) {
    const dir = settings.kokoroModelDir?.trim()
    if (dir) return `The Kokoro model folder could not be read: ${dir}`
    return ''
  },

  async listVoices(): Promise<TtsVoice[]> {
    return VOICES.map((voice) => ({ ...voice }))
  },

  async synthesize(text, voiceId, options, settings): Promise<SynthesizeResult> {
    const character = resolveVoiceCharacter(voiceId, 'kokoro')
    const speed = typeof options.speed === 'number' && options.speed > 0 ? options.speed : 1

    if (options.isCancelled?.()) throw new Error('Cancelled')

    const tts = await getModel(settings)

    try {
      const chunks = splitForKokoro(text)
      if (!chunks.length) throw new Error('There was no text to speak.')

      const pieces: Float32Array[] = []
      let sampleRate = 24_000

      for (const chunk of chunks) {
        // The one place a long narration can actually be interrupted mid-flight.
        if (options.isCancelled?.()) throw new Error('Cancelled')

        const audio = await tts.generate(chunk, { voice: character.id as never, speed })
        pieces.push(audio.audio)
        sampleRate = audio.sampling_rate
      }

      await fs.mkdir(dirname(options.outputPath), { recursive: true })
      await fs.writeFile(options.outputPath, wavFromFloatChunks(pieces, sampleRate))
    } catch (err) {
      const message = (err as Error).message
      if (message === 'Cancelled') throw err

      // A bad voice id is the one failure worth naming precisely — everything else gets
      // wrapped so the fallback chain's log line says which engine actually broke.
      if (/Voice ".*" not found/.test(message)) {
        throw new EngineUnavailableError(
          'kokoro',
          `${character.id} is not a Kokoro voice. Available: ${VOICES.map((v) => v.id).join(', ')}`
        )
      }
      throw new Error(`Kokoro failed: ${message}`)
    }

    if (options.isCancelled?.()) throw new Error('Cancelled')

    return {
      audioPath: options.outputPath,
      durationSeconds: await probeDuration(options.outputPath),
      // Kokoro reports no timings; the caption builder spreads cues across the narration.
      engine: 'kokoro',
      voiceId: character.id
    }
  },

  async test(settings) {
    const probe = join(tmpdir(), `zbot-kokoro-test-${process.pid}.wav`)
    try {
      const tts = await getModel(settings)
      const audio = await tts.generate('This is a test.', {
        voice: 'am_eric' as never,
        speed: 1
      })

      await fs.writeFile(probe, wavFromFloatChunks([audio.audio], audio.sampling_rate))
      const duration = await probeDuration(probe)
      const source = modelSource(settings)
      return {
        ok: true,
        message: `Ready — ${VOICES.length} voices, model ${source}, ${duration.toFixed(1)}s.`
      }
    } catch (err) {
      return { ok: false, message: (err as Error).message }
    } finally {
      await fs.rm(probe, { force: true }).catch(() => undefined)
    }
  }
}
