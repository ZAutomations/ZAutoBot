/**
 * TTS engine check (development only).
 *
 *     npm run build
 *     ZBOT_TTS=kokoro npx electron .
 *     ZBOT_TTS=gemini ZBOT_GEMINI_SA="D:\\path\\to\\sa.json" npx electron .
 *
 * Synthesizes one line through the named engine and reports what came back — voice count,
 * file size, measured duration. It is how you tell "the engine is wired up" apart from
 * "the engine produced audio", which are very different failures.
 *
 * Never runs unless `ZBOT_TTS` is set.
 */
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { app } from 'electron'
import type { AppSettings, TtsProviderId } from '@shared/types'
import { loadSettings } from '../store/settings'
import { getEngine, engineAvailability } from '../tts/registry'
import { probe } from '../video/ffprobe'

/** ~120 characters: one request for most engines. `ZBOT_TTS_TEXT` overrides it. */
const LINE =
  'The ocean keeps most of its secrets. We have mapped the Moon more carefully than the floor beneath us.'

export async function runTtsTest(): Promise<void> {
  const engineId = (process.env['ZBOT_TTS'] ?? '').trim() as TtsProviderId
  const engine = getEngine(engineId)

  const fail = (message: string): void => {
    console.error(`\n[tts] FAIL — ${message}\n`)
    app.exit(1)
  }

  if (!engine) {
    fail(`unknown engine "${engineId}". Known: ${(await engineAvailability(await loadSettings())).map((e) => e.meta.id).join(', ')}`)
    return
  }

  const settings: AppSettings = { ...(await loadSettings()) }
  // Env overrides exist so an engine can be tried without saving settings first.
  if (process.env['ZBOT_GEMINI_SA']) {
    settings.geminiServiceAccountPath = process.env['ZBOT_GEMINI_SA']
  }
  if (process.env['ZBOT_KOKORO_DIR']) {
    settings.kokoroModelDir = process.env['ZBOT_KOKORO_DIR']
  }

  // A long `ZBOT_TTS_TEXT` is how you exercise an engine's chunking and stitching path,
  // which a one-sentence line never reaches.
  const line = (process.env['ZBOT_TTS_TEXT'] ?? '').trim() || LINE

  console.log(`[tts] engine: ${engineId}`)
  const available = await engine.isAvailable(settings)
  // A reason is only meaningful for a blocked engine — see `TtsEngine.unavailableReason`.
  console.log(`[tts] available: ${available}${available ? '' : ` — ${engine.unavailableReason(settings)}`}`)
  console.log(`[tts] text: ${line.length} chars`)

  const started = Date.now()
  const voices = await engine.listVoices(settings)
  console.log(`[tts] voices: ${voices.length}`)
  if (!voices.length) fail('the engine listed no voices')
  for (const voice of voices.slice(0, 3)) {
    console.log(`  ${voice.id}  ${voice.name}  ${voice.locale}  ${voice.gender ?? ''}`)
  }

  const outputPath = join(tmpdir(), `zbot-tts-${engineId}-${process.pid}.wav`)
  const result = await engine.synthesize(line, '', { outputPath }, settings)

  const size = (await fs.stat(result.audioPath)).size
  const info = await probe(result.audioPath)
  console.log(`[tts] wrote ${result.audioPath}`)
  console.log(`[tts] ${(size / 1024).toFixed(0)} KB, ${info.durationSeconds.toFixed(2)}s, ` +
    `${info.hasAudio ? 'audio stream ok' : 'NO AUDIO STREAM'}, voice=${result.voiceId}`)
  console.log(`[tts] timings: ${result.wordTimings?.length ?? 0}`)

  await fs.rm(outputPath, { force: true }).catch(() => undefined)

  if (!info.hasAudio || info.durationSeconds < 0.2 || size < 2_000) {
    fail(`the engine produced something unusable (${size} bytes, ${info.durationSeconds.toFixed(2)}s)`)
    return
  }

  if (engine.test) {
    const tested = await engine.test(settings)
    console.log(`[tts] self-test: ${tested.ok ? 'ok' : 'FAILED'} — ${tested.message}`)
  }

  console.log(`\n[tts] PASS — ${engineId} spoke in ${((Date.now() - started) / 1000).toFixed(1)}s\n`)
  app.exit(0)
}
