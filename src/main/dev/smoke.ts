/**
 * End-to-end smoke test (development only).
 *
 * Runs the real pipeline — importer, images, Edge TTS, ffmpeg clips, ASS subtitles, the
 * final render and the export — on a three-scene script, then checks that a playable MP4
 * actually landed on disk.
 *
 *     npm run build && ZBOT_SMOKE=1 npx electron .
 *
 * It is not part of the shipped UI and never runs unless the env var is set. Its job is to
 * fail loudly when a dependency (ffmpeg, the network, a font) is missing, rather than
 * letting the app discover that halfway through a real run.
 */
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import type { PipelineErrorEvent, PipelineProgress, Scene } from '@shared/types'
import { createProject, getProject, loadStory, saveStory } from '../store/projects'
import { loadSettings, saveSettings } from '../store/settings'
import { parseScriptText } from '../script/parse'
import { storyFromScript } from '../script/toStory'
import { runPipeline } from '../pipeline/orchestrator'
import { probe } from '../video/ffprobe'

const SCRIPT = `Title: Smoke Test Run

Scene 1: Deep water
Narration: The ocean keeps most of its secrets. We have mapped the Moon more carefully than the floor beneath us.
Image: a dark blue ocean surface at dawn, cinematic wide shot
Mood: calm

Scene 2: The descent
Narration: Below two hundred metres the light is gone, and every creature down there makes its own.
Image: bioluminescent creatures in deep black water, glowing blue
Mood: mysterious

Scene 3: The floor
Narration: The sea floor is still a guess. Every dive finds something nobody has a name for yet.
Image: an underwater canyon lit by a single submersible, dramatic
Mood: awe
`

/** Anything under this is a broken container, not a video. */
const MIN_OUTPUT_BYTES = 20_000

export async function runSmokeTest(): Promise<void> {
  const started = Date.now()

  const fail = (message: string): void => {
    clearTimeout(watchdog)
    console.error(`\n[smoke] FAIL — ${message}\n`)
    app.exit(1)
  }

  const pass = (message: string): void => {
    clearTimeout(watchdog)
    console.log(`\n[smoke] PASS — ${message}  (${((Date.now() - started) / 1000).toFixed(1)}s)\n`)
    app.exit(0)
  }

  const root = app.getAppPath()
  const imagesDir = join(root, '.smoke', 'images')

  // A browser-provider run has many moving parts (workers, CDP, ffmpeg); none of them is
  // allowed to take forever, but the test itself is the backstop that proves it. Ten minutes
  // is generous for three scenes and short enough to catch a silent hang.
  const WATCHDOG_MS = 10 * 60 * 1000
  const watchdog = setTimeout(() => {
    console.error('\n[smoke] FAIL — watchdog fired after 10 minutes; the run is stuck\n')
    app.exit(1)
  }, WATCHDOG_MS)

  // `local` needs the prepared folder; a browser provider (metaai, gemini) fetches its own
  // images and needs nothing on disk beforehand.
  const provider = process.env['ZBOT_SMOKE_PROVIDER']?.trim() || 'local'
  if (provider === 'local') {
    try {
      await fs.access(imagesDir)
    } catch {
      fail(`test images are missing at ${imagesDir}`)
      return
    }
  }

  console.log('[smoke] importing script…')
  const script = parseScriptText(SCRIPT, 'smoke.md')
  console.log(`[smoke] parsed ${script.scenes.length} scenes via "${script.layout}"`)

  if (script.scenes.length !== 3) {
    fail(`expected 3 scenes, got ${script.scenes.length}`)
    return
  }

  const settings = await loadSettings()
  await saveSettings({ imageSourceDir: imagesDir })

  const project = await createProject({
    title: 'Smoke Test Run',
    mode: 'video',
    config: {
      orientation: 'short',
      resolution: '1080p',
      imageProvider: provider,
      imageSourceDir: imagesDir,
      imageConcurrency: 2,
      motionEnabled: true,
      animationStyle: 'zoom-in',
      transitionStyle: 'hard-cut',
      subtitlesEnabled: true,
      subtitleStyle: 'bold-outline',
      ttsEngine: settings.ttsEngine,
      voiceId: settings.voiceId
    }
  })

  await saveStory(project.id, storyFromScript(script))

  console.log(`[smoke] project ${project.id}`)
  console.log('[smoke] running pipeline…')

  await runPipeline({
    projectId: project.id,
    emit: {
      progress: (data: PipelineProgress) => {
        if (data.stageStatus === 'running' && data.message) {
          console.log(`  ${data.stage}: ${data.overallPercent}% — ${data.message}`)
        }
      },
      sceneUpdated: (_projectId: string, scene: Scene) =>
        console.log(`  scene ${scene.sceneNumber}: ${scene.durationSeconds.toFixed(1)}s`),
      complete: (projectId: string, outputPath?: string) =>
        console.log(`  complete: ${outputPath ?? '(no path)'} for ${projectId}`),
      error: (data: PipelineErrorEvent) =>
        console.error(`  ERROR [${data.stage}] ${data.error}`),
      log: (_projectId: string, message: string) => console.log(`  · ${message}`)
    }
  })

  const final = await getProject(project.id)
  if (!final || final.status !== 'done') {
    fail(`pipeline ended with status "${final?.status ?? 'missing'}" — ${final?.error ?? 'no error recorded'}`)
    return
  }

  const outputPath = final.outputPath
  if (!outputPath) {
    fail('the project finished without an output path')
    return
  }

  let size = 0
  try {
    size = (await fs.stat(outputPath)).size
  } catch {
    fail(`the exported file does not exist: ${outputPath}`)
    return
  }

  if (size < MIN_OUTPUT_BYTES) {
    fail(`the exported file is only ${size} bytes — that is not a video`)
    return
  }

  const info = await probe(outputPath)
  if (!info.hasVideo || !info.hasAudio) {
    fail(`the export is missing a stream (video=${info.hasVideo}, audio=${info.hasAudio})`)
    return
  }

  const story = await loadStory(project.id)
  for (const scene of story?.scenes ?? []) {
    if (!scene.audioPath || !scene.clipPath) {
      fail(`scene ${scene.sceneNumber} is missing its audio or clip`)
      return
    }
  }

  pass(
    `${(size / 1024 / 1024).toFixed(1)} MB, ${info.width}x${info.height}, ` +
      `${info.durationSeconds.toFixed(1)}s → ${outputPath}`
  )
}
