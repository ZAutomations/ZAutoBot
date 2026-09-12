/**
 * Gemini TTS — Google's expressive star-named voices (Sulafat, Charon, Kore…).
 *
 * There are two ways in, and they are not equivalent:
 *
 *   • service account → Cloud `text:synthesize`. This is the path that carries TTS quota,
 *     and the only one that accepts a natural-language style prompt and a speaking rate.
 *   • API key → the Gemini `interactions` endpoint. Voice only — no style, no rate. Keys
 *     minted in AI Studio routinely report `limit: 0` for TTS models, so this is the
 *     fallback, never the default.
 *
 * A configured service account always wins.
 *
 * Both transports cap one request at roughly 4000 bytes of input. Long narration is split
 * on sentence boundaries, synthesized in pieces and stitched back into a single WAV —
 * without that, everything past the first ~3800 bytes is silently dropped and the video
 * ships with a truncated voiceover.
 */
import { createSign } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { GEMINI_TTS_MODELS } from '@shared/constants'
import type {
  AppSettings,
  SynthesizeOptions,
  SynthesizeResult,
  TtsVoice
} from '@shared/types'
import { probeDuration } from '../../video/ffprobe'
import { resolveVoiceCharacter } from '../resolveVoice'
import { EngineUnavailableError, type TtsEngine } from '../types'
import { buildWav, type Pcm } from '../wav'

const CLOUD_ENDPOINT = 'https://texttospeech.googleapis.com/v1/text:synthesize'
const INTERACTIONS_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/interactions'
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token'

/** Input cap per request, in UTF-8 bytes, with room left for the JSON envelope. */
const MAX_INPUT_BYTES = 3800

/** A `-pro-tts` / preview model can take 70–120s on a long chunk. */
const REQUEST_TIMEOUT_MS = 240_000

const CHUNK_ATTEMPTS = 3

/**
 * Google's 30 Gemini TTS voices. The descriptor is Google's own one-word character note,
 * which is genuinely the most useful thing to show in a dropdown.
 */
const VOICES: Array<{ id: string; tone: string; gender: 'Male' | 'Female' }> = [
  { id: 'Zephyr', tone: 'Bright', gender: 'Female' },
  { id: 'Charon', tone: 'Informative', gender: 'Male' },
  { id: 'Fenrir', tone: 'Excitable', gender: 'Male' },
  { id: 'Puck', tone: 'Upbeat', gender: 'Male' },
  { id: 'Kore', tone: 'Firm', gender: 'Female' },
  { id: 'Leda', tone: 'Youthful', gender: 'Female' },
  { id: 'Orus', tone: 'Firm', gender: 'Male' },
  { id: 'Aoede', tone: 'Breezy', gender: 'Female' },
  { id: 'Callirrhoe', tone: 'Easy-going', gender: 'Female' },
  { id: 'Autonoe', tone: 'Bright', gender: 'Female' },
  { id: 'Enceladus', tone: 'Breathy', gender: 'Male' },
  { id: 'Iapetus', tone: 'Clear', gender: 'Male' },
  { id: 'Umbriel', tone: 'Easy-going', gender: 'Male' },
  { id: 'Algieba', tone: 'Smooth', gender: 'Male' },
  { id: 'Despina', tone: 'Smooth', gender: 'Female' },
  { id: 'Erinome', tone: 'Clear', gender: 'Female' },
  { id: 'Algenib', tone: 'Gravelly', gender: 'Male' },
  { id: 'Rasalgethi', tone: 'Informative', gender: 'Male' },
  { id: 'Laomedeia', tone: 'Upbeat', gender: 'Female' },
  { id: 'Achernar', tone: 'Soft', gender: 'Female' },
  { id: 'Alnilam', tone: 'Firm', gender: 'Male' },
  { id: 'Schedar', tone: 'Even', gender: 'Male' },
  { id: 'Gacrux', tone: 'Mature', gender: 'Female' },
  { id: 'Pulcherrima', tone: 'Forward', gender: 'Female' },
  { id: 'Achird', tone: 'Friendly', gender: 'Male' },
  { id: 'Zubenelgenubi', tone: 'Casual', gender: 'Male' },
  { id: 'Vindemiatrix', tone: 'Gentle', gender: 'Female' },
  { id: 'Sadachbia', tone: 'Lively', gender: 'Male' },
  { id: 'Sadaltager', tone: 'Knowledgeable', gender: 'Male' },
  { id: 'Sulafat', tone: 'Warm', gender: 'Female' }
]

