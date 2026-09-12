/**
 * The pipeline stages.
 *
 * Every stage is written so that **completed work is always kept**: a stage skips scenes
 * that already have their asset on disk, so Retry resumes from where it failed instead of
 * starting over.
 */
import { promises as fs } from 'node:fs'
import { basename, dirname, extname, join } from 'node:path'
import {
  clipMotionKey,
  IMAGE_CONCURRENCY_MAX,
  RENDER_SHORT_SIDE
} from '@shared/constants'
import type { Story } from '@shared/types'
import { generateSceneFootage } from '../footage/generate'
import { generateSceneImage, type SceneImageResult } from '../images/generate'
import { getImageProvider } from '../images/registry'
import { estimateDurationSeconds } from '../script/narration'
import { getChannel } from '../store/channels'
import { fileExists } from '../store/jsonStore'
import { paths } from '../store/paths'
import { assetPath, saveStory } from '../store/projects'
import { synthesizeWithFallback } from '../tts'
import { probeDuration } from '../video/ffprobe'
import { resolveMotionStyle, targetSize } from '../video/motion'
import { concatClips, renderClip, renderFinal, TAIL_PADDING_SECONDS } from '../video/render'
import { buildAss, buildCues, shiftCues, type CaptionCue } from '../video/subtitles'
import type { PipelineContext } from './context'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const sceneSuffix = (sceneNumber: number): string => String(sceneNumber).padStart(3, '0')

/**
 * Bounded worker pool. Once one worker fails the rest stop pulling from the queue, so a
 * hard failure does not keep spawning browser tabs or ffmpeg processes.
 */
async function mapWithConcurrency<T>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<void>
): Promise<void> {
  const queue = items.map((item, index) => ({ item, index }))
  let failed = false

  const runners = Array.from(
    { length: Math.max(1, Math.min(limit, queue.length || 1)) },
    async () => {
      while (queue.length && !failed) {
        const next = queue.shift()
        if (!next) return
        try {
          await worker(next.item, next.index)
        } catch (err) {
          failed = true
          throw err
        }
      }
    }
  )

  await Promise.all(runners)
}

