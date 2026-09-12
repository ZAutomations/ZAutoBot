/**
 * The Script AI conversation.
 *
 * A skill plus a title goes in; a complete, importer-ready script package comes out. The
 * conversation is driven by three rules the spec calls out as load-bearing:
 *
 * 1. **Batching.** Skills chunk their output and end each batch with a marker
 *    ("SAY CONTINUE", "BATCH n COMPLETE"). The marker is the skill's own instruction, so
 *    the loop only has to recognise a marker-shaped tail and send "CONTINUE".
 * 2. **Truncation resume.** A reply that hits the output-token limit ends mid-sentence
 *    with no marker — and a 10KB fragment saved as "finished" becomes an import that
 *    fails with "Scene 1 has no image prompt". A cut-off tail is detected and pushed to
 *    continue from exactly where it stopped.
 * 3. **Key rotation.** The pool hands out keys; a quota error mid-conversation benches
 *    the key and continues on the next one. The transcript lives here, so the model
 *    never knows the key changed.
 *
 * The finished package is written to `userData/generated-scripts/<title>.md` and handed
 * to the same importer as a user file — generated scripts get no special treatment.
 */
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import {
  DEFAULT_SCRIPT_AI_MODEL,
  SCRIPT_AI_MAX_NUDGES,
  SCRIPT_AI_MAX_ROUNDS
} from '@shared/constants'
import type { JobMode, ScriptImportResult } from '@shared/types'
import { parseScriptText } from '../script/parse'
import { validateScript } from '../script/validate'
import { paths } from '../store/paths'
import { chatCompletion, QuotaError, RetiredModelError, type ChatMessage } from './gemini'
import { poolFromSettings, type KeyPool } from './keys'
import type { AppSettings } from '@shared/types'
import { loadSettings } from '../store/settings'

/** What the UI sees while a package is being written. */
export interface ScriptAiProgress {
  round: number
  chars: number
  /** The last line or so of the model's output — proof it is alive and on track. */
  tail: string
  /** Set when the loop is waiting out a quota/spacing delay rather than writing. */
  waitingMs?: number
}

export interface GenerateInput {
  /** The skill's full markdown. */
  skillContent: string
  /** What the video is about, in the user's words. */
  title: string
  /** The importer validates against the mode, so the generator must know it too. */
  mode: JobMode
  /** Called on every progress-worthy change. */
  onProgress?: (progress: ScriptAiProgress) => void
  /** Returns true when the user pressed Cancel. */
  isCancelled?: () => boolean
}

/** Marker-shaped tails a skill may instruct the model to end a batch with. */
const BATCH_MARKER = /(?:say\s+)?(?:type\s+)?(?:continue|batch\s+\d+\s+complete|next\s+batch)\s*[.!]?\s*$/i

function buildMessages(skillContent: string, title: string): ChatMessage[] {
  return [
    {
      role: 'system',
      content:
        'You are a script writer for short-form video. You follow the SKILL below exactly — ' +
        'its rules, its format, its length, its tone. The package you write must use this ' +
        'exact layout so a deterministic importer can read it:\n\n' +
        'Title: <the title>\n\n' +
        'For every scene:\n' +
        'Scene <n>: <short scene label>\nNarration: <what the narrator says>\n' +
        'Image: <a rich, self-contained image-generation prompt>\nMood: <one word>\n\n' +
        'You may mark a few scenes as stock footage instead — the opener, establishing ' +
        'shots, transitions, real-world b-roll. For those scenes write this line instead ' +
        'of the Image line:\n' +
        'Footage: <2-5 plain stock-search words, e.g. "aerial city traffic night">\n\n' +
        'Keep Footage to at most a third of the scenes; scenes that tell the story or ' +
        'show something specific stay as generated images.\n\n' +
        'End with:\nThumbnail: <one image prompt for the cover frame>\n\n' +
        'If your instructions say to work in batches and end a batch with a marker ' +
        '(like SAY CONTINUE), do exactly that — the user will say CONTINUE and you resume ' +
        'without repeating anything already written.\n\n' +
        '=== SKILL START ===\n' +
        skillContent +
        '\n=== SKILL END ==='
    },
    {
      role: 'user',
      content: `Write the complete package for a video titled: ${title}`
    }
  ]
}

function report(input: GenerateInput, round: number, text: string, waitingMs?: number): void {
  input.onProgress?.({
    round,
    chars: text.length,
    tail: text.slice(-160).replace(/\s+/g, ' ').trim(),
    waitingMs
  })
}

/**
 * Does this look cut off rather than finished?
 *
 * The reliable signal is the package itself: a finished package parses into numbered
 * scenes with image prompts. A fragment does not. The punctuation check catches a cut
 * mid-narration that still happens to parse — those resumes too, because a missing final
 * period usually means a missing final scene.
 */
function looksTruncated(text: string): boolean {
  const tail = text.trimEnd()
  if (!tail) return true
  if (!/[.!?"'\]]$/.test(tail)) return true

  const parsed = parseScriptText(text, 'generation')
  const withPrompts = parsed.scenes.filter(
    (scene) => scene.imagePrompt && scene.imagePrompt.trim().length > 0
  )
  return withPrompts.length < 3
}

async function waitOut(ms: number, input: GenerateInput, round: number, text: string): Promise<void> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (input.isCancelled?.()) throw new Error('Cancelled.')
    // Report often enough that the UI's clock keeps moving; the numbers change each time.
    const remaining = deadline - Date.now()
    report(input, round, text, remaining)
    await new Promise((resolve) => setTimeout(resolve, Math.min(2_000, Math.max(100, remaining))))
  }
}

