/**
 * Real Pexels footage check (development only).
 *
 *     npm run build
 *     ZBOT_FOOTAGE=1 npx electron .
 *
 * Runs the exact code a render run uses — `generateSceneFootage` then
 * `renderClip` with `inputKind: 'footage'` — against the real API and the key the user
 * saved in Settings. Nothing is mocked: this is the first proof that a saved key
 * actually works end to end. Output lands in `<userData>/preview/footage-test.mp4`.
 *
 * Never runs unless `ZBOT_FOOTAGE` is set.
 */
import { app } from 'electron'
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { generateSceneFootage } from '../footage/generate'
import { loadSettings } from '../store/settings'
import { renderClip } from '../video/render'

function fail(message: string): void {
  console.error(`\n[footage] FAIL — ${message}\n`)
  app.exit(1)
}

const WATCHDOG_MS = 5 * 60_000

export async function runFootageTest(): Promise<void> {
  const watchdog = setTimeout(() => {
    console.error(`\n[footage] WATCHDOG — no result within ${WATCHDOG_MS / 60_000} minutes.`)
    app.exit(1)
  }, WATCHDOG_MS)

  try {
    const settings = await loadSettings()
    if (!settings.pexelsApiKey) {
      fail('no Pexels key in Settings — save one first')
      return
    }
    console.log('[footage] key: saved (not printed)')

    const rawPath = join(app.getPath('userData'), 'preview', 'footage-raw.mp4')
    const started = Date.now()

    // The same call the images stage makes, with the same search shape the Script AI is
    // taught to write: 2-5 plain words.
    await generateSceneFootage(
      {
        query: 'aerial city skyline sunset',
        outputPath: rawPath,
        targetHeight: 1920,
        orientation: 'short',
        isCancelled: () => false
      },
      settings
    )
    const rawBytes = (await stat(rawPath)).size
    console.log(
      `[footage] downloaded in ${((Date.now() - started) / 1000).toFixed(1)}s — ${(rawBytes / 1e6).toFixed(1)} MB`
    )

    // And the same render the clips stage runs for a footage scene.
    const outPath = join(app.getPath('userData'), 'preview', 'footage-test.mp4')
    await renderClip({
      imagePath: rawPath,
      durationSeconds: 4,
      style: 'none', // ignored for footage; proves the contract does not depend on it
      width: 1080,
      height: 1920,
      outputPath: outPath,
      inputKind: 'footage'
    })
    const outBytes = (await stat(outPath)).size
    console.log(`[footage] rendered clip — ${(outBytes / 1e6).toFixed(1)} MB → ${outPath}`)

    console.log('\n[footage] PASS — search, download and footage render all work.\n')
    app.exit(0)
  } catch (err) {
    fail((err as Error).message)
  } finally {
    clearTimeout(watchdog)
  }
}