/**
 * Scene mood → a plain-English delivery instruction. Only sent on the service-account
 * path, because the API-key path has no field for it.
 */
const MOOD_STYLE: Array<{ pattern: RegExp; style: string }> = [
  {
    pattern: /calm|serene|peace|gentle|soft|somber|melanchol/,
    style: 'Read slowly and calmly, in a soft, even tone.'
  },
  {
    pattern: /energ|excit|hype|action|fast|urgent|intense/,
    style: 'Read with energy and momentum, bright and engaged.'
  },
  {
    pattern: /mysteri|dark|tense|suspense|eerie|horror|creep/,
    style: 'Read in a low, hushed, suspenseful tone, with deliberate pacing.'
  },
  {
    pattern: /happy|warm|joy|bright|fun|upbeat|cheer/,
    style: 'Read warmly and cheerfully, as if smiling.'
  },
  {
    pattern: /drama|epic|cinematic|grand|majestic|sweep|awe/,
    style: 'Read with cinematic gravitas and measured, weighty pacing.'
  },
  {
    pattern: /hope|rise|grow|progress|inspir|triumph/,
    style: 'Read with quiet conviction, building gently toward hope.'
  }
]

function styleFor(options: SynthesizeOptions, settings: AppSettings): string {
  const explicit = settings.geminiStyle?.trim()
  if (explicit) return explicit

  const mood = MOOD_STYLE.find((entry) => entry.pattern.test(options.mood ?? ''))
  return mood?.style ?? ''
}

// ---------------------------------------------------------------------------
// Text chunking
// ---------------------------------------------------------------------------

/**
 * Split text so every piece fits the byte cap, breaking on sentence, then clause, then
 * word boundaries so no words are dropped.
 */
export function splitToChunks(text: string, limit: number): string[] {
  const trimmed = text.trim()
  if (!trimmed) return []
  if (Buffer.byteLength(trimmed, 'utf8') <= limit) return [trimmed]

  const chunks: string[] = []
  let current = ''

  const flush = (): void => {
    if (current.trim()) chunks.push(current.trim())
    current = ''
  }

  for (const sentence of trimmed.split(/(?<=[.!?…])\s+/)) {
    if (!sentence) continue

    // A single sentence over the cap has to be broken down further.
    if (Buffer.byteLength(sentence, 'utf8') > limit) {
      flush()
      let piece = ''
      for (const word of sentence.split(/\s+/)) {
        const candidate = piece ? `${piece} ${word}` : word
        if (Buffer.byteLength(candidate, 'utf8') > limit) {
          if (piece.trim()) chunks.push(piece.trim())
          // A single word longer than the cap can only be cut.
          piece = truncateToBytes(word, limit)
        } else {
          piece = candidate
        }
      }
      current = piece
      continue
    }

    const candidate = current ? `${current} ${sentence}` : sentence
    if (Buffer.byteLength(candidate, 'utf8') > limit) {
      flush()
      current = sentence
    } else {
      current = candidate
    }
  }

  flush()
  return chunks
}

/** Longest prefix of `text` whose UTF-8 encoding fits in `limit` bytes. */
function truncateToBytes(text: string, limit: number): string {
  if (Buffer.byteLength(text, 'utf8') <= limit) return text
  let low = 0
  let high = text.length
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    if (Buffer.byteLength(text.slice(0, mid), 'utf8') <= limit) low = mid
    else high = mid - 1
  }
  return text.slice(0, low)
}

// ---------------------------------------------------------------------------
// PCM extraction
// ---------------------------------------------------------------------------

/** Gemini's developer endpoint returns raw 24 kHz mono 16-bit PCM; Cloud returns RIFF. */
const RAW_PCM: Omit<Pcm, 'data'> = { sampleRate: 24_000, channels: 1, bitsPerSample: 16 }

