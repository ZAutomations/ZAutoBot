/**
 * The Gemini chat request, over its OpenAI-compatible endpoint.
 *
 * `https://generativelanguage.googleapis.com/v1beta/openai/chat/completions` speaks the
 * chat-completions shape with `Authorization: Bearer <key>`, so no SDK is needed — a
 * plain `fetch` with an SSE-streamed response. Streaming matters here for one reason:
 * the model can write for minutes, and the user needs to see it is alive.
 */
import { DEFAULT_SCRIPT_AI_MODEL } from '@shared/constants'

/**
 * The OpenAI-compatible chat base URL.
 *
 * Read per request, not at module load — the development test (`ZBOT_SCRIPTAI`) starts a
 * local mock server and points the whole conversation at it, proving key rotation, batch
 * markers and truncation resume without spending a real key.
 */
function baseUrl(): string {
  return process.env['ZBOT_SCRIPTAI_URL'] ?? 'https://generativelanguage.googleapis.com/v1beta/openai'
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export class QuotaError extends Error {
  /** How long Google asked us to wait, when it said. */
  constructor(
    message: string,
    readonly retryDelayMs?: number
  ) {
    super(message)
  }
}

export class RetiredModelError extends Error {}

/** Model ids that 404'd this session — see `generate.ts` for why they are memoized. */
const deadModelIds = new Set<string>()

export function isDeadModel(model: string): boolean {
  return deadModelIds.has(model)
}

/**
 * One streamed chat completion.
 *
 * Resolves with the full text. `onDelta` receives each fragment as it arrives so the UI
 * can show progress without waiting for the whole reply.
 */
export async function chatCompletion(options: {
  key: string
  model: string
  messages: ChatMessage[]
  signal?: AbortSignal
  onDelta?: (fragment: string) => void
}): Promise<string> {
  const model = deadModelIds.has(options.model) ? DEFAULT_SCRIPT_AI_MODEL : options.model

  const response = await fetch(`${baseUrl()}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${options.key}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model,
      messages: options.messages,
      stream: true
    }),
    signal: options.signal
  })

  if (response.status === 404) {
    const body = await response.text()
    if (/no longer available|not found|not supported/i.test(body)) {
      deadModelIds.add(options.model)
      throw new RetiredModelError(
        `The model "${options.model}" is gone (Google retired it). Retrying with "${DEFAULT_SCRIPT_AI_MODEL}".`
      )
    }
    throw new Error(`Gemini returned 404 for this model: ${shorten(body)}`)
  }

  if (response.status === 429) {
    throw new QuotaError(
      'This Gemini key hit its quota.',
      parseRetryDelay(await response.text())
    )
  }

  if (!response.ok) {
    const body = await response.text()
    // RESOURCE_EXHAUSTED sometimes arrives as 200-with-error or 500; catch it either way.
    if (response.status >= 500 || /RESOURCE_EXHAUSTED/i.test(body)) {
      throw new QuotaError('Gemini refused the request (server-side).', undefined)
    }
    throw new Error(`Gemini returned ${response.status}: ${shorten(body)}`)
  }

  if (!response.body) throw new Error('Gemini returned no response body.')

  return readStream(response.body, options.onDelta)
}

/** Pull `retryDelay` out of a 429 body, e.g. `"retryDelay": "37s"`. */
function parseRetryDelay(body: string): number | undefined {
  const match = /"retryDelay"\s*:\s*"(?:(\d+)s|(\d+)ms)"/.exec(body)
  if (!match) return undefined
  if (match[1]) return Number(match[1]) * 1000
  if (match[2]) return Number(match[2])
  return undefined
}

async function readStream(
  body: ReadableStream<Uint8Array>,
  onDelta?: (fragment: string) => void
): Promise<string> {
  const decoder = new TextDecoder()
  let text = ''
  let buffer = ''

  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true })

    // SSE frames are separated by a blank line; each data line carries one JSON delta.
    let newline: number
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)
      if (!line.startsWith('data:')) continue
      const data = line.slice(5).trim()
      if (data === '[DONE]') return text

      const delta = extractDelta(data)
      if (delta) {
        text += delta
        onDelta?.(delta)
      }
    }
  }

  return text
}

function extractDelta(data: string): string | null {
  try {
    const parsed = JSON.parse(data) as {
      choices?: Array<{ delta?: { content?: string } }>
    }
    return parsed.choices?.[0]?.delta?.content ?? null
  } catch {
    // A frame that is not JSON is not worth failing a generation over.
    return null
  }
}

function shorten(body: string): string {
  const one = body.replace(/\s+/g, ' ').trim()
  return one.length > 200 ? `${one.slice(0, 200)}…` : one
}