function sanitizeFilename(name: string): string {
  const cleaned = name
    .replace(/[\u0000-\u001f<>:"/\\|?*]/g, '')
    .replace(/[. ]+$/, '')
    .replace(/\s+/g, ' ')
    .trim()
  return cleaned.slice(0, 100) || 'video'
}

async function uniquePath(dir: string, filename: string): Promise<string> {
  const ext = extname(filename)
  const base = basename(filename, ext)
  let candidate = join(dir, filename)
  let counter = 2
  while (await fileExists(candidate)) {
    candidate = join(dir, `${base} (${counter})${ext}`)
    counter++
  }
  return candidate
}

export function renderSize(project: PipelineContext['project']): {
  width: number
  height: number
} {
  return targetSize(project.config.orientation, RENDER_SHORT_SIDE[project.config.resolution])
}

// ---------------------------------------------------------------------------
// story
// ---------------------------------------------------------------------------

/**
 * Durations start as word-count estimates. They are overwritten with measured audio
 * lengths once voice exists, so this is only a first pass for the progress numbers.
 */
export async function runStoryStage(ctx: PipelineContext): Promise<void> {
  const { story, progress, project } = ctx

  for (const scene of story.scenes) {
    if (!scene.durationSeconds || scene.durationSeconds <= 0) {
      scene.durationSeconds = estimateDurationSeconds(scene.narration) || 3
    }
  }

  await saveStory(project.id, story)
  progress.completeStage('story', { message: `${story.scenes.length} scenes` })
}

// ---------------------------------------------------------------------------
// images
// ---------------------------------------------------------------------------

export async function runImagesStage(ctx: PipelineContext): Promise<void> {
  const { project, story, settings, cancellation, progress, emit } = ctx

  const configuredId = project.config.imageProvider
  const provider = getImageProvider(configuredId)
  if (!provider) throw new Error(`Unknown image provider: ${configuredId}`)

  const total = story.scenes.length
  const concurrency = Math.max(
    1,
    Math.min(IMAGE_CONCURRENCY_MAX, project.config.imageConcurrency || 1)
  )
  let done = 0

  await mapWithConcurrency(story.scenes, concurrency, async (scene, index) => {
    cancellation.throwIfCancelled()
    await cancellation.waitWhilePaused()

    // Already generated on an earlier run — keep it.
    if (scene.imagePath && (await fileExists(scene.imagePath))) {
      done++
      progress.setStage('images', done / total, { imagesDone: done, imagesTotal: total })
      return
    }

    const imagePathOut = assetPath(
      project.id,
      'images',
      `scene-${sceneSuffix(scene.sceneNumber)}.png`
    )
    const footagePathOut = assetPath(
      project.id,
      'images',
      `scene-${sceneSuffix(scene.sceneNumber)}.mp4`
    )

    try {
      let imageResult: SceneImageResult | null = null

      // A footage scene is a search-and-download, not a generation: it has its own lane
      // with its own failure story. Falling back to image generation keeps the video
      // alive when Pexels has nothing (or no key was set) — loudly logged, never silent.
      if (scene.visual === 'footage') {
        try {
          scene.imagePath = await generateSceneFootage(
            {
              query: scene.imagePrompt,
              outputPath: footagePathOut,
              targetHeight: renderSize(project).height,
              orientation: project.config.orientation,
              isCancelled: () => cancellation.isCancelled
            },
            settings
          )
        } catch (err) {
          if (cancellation.isCancelled) throw err
          emit.log(
            project.id,
            `Scene ${scene.sceneNumber} footage failed (${(err as Error).message}) — generating an image instead.`
          )
          imageResult = await generateSceneImage(
            {
              prompt: scene.imagePrompt,
              outputPath: imagePathOut,
              index,
              sourceDir: project.config.imageSourceDir ?? settings.imageSourceDir,
              mood: scene.mood,
              isCancelled: () => cancellation.isCancelled
            },
            settings,
            configuredId,
            (message) => emit.log(project.id, message)
          )
          scene.imagePath = imageResult.path
          scene.visual = 'image'
        }
      } else {
        imageResult = await generateSceneImage(
          {
            prompt: scene.imagePrompt,
            outputPath: imagePathOut,
            index,
            sourceDir: project.config.imageSourceDir ?? settings.imageSourceDir,
            mood: scene.mood,
            isCancelled: () => cancellation.isCancelled
          },
          settings,
          configuredId,
          (message) => emit.log(project.id, message)
        )
        scene.imagePath = imageResult.path
      }

      if (imageResult && imageResult.providerId !== configuredId) {
        emit.log(
          project.id,
          `Scene ${scene.sceneNumber} came from ${imageResult.providerId} after ${imageResult.attempts} attempt(s) — the configured provider ${configuredId} failed.`
        )
      }
      emit.sceneUpdated(project.id, scene)
    } catch (err) {
      if (cancellation.isCancelled) throw err
      // A single failed image is not fatal — the fill-in pass below covers it.
      emit.log(
        project.id,
        `Image for scene ${scene.sceneNumber} failed: ${(err as Error).message}`
      )
      scene.imagePath = undefined
    }

    done++
    progress.setStage('images', done / total, { imagesDone: done, imagesTotal: total })
  })

  const filled = await fillMissingImages(project.id, story)
  if (filled) {
    emit.log(
      project.id,
      `${filled} scene image(s) could not be generated and were copied from the nearest scene.`
    )
  }

  await saveStory(project.id, story)
  progress.completeStage('images', { imagesDone: total, imagesTotal: total })
}

/**
 * An image that failed everywhere is copied from the nearest neighbouring scene rather
 * than failing the run. A repeated frame is a much smaller problem than a dead pipeline.
 */
async function fillMissingImages(projectId: string, story: Story): Promise<number> {
  const missing = story.scenes.filter((scene) => !scene.imagePath)
  if (!missing.length) return 0

  const available = story.scenes.filter((scene) => scene.imagePath)
  if (!available.length) {
    throw new Error('No image could be generated for any scene.')
  }

  for (const scene of missing) {
    const nearest = available.reduce((best, candidate) =>
      Math.abs(candidate.sceneNumber - scene.sceneNumber) <
      Math.abs(best.sceneNumber - scene.sceneNumber)
        ? candidate
        : best
    )

    const outputPath = assetPath(projectId, 'images', `scene-${sceneSuffix(scene.sceneNumber)}.png`)
    await fs.copyFile(nearest.imagePath as string, outputPath)
    scene.imagePath = outputPath
  }

  return missing.length
}

// ---------------------------------------------------------------------------
// voice
// ---------------------------------------------------------------------------

export async function runVoiceStage(ctx: PipelineContext): Promise<void> {
  const { project, story, settings, cancellation, progress, emit } = ctx

  const total = story.scenes.length
  let done = 0

  // Voice is a remote/CPU-bound call per scene; a small pool keeps us inside the free
  // tiers without serialising a 40-scene script.
  await mapWithConcurrency(story.scenes, 3, async (scene) => {
    cancellation.throwIfCancelled()
    await cancellation.waitWhilePaused()

    if (!scene.narration.trim()) {
      done++
      progress.setStage('voice', done / total, { voiceDone: done, voiceTotal: total })
      return
    }

    if (scene.audioPath && (await fileExists(scene.audioPath))) {
      // Keep the audio, but re-measure it — duration is what the render depends on.
      const measured = await probeDuration(scene.audioPath)
      if (measured > 0) scene.durationSeconds = measured
      done++
      progress.setStage('voice', done / total, { voiceDone: done, voiceTotal: total })
      return
    }

    const outputBase = assetPath(
      project.id,
      'audio',
      `scene-${sceneSuffix(scene.sceneNumber)}.mp3`
    )

    const result = await synthesizeWithFallback({
      text: scene.narration,
      engine: project.config.ttsEngine,
      voiceId: project.config.voiceId,
      options: {
        outputPath: outputBase,
        mood: scene.mood,
        isCancelled: () => cancellation.isCancelled
      },
      settings
    })

    scene.audioPath = result.audioPath
    scene.wordTimings = result.wordTimings
    // The measured length ALWAYS wins over the estimate.
    if (result.durationSeconds > 0) scene.durationSeconds = result.durationSeconds

    if (result.downgraded) {
      emit.log(
        project.id,
        `Scene ${scene.sceneNumber}: ${project.config.ttsEngine} failed, voice supplied by ${result.engine}.`
      )
    }

    emit.sceneUpdated(project.id, scene)
    done++
    progress.setStage('voice', done / total, { voiceDone: done, voiceTotal: total })
  })

  await saveStory(project.id, story)
  progress.completeStage('voice', { voiceDone: total, voiceTotal: total })
}

// ---------------------------------------------------------------------------
// thumbnail
// ---------------------------------------------------------------------------

/**
 * Never fatal — but never silently green either. A missing thumbnail is reported on the
 * stage and in the log so it cannot be mistaken for a success.
 */
export async function runThumbnailStage(ctx: PipelineContext): Promise<void> {
  const { project, story, settings, cancellation, progress, emit } = ctx

  if (!story.thumbnailPrompt?.trim()) {
    progress.skipStage('thumbnail', 'No thumbnail prompt in the script.')
    return
  }

  const provider = getImageProvider(project.config.imageProvider)
  if (!provider) {
    progress.completeStage('thumbnail', { message: 'Thumbnail skipped — no image provider.' })
    return
  }

  const outputPath = assetPath(project.id, 'images', 'thumbnail.png')

  try {
    if (await fileExists(outputPath)) {
      story.thumbnailPath = outputPath
      progress.completeStage('thumbnail')
      return
    }

    cancellation.throwIfCancelled()
    story.thumbnailPath = await provider.generate(
      {
        prompt: story.thumbnailPrompt,
        outputPath,
        index: 0,
        sourceDir: project.config.imageSourceDir ?? settings.imageSourceDir,
        mood: 'thumbnail',
        isCancelled: () => cancellation.isCancelled
      },
      settings
    )
    await saveStory(project.id, story)
    progress.completeStage('thumbnail')
  } catch (err) {
    if (cancellation.isCancelled) throw err
    const message = `Thumbnail failed (non-fatal): ${(err as Error).message}`
    emit.log(project.id, message)
    progress.completeStage('thumbnail', { message })
  }
}

// ---------------------------------------------------------------------------
// clips
// ---------------------------------------------------------------------------

/**
 * Per-scene camera motion over the measured audio length.
 *
 * Attempt 3 deliberately falls back to a still frame with a hard cut and an 8-minute
 * watchdog: if the motion filter is what is hanging, a flat clip beats a dead run.
 */
export async function runClipsStage(ctx: PipelineContext): Promise<void> {
  const { project, story, cancellation, progress, emit } = ctx
  const { width, height } = renderSize(project)
  const motionKey = clipMotionKey(
    project.config.motionEnabled,
    project.config.animationStyle,
    project.config.transitionStyle
  )
  const total = story.scenes.length
  let done = 0

  await mapWithConcurrency(story.scenes, 2, async (scene, index) => {
    cancellation.throwIfCancelled()
    await cancellation.waitWhilePaused()

    if (!scene.imagePath) {
      throw new Error(`Scene ${scene.sceneNumber} has no image to render.`)
    }

    const outputPath = assetPath(project.id, 'clips', `scene-${sceneSuffix(scene.sceneNumber)}.mp4`)

    // A cached clip is only valid if it was rendered with the current motion settings.
    if (scene.clipPath && scene.clipMotionKey === motionKey && (await fileExists(scene.clipPath))) {
      done++
      progress.setStage('clips', done / total)
      return
    }

    const style = resolveMotionStyle(
      project.config.animationStyle,
      index,
      scene.mood,
      project.config.motionEnabled
    )

    let lastError: Error | null = null

    for (let attempt = 1; attempt <= 3; attempt++) {
      cancellation.throwIfCancelled()

      const attemptPath = `${outputPath}.attempt${attempt}.mp4`
      // A still frame is a fallback a stock clip does not need — footage has motion of its
      // own, and attempt 3's job (escape a hanging zoompan) has nothing to escape here.
      const attemptStyle =
        scene.visual === 'footage' ? style : attempt === 3 ? 'none' : style

      try {
        await renderClip({
          imagePath: scene.imagePath,
          audioPath: scene.audioPath,
          durationSeconds: scene.durationSeconds,
          style: attemptStyle,
          width,
          height,
          outputPath: attemptPath,
          inputKind: scene.visual === 'footage' ? 'footage' : 'image',
          isCancelled: () => cancellation.isCancelled,
          timeoutMs: attempt === 3 ? 8 * 60 * 1000 : undefined,
          onProgress: (fraction) =>
            progress.setStage('clips', (done + fraction) / total, { sceneIndex: index })
        })

        await fs.rm(outputPath, { force: true }).catch(() => undefined)
        await fs.rename(attemptPath, outputPath)

        scene.clipPath = outputPath
        scene.clipMotionKey = motionKey
        lastError = null
        break
      } catch (err) {
        if (cancellation.isCancelled) throw err

        lastError = err as Error
        await fs.rm(attemptPath, { force: true }).catch(() => undefined)
        emit.log(
          project.id,
          `Clip ${scene.sceneNumber} attempt ${attempt} failed: ${lastError.message}`
        )
      }
    }

    if (lastError) {
      throw new Error(
        `Clip for scene ${scene.sceneNumber} failed after 3 attempts: ${lastError.message}`
      )
    }

    emit.sceneUpdated(project.id, scene)
    done++
    progress.setStage('clips', done / total)
  })

  await saveStory(project.id, story)
  progress.completeStage('clips')
}

// ---------------------------------------------------------------------------
// subtitles
// ---------------------------------------------------------------------------

/**
 * Cues are built per scene from that scene's word timings, then shifted by the scene's
 * start offset so they line up on the concatenated timeline.
 */
export async function runSubtitlesStage(ctx: PipelineContext): Promise<string | null> {
  const { project, story, progress } = ctx

  if (!project.config.subtitlesEnabled) {
    progress.skipStage('subtitles', 'Subtitles are switched off.')
    return null
  }

  const { width, height } = renderSize(project)
  const cues: CaptionCue[] = []
  let offsetMs = 0

  for (const scene of story.scenes) {
    const sceneCues = buildCues(scene.narration, scene.durationSeconds, scene.wordTimings)
    cues.push(...shiftCues(sceneCues, offsetMs))
    offsetMs += (scene.durationSeconds + TAIL_PADDING_SECONDS) * 1000
  }

  const ass = buildAss(cues, { width, height, style: project.config.subtitleStyle })
  const assPath = assetPath(project.id, 'subtitles', 'subtitles.ass')
  await fs.mkdir(join(assPath, '..'), { recursive: true })
  await fs.writeFile(assPath, ass, 'utf8')

  progress.completeStage('subtitles', { message: `${cues.length} cues` })
  return assPath
}

// ---------------------------------------------------------------------------
// rendering
// ---------------------------------------------------------------------------

export async function runRenderingStage(
  ctx: PipelineContext,
  assPath: string | null
): Promise<string> {
  const { project, story, cancellation, progress } = ctx

  const clips = story.scenes.map((scene) => scene.clipPath).filter((p): p is string => Boolean(p))
  if (!clips.length) throw new Error('No clips were rendered.')

  const totalDuration =
    story.scenes.reduce((sum, scene) => sum + scene.durationSeconds + TAIL_PADDING_SECONDS, 0)

  const rawPath = assetPath(project.id, 'exports', 'raw.mp4')
  progress.setStage('rendering', 0.05, { message: 'Joining clips' })

  await concatClips({
    clips,
    outputPath: rawPath,
    isCancelled: () => cancellation.isCancelled,
    totalDurationSeconds: totalDuration,
    onProgress: (fraction) => progress.setStage('rendering', 0.05 + fraction * 0.35)
  })

  cancellation.throwIfCancelled()

  const finalPath = assetPath(project.id, 'exports', 'final.mp4')
  progress.setStage('rendering', 0.45, { message: 'Subtitles, music and loudness' })

  await renderFinal({
    videoPath: rawPath,
    outputPath: finalPath,
    assPath: assPath ?? undefined,
    musicPath: project.config.musicPath,
    musicVolume: project.config.musicVolume,
    width: renderSize(project).width,
    height: renderSize(project).height,
    isCancelled: () => cancellation.isCancelled,
    totalDurationSeconds: totalDuration,
    onProgress: (fraction) => progress.setStage('rendering', 0.45 + fraction * 0.55)
  })

  progress.completeStage('rendering')
  return finalPath
}

// ---------------------------------------------------------------------------
// export
// ---------------------------------------------------------------------------

/**
 * A finished video lands in its channel's Shorts or Longs folder, chosen by orientation.
 * History can re-export anywhere later; this is just the automatic destination.
 */
export async function runExportStage(ctx: PipelineContext): Promise<string | undefined> {
  const { project, story, settings, progress, emit } = ctx

  const channel = project.config.channelId ? await getChannel(project.config.channelId) : null

  let destination: string | undefined
  if (channel) {
    destination =
      project.config.orientation === 'short'
        ? channel.shortsOutputDir
        : channel.longsOutputDir
  }
  if (!destination) destination = settings.lastOutputDir

  const exportsDir = paths.projectSub(project.id, 'exports')

  // No channel folder configured — the exports folder is still a valid home.
  if (!destination?.trim()) {
    destination = exportsDir
  }

  await fs.mkdir(destination, { recursive: true })
  const title = sanitizeFilename(story.title || project.title)

  if (project.mode === 'video') {
    // The orchestrator records the finished file on the project; fall back to its
    // conventional location so a resumed run still finds it.
    const finalPath = project.assets.final ?? assetPath(project.id, 'exports', 'final.mp4')
    if (!(await fileExists(finalPath))) {
      throw new Error('There is no finished video to export.')
    }

    const target = await uniquePath(destination, `${title}.mp4`)
    await copyFileStreaming(finalPath, target)

    if (story.thumbnailPath && (await fileExists(story.thumbnailPath))) {
      await copyFileStreaming(story.thumbnailPath, await uniquePath(destination, `${title}.png`))
    }

    progress.completeStage('export', { message: target })
    emit.log(project.id, `Exported to ${target}`)
    return target
  }

  if (project.mode === 'images') {
    let count = 0
    for (const scene of story.scenes) {
      if (!scene.imagePath) continue
      const target = await uniquePath(
        destination,
        `${title} - ${sceneSuffix(scene.sceneNumber)}.png`
      )
      await copyFileStreaming(scene.imagePath, target)
      count++
    }
    progress.completeStage('export', { message: `${count} images -> ${destination}` })
    return destination
  }

  // audio mode
  let count = 0
  for (const scene of story.scenes) {
    if (!scene.audioPath) continue
    const target = await uniquePath(
      destination,
      `${title} - ${sceneSuffix(scene.sceneNumber)}${extname(scene.audioPath)}`
    )
    await copyFileStreaming(scene.audioPath, target)
    count++
  }
  progress.completeStage('export', { message: `${count} audio files -> ${destination}` })
  return destination
}

/** `fs.copyFile` streams nothing extra into memory, so large renders are safe here. */
async function copyFileStreaming(from: string, to: string): Promise<void> {
  await fs.copyFile(from, to)
}