/** Strip the container off a reply, leaving bare samples ready to be stitched. */
function parseAudio(bytes: Buffer): Pcm {
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF') {
    const channels = bytes.readUInt16LE(22)
    const sampleRate = bytes.readUInt32LE(24)
    const bitsPerSample = bytes.readUInt16LE(34)
    const dataStart = bytes.indexOf('data', 12, 'ascii')

    if (dataStart !== -1) {
      const size = bytes.readUInt32LE(dataStart + 4)
      const from = dataStart + 8
      // A truncated/streamed file can claim more than it holds — trust the buffer.
      const to = Math.min(from + size, bytes.length)
      return { data: bytes.subarray(from, to), sampleRate, channels, bitsPerSample }
    }
    // Header we cannot make sense of: treat the whole thing as opaque payload.
    return { data: bytes, sampleRate, channels, bitsPerSample }
  }

  return { data: bytes, ...RAW_PCM }
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

interface ServiceAccountKey {
  client_email: string
  private_key: string
  project_id?: string
}

interface CachedToken {
  token: string
  expiresAt: number
}

/** Keyed by service-account path. Tokens last an hour; refresh well before that. */
const tokenCache = new Map<string, CachedToken>()

/**
 * The API-key endpoint silently drops the style prompt and speaking rate. Warning once per
 * process is enough to be honest about it without spamming a hundred-chunk narration.
 */
let warnedAboutApiKeyLimits = false

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url')
}

/**
 * Sign a JWT assertion and trade it for an OAuth2 access token.
 *
 * This is the `google-auth` service-account flow reimplemented on node:crypto — the whole
 * point of the service-account path is that it is the one with TTS quota, so it is worth
 * the thirty lines.
 */
async function getAccessToken(serviceAccountPath: string): Promise<string> {
  const cached = tokenCache.get(serviceAccountPath)
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token

  const raw = await fs.readFile(serviceAccountPath, 'utf8')
  const key = JSON.parse(raw) as ServiceAccountKey

  if (!key.client_email || !key.private_key) {
    throw new EngineUnavailableError(
      'gemini',
      `That file is not a service-account key (no client_email/private_key): ${serviceAccountPath}`
    )
  }

  const now = Math.floor(Date.now() / 1000)
  const signingInput = [
    base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' })),
    base64url(
      JSON.stringify({
        iss: key.client_email,
        scope: 'https://www.googleapis.com/auth/cloud-platform',
        aud: TOKEN_ENDPOINT,
        iat: now,
        exp: now + 3600
      })
    )
  ].join('.')

  const signer = createSign('RSA-SHA256')
  signer.update(signingInput)
  const assertion = `${signingInput}.${base64url(signer.sign(key.private_key))}`

  const response = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion
    }),
    signal: AbortSignal.timeout(30_000)
  })

  const payload = (await response.json()) as { access_token?: string; error_description?: string }
  if (!response.ok || !payload.access_token) {
    throw new EngineUnavailableError(
      'gemini',
      payload.error_description ?? `Token request failed (HTTP ${response.status})`
    )
  }

  tokenCache.set(serviceAccountPath, {
    token: payload.access_token,
    expiresAt: Date.now() + 50 * 60_000
  })
  return payload.access_token
}

/** The project the service account belongs to, needed as a quota-billing header. */
async function serviceAccountProject(path: string): Promise<string> {
  try {
    const key = JSON.parse(await fs.readFile(path, 'utf8')) as ServiceAccountKey
    return key.project_id ?? ''
  } catch {
    return ''
  }
}

function readServiceAccountPath(settings: AppSettings): string {
  return settings.geminiServiceAccountPath?.trim() ?? ''
}

// ---------------------------------------------------------------------------
// Synthesis
// ---------------------------------------------------------------------------

interface SpeechRequest {
  text: string
  voiceId: string
  model: string
  style: string
  speed: number
  settings: AppSettings
}