/**
 * Run one streamed completion, dealing with everything the endpoint can throw.
 *
 * Quota errors bench the key and retry on the next one (the conversation does not
 * restart — the same messages go out again and the model resumes from its own last
 * words). A retired model falls back to the default alias exactly once; the dead id is
 * memoized in `gemini.ts` so later requests skip straight to the alias.
 */
async function completeWithPool(
  pool: KeyPool,
  model: string,
  messages: ChatMessage[],
  input: GenerateInput,
  round: number,
  text: string,
  onDelta: (fragment: string) => void
): Promise<string> {
  let retiredRetried = false

  for (;;) {
    if (input.isCancelled?.()) throw new Error('Cancelled.')

    const { key, waitMs } = await pool.acquire()
    if (waitMs > 0) await waitOut(waitMs, input, round, text)

    try {
      return await chatCompletion({ key, model, messages, onDelta })
    } catch (err) {
      if (err instanceof QuotaError) {
        pool.bench(key, err.retryDelayMs)
        if (pool.size <= 1 && err.retryDelayMs) {
          // One key, benched for a known time: the wait IS the retry.
          await waitOut(err.retryDelayMs, input, round, text)
        }
        continue
      }
      if (err instanceof RetiredModelError && !retiredRetried) {
        retiredRetried = true
        model = DEFAULT_SCRIPT_AI_MODEL
        continue
      }
      if (err instanceof Error && /returned 5\d\d/.test(err.message)) {
        // 5xx-shaped failures: brief pause, same key, try once more before surfacing.
        await waitOut(pool.serverErrorRetryMs, input, round, text)
        continue
      }
      throw err
    }
  }
}

export async function generatePackage(input: GenerateInput): Promise<ScriptImportResult> {
  const settings = await loadSettings()
  const model = settings.scriptAiModel || DEFAULT_SCRIPT_AI_MODEL
  const pool = poolFromSettings(settings)
  if (pool.size === 0) {
    throw new Error(
      'No Script AI key is configured — add one or more Gemini API keys in Settings → Script AI.'
    )
  }

  const messages = buildMessages(input.skillContent, input.title)
  let text = ''
  let nudges = 0

  for (let round = 1; round <= SCRIPT_AI_MAX_ROUNDS; round++) {
    if (input.isCancelled?.()) throw new Error('Cancelled.')

    // This round's output alone — the conversation gets one assistant message per round,
    // each holding only what that round produced, exactly like a real chat transcript.
    let roundText = ''
    const reply = await completeWithPool(
      pool,
      model,
      messages,
      input,
      round,
      text,
      (fragment) => {
        roundText += fragment
        text += fragment
        report(input, round, text)
      }
    )
    if (reply.length > roundText.length) {
      text += reply.slice(roundText.length)
      roundText = reply
      report(input, round, text)
    }

    messages.push({ role: 'assistant', content: roundText })

    const tail = text.trimEnd()
    const marker = BATCH_MARKER.exec(tail)

    if (marker && round < SCRIPT_AI_MAX_ROUNDS) {
      // The marker is the skill's paging instruction, not package content. Strip it and
      // start the next batch on a fresh line — otherwise a marker without a trailing
      // newline glues itself to the next round's "Scene 2:" and the importer sees one
      // scene fewer than was written. A cut-off resume is the opposite case: there the
      // next round joins verbatim, so a word sliced in half comes back whole.
      text = tail.slice(0, marker.index) + '\n\n'
      messages.push({ role: 'user', content: 'CONTINUE' })
      continue
    }

    if (looksTruncated(text)) {
      if (nudges >= SCRIPT_AI_MAX_NUDGES) break
      nudges++
      messages.push({
        role: 'user',
        content:
          'Your output was cut off. CONTINUE from exactly where you stopped — do not repeat anything.'
      })
      continue
    }

    break
  }

  if (input.isCancelled?.()) throw new Error('Cancelled.')

  // Same importer as a user file — a generated script is not a special format.
  const script = parseScriptText(text, `${input.title}.md`)
  const validation = validateScript(script, input.mode)

  const dir = paths.generatedScriptsDir()
  await fs.mkdir(dir, { recursive: true })
  const safeName = (script.title || input.title || 'generated')
    .replace(/[<>:"/\\|?*]/g, '')
    .trim()
    .slice(0, 80)
  const filePath = join(dir, `${safeName}.md`)
  await fs.writeFile(filePath, text, 'utf8')

  return { script, validation, filePath }
}

/** A quick settings-page test: one tiny request, streamed, against the given keys. */
export async function testScriptAi(pending?: Partial<AppSettings>): Promise<{ ok: boolean; message: string }> {
  const settings = { ...(await loadSettings()), ...pending }
  const pool = poolFromSettings(settings)
  if (pool.size === 0) return { ok: false, message: 'No key entered.' }

  const model = settings.scriptAiModel || DEFAULT_SCRIPT_AI_MODEL
  try {
    const reply = await completeWithPool(
      pool,
      model,
      [{ role: 'user', content: 'Reply with the single word: OK' }],
      { skillContent: '', title: '', mode: 'video' },
      1,
      '',
      () => undefined
    )
    return { ok: true, message: `Model answered: ${reply.trim().slice(0, 40) || '(empty)'}` }
  } catch (err) {
    return { ok: false, message: (err as Error).message }
  }
}