async function postJson(
  url: string,
  body: unknown,
  headers: Record<string, string>
): Promise<{ ok: boolean; data: unknown; error: string }> {
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    })

    const text = await response.text()
    let data: unknown = null
    try {
      data = JSON.parse(text)
    } catch {
      return { ok: false, data: null, error: `HTTP ${response.status}: ${text.slice(0, 300)}` }
    }

    if (!response.ok) {
      const message =
        (data as { error?: { message?: string } })?.error?.message ??
        `HTTP ${response.status}: ${text.slice(0, 300)}`
      return { ok: false, data, error: message }
    }

    return { ok: true, data, error: '' }
  } catch (err) {
    return { ok: false, data: null, error: (err as Error).message }
  }
}

/** Pull base64 audio out of whichever shape the endpoint replied with. */
function extractAudioBase64(data: unknown): string {
  const root = data as Record<string, unknown>
  const outputAudio = (root?.output_audio ?? root?.outputAudio ?? {}) as Record<string, unknown>

  const direct =
    (outputAudio.data as string) ||
    (outputAudio.audioData as string) ||
    (root?.audioContent as string) ||
    (root?.data as string)
  if (direct) return direct

  const candidates = (root?.candidates ?? []) as Array<{
    content?: { parts?: Array<{ inlineData?: { mimeType?: string; data?: string } }> }
  }>
  for (const candidate of candidates) {
    for (const part of candidate.content?.parts ?? []) {
      const inline = part.inlineData
      if (inline?.mimeType?.startsWith('audio/') && inline.data) return inline.data
    }
  }

  return ''
}

async function synthesizeChunk(request: SpeechRequest): Promise<Pcm> {
  const { text, voiceId, model, style, speed, settings } = request
  const serviceAccount = readServiceAccountPath(settings)

  if (serviceAccount) {
    const token = await getAccessToken(serviceAccount)
    const project = await serviceAccountProject(serviceAccount)

    const input: Record<string, string> = { text }
    if (style) input.prompt = style

    const result = await postJson(
      CLOUD_ENDPOINT,
      {
        input,
        voice: { languageCode: 'en-US', modelName: model, name: voiceId },
        audioConfig: { audioEncoding: 'LINEAR16', speakingRate: speed }
      },
      {
        Authorization: `Bearer ${token}`,
        ...(project ? { 'x-goog-user-project': project } : {})
      }
    )

    if (!result.ok) throw new Error(result.error)
    const audio = extractAudioBase64(result.data)
    if (!audio) throw new Error('The response carried no audio.')
    return parseAudio(Buffer.from(audio, 'base64'))
  }

  // API-key fallback. No style, no speed — the endpoint has no field for either, and
  // sending unknown fields is what makes strict APIs reject a request outright.
  if (!warnedAboutApiKeyLimits && (style || speed !== 1)) {
    warnedAboutApiKeyLimits = true
    console.warn(
      '[gemini] the API-key endpoint supports neither the style prompt nor speaking rate; ' +
        'both are being ignored. Point Settings → Gemini TTS at a service-account JSON to use them.'
    )
  }

  const key = settings.geminiKey?.trim() ?? ''
  const result = await postJson(
    `${INTERACTIONS_ENDPOINT}?key=${encodeURIComponent(key)}`,
    {
      model,
      input: text,
      response_format: { type: 'audio' },
      generation_config: { speech_config: [{ voice: voiceId }] }
    },
    {}
  )

  if (!result.ok) throw new Error(result.error)
  const audio = extractAudioBase64(result.data)
  if (!audio) throw new Error('The response carried no audio.')
  return parseAudio(Buffer.from(audio, 'base64'))
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** Synthesize a whole narration into `outputPath`, chunked and stitched. */
async function synthesizeToFile(
  text: string,
  voiceId: string,
  options: SynthesizeOptions,
  settings: AppSettings
): Promise<void> {
  const style = styleFor(options, settings)
  const model = settings.geminiModel?.trim() || GEMINI_TTS_MODELS[0]
  const speed = typeof options.speed === 'number' && options.speed > 0 ? options.speed : 1

  // The style prompt travels in the same request body, so it eats into the byte budget.
  const budget = Math.max(200, MAX_INPUT_BYTES - Buffer.byteLength(style, 'utf8') - 50)
  const chunks = splitToChunks(text, budget)
  if (!chunks.length) throw new Error('There was no text to speak.')

  const parts: Pcm[] = []

  for (const [index, chunk] of chunks.entries()) {
    if (options.isCancelled?.()) throw new Error('Cancelled')

    let lastError = ''
    let audio: Pcm | null = null

    for (let attempt = 1; attempt <= CHUNK_ATTEMPTS; attempt++) {
      try {
        audio = await synthesizeChunk({ text: chunk, voiceId, model, style, speed, settings })
        break
      } catch (err) {
        lastError = (err as Error).message
        if (attempt === CHUNK_ATTEMPTS) break
        // Rate limiting is the common failure and it clears on its own; back off hard.
        await sleep(lastError.includes('429') ? 20_000 : 4_000 * attempt)
      }
    }

    if (!audio) {
      throw new Error(
        chunks.length > 1
          ? `Gemini TTS failed on part ${index + 1} of ${chunks.length}: ${lastError}`
          : lastError
      )
    }

    parts.push(audio)
  }

  const first = parts[0]
  await fs.mkdir(dirname(options.outputPath), { recursive: true })
  await fs.writeFile(
    options.outputPath,
    buildWav({
      data: Buffer.concat(parts.map((part) => part.data)),
      sampleRate: first.sampleRate,
      channels: first.channels,
      bitsPerSample: first.bitsPerSample
    })
  )
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

export const geminiEngine: TtsEngine = {
  id: 'gemini',

  async isAvailable(settings) {
    const serviceAccount = readServiceAccountPath(settings)
    if (serviceAccount) {
      try {
        await fs.access(serviceAccount)
        return true
      } catch {
        return false
      }
    }
    return Boolean(settings.geminiKey?.trim())
  },

  unavailableReason(settings) {
    const serviceAccount = readServiceAccountPath(settings)
    if (!serviceAccount && !settings.geminiKey?.trim()) {
      return 'Add a service-account JSON path or an API key in Settings.'
    }
    return `The service-account file could not be read: ${serviceAccount}`
  },

  async listVoices(): Promise<TtsVoice[]> {
    return VOICES.map((voice) => ({
      id: voice.id,
      name: `${voice.id} — ${voice.tone}`,
      // The Gemini voices are multilingual; they are not tied to one locale.
      locale: 'multi',
      gender: voice.gender
    }))
  },

  async synthesize(text, voiceId, options, settings): Promise<SynthesizeResult> {
    if (!(await geminiEngine.isAvailable(settings))) {
      throw new EngineUnavailableError('gemini', geminiEngine.unavailableReason(settings))
    }

    // Never `undefined` — an unpicked voice costs the run its preferred voice, not the run.
    const character = resolveVoiceCharacter(
      voiceId,
      'gemini',
      await geminiEngine.listVoices(settings)
    )

    await synthesizeToFile(text, character.id, options, settings)

    if (options.isCancelled?.()) throw new Error('Cancelled')

    return {
      audioPath: options.outputPath,
      durationSeconds: await probeDuration(options.outputPath),
      // No word timings: the endpoint does not report them, and a spread-even guess is
      // exactly what the caption builder already does with the narration.
      engine: 'gemini',
      voiceId: character.id
    }
  },

  async test(settings) {
    // A real, tiny synthesis rather than just an auth check — the failure this needs to
    // catch is a key that authenticates fine but is refused by the TTS models.
    const probe = join(tmpdir(), `zbot-gemini-test-${process.pid}.wav`)
    try {
      await synthesizeToFile('This is a test.', 'Sulafat', { outputPath: probe }, settings)
      const duration = await probeDuration(probe)
      const via = readServiceAccountPath(settings) ? 'service account' : 'API key'
      return { ok: true, message: `Ready via ${via} — synthesized ${duration.toFixed(1)}s.` }
    } catch (err) {
      return { ok: false, message: (err as Error).message }
    } finally {
      await fs.rm(probe, { force: true }).catch(() => undefined)
    }
  }
}
