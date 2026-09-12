/**
 * The pipeline orchestrator.
 *
 *     story -> (images ∥ voice ∥ thumbnail) -> clips -> review -> subtitles
 *           -> rendering -> export
 *
 * Two rules shape everything here:
 *
 *  1. **A failure is never silent and never endless.** Each stage gets bounded auto-retry
 *     that gives up early when the identical error keeps repeating, then the run stops
 *     with the reason attached to that stage.
 *  2. **Completed work survives a retry.** Stages skip assets already on disk, so pressing
 *     Retry after scene 40 failed re-renders scene 40, not scenes 1-39.
 */
import {
  AUTO_RETRY_IDENTICAL_LIMIT,
  AUTO_RETRY_MAX
} from '@shared/constants'
import type { PipelineStage } from '@shared/types'
import { loadStory, getProject, setProjectStatus, setStageState, updateProject } from '../store/projects'
import { loadSettings } from '../store/settings'
import {
  createCancellation,
  disposeCancellation,
  PipelineCancelledError
} from './cancellation'
import { ProgressReporter, type PipelineContext, type PipelineEmitter } from './context'
import {
  runClipsStage,
  runExportStage,
  runImagesStage,
  runRenderingStage,
  runStoryStage,
  runSubtitlesStage,
  runThumbnailStage,
  runVoiceStage
} from './stages'

export interface RunPipelineOptions {
  projectId: string
  emit: PipelineEmitter
}

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

/** Stages that only make sense when a video is being produced. */
const VIDEO_ONLY_STAGES: PipelineStage[] = ['clips', 'review', 'subtitles', 'rendering']

/**
 * Bounded auto-retry for one stage.
 *
 * Retrying a genuinely deterministic failure forever is how a run hangs at 90% overnight,
 * so an error that repeats unchanged `AUTO_RETRY_IDENTICAL_LIMIT` times is taken as final
 * even when the attempt budget is untouched.
 */
async function runStageWithRetry(
  stage: PipelineStage,
  ctx: PipelineContext,
  fn: () => Promise<void>
): Promise<void> {
  const { cancellation, progress, emit, project } = ctx

  let attempts = 0
  let lastError = ''
  let identical = 0

  for (;;) {
    cancellation.throwIfCancelled()
    await cancellation.waitWhilePaused()

    try {
      await fn()
      return
    } catch (err) {
      // Cancellation is a decision, not a failure — it must never be retried.
      if (err instanceof PipelineCancelledError) throw err

      const message = (err as Error).message || String(err)
      attempts++

      if (message === lastError) identical++
      else {
        identical = 1
        lastError = message
      }

      const giveUp = identical >= AUTO_RETRY_IDENTICAL_LIMIT || attempts >= AUTO_RETRY_MAX
      if (giveUp) throw err

      emit.error({ projectId: project.id, stage, error: message, fromAutoRetry: true })
      emit.log(project.id, `${stage}: ${message} — retrying (attempt ${attempts + 1}).`)
      progress.setStage(stage, 0, { message: `Retrying — ${message}` })

      // Back off a little further each time, capped so a retry is never a long silence.
      await delay(Math.min(30_000, 2_000 * attempts))
    }
  }
}

/**
 * `allSettled` rather than `all`: the parallel asset stages must all finish before the run
 * unwinds, or a voice request keeps writing files into a project we already called failed.
 */
async function runParallelAssetStages(ctx: PipelineContext): Promise<void> {
  const results = await Promise.allSettled([
    runStageWithRetry('images', ctx, () => runImagesStage(ctx)),
    runStageWithRetry('voice', ctx, () => runVoiceStage(ctx)),
    runStageWithRetry('thumbnail', ctx, () => runThumbnailStage(ctx))
  ])

  // Report the first real failure, preferring one that is not merely a cancellation.
  const rejected = results.filter(
    (r): r is PromiseRejectedResult => r.status === 'rejected'
  )
  if (!rejected.length) return

  const cancelled = rejected.find((r) => r.reason instanceof PipelineCancelledError)
  throw cancelled ? cancelled.reason : rejected[0].reason
}

export async function runPipeline(options: RunPipelineOptions): Promise<void> {
  const { projectId, emit } = options

  const project = await getProject(projectId)
  if (!project) {
    emit.error({ projectId, stage: 'story', error: 'Project not found.' })
    return
  }

  const story = await loadStory(projectId)
  if (!story || !story.scenes.length) {
    await setProjectStatus(projectId, 'failed')
    emit.error({ projectId, stage: 'story', error: 'This project has no script yet.' })
    return
  }

  const settings = await loadSettings()
  const cancellation = createCancellation(projectId)
  const progress = new ProgressReporter(projectId, emit)
  const ctx: PipelineContext = { project, story, settings, cancellation, emit, progress }

  let currentStage: PipelineStage = 'story'
  let assPath: string | null = null
  let finalPath: string | null = null
  let outputPath: string | undefined

  /** Mark a stage running/done in the persisted project so History reflects reality. */
  const setState = async (
    stage: PipelineStage,
    status: 'running' | 'done' | 'failed' | 'skipped',
    error?: string
  ): Promise<void> => {
    await setStageState(projectId, stage, {
      status,
      ...(status === 'running' ? { startedAt: Date.now() } : { finishedAt: Date.now() }),
      ...(error ? { error } : {})
    })
  }

  const run = async (stage: PipelineStage, fn: () => Promise<void>): Promise<void> => {
    currentStage = stage
    await setState(stage, 'running')
    await runStageWithRetry(stage, ctx, fn)
    await setState(stage, 'done')
  }

  /** Stages this mode never reaches are marked skipped, so nothing sits at "pending". */
  const skip = async (stages: PipelineStage[], reason: string): Promise<void> => {
    for (const stage of stages) {
      progress.skipStage(stage, reason)
      await setState(stage, 'skipped')
    }
  }

  try {
    await setProjectStatus(projectId, 'running')

    await run('story', () => runStoryStage(ctx))

    if (project.mode === 'video') {
      await runParallelAssetStages(ctx)
      await run('clips', () => runClipsStage(ctx))

      // The manual review gate lives here. Auto-approved for now: the stage still reports
      // progress so a future pause-and-edit step has a slot to occupy.
      currentStage = 'review'
      await setState('review', 'running')
      progress.completeStage('review', { message: 'Auto-approved' })
      await setState('review', 'done')

      await run('subtitles', async () => {
        assPath = await runSubtitlesStage(ctx)
      })
      await run('rendering', async () => {
        finalPath = await runRenderingStage(ctx, assPath)
      })
    } else if (project.mode === 'images') {
      await run('images', () => runImagesStage(ctx))
      await skip(
        ['voice', 'thumbnail', ...VIDEO_ONLY_STAGES],
        'Not used in an images-only run.'
      )
    } else {
      await run('voice', () => runVoiceStage(ctx))
      await skip(
        ['images', 'thumbnail', ...VIDEO_ONLY_STAGES],
        'Not used in an audio-only run.'
      )
    }

    await run('export', async () => {
      outputPath = await runExportStage(ctx)
    })

    // Record what was produced, so History can open or re-export it later. This is a
    // read-modify-write: the stage transitions above already wrote to disk, and saving
    // the project object we loaded at the start would roll every one of them back.
    if (finalPath || outputPath) {
      await updateProject(projectId, (p) => ({
        ...p,
        assets: finalPath ? { ...p.assets, final: finalPath } : p.assets,
        outputPath: outputPath ?? finalPath ?? p.outputPath
      }))
    }

    await setProjectStatus(projectId, 'done')
    emit.complete(projectId, outputPath)
  } catch (err) {
    if (err instanceof PipelineCancelledError) {
      await setState(currentStage, 'skipped', 'Stopped by the user.')
      await setProjectStatus(projectId, 'cancelled')
      progress.markStopped(currentStage, 'Stopped by the user.')
      emit.log(projectId, 'Run stopped.')
      return
    }

    const message = (err as Error).message || String(err)
    await setState(currentStage, 'failed', message)
    await setProjectStatus(projectId, 'failed')
    progress.failStage(currentStage, message)
    emit.error({ projectId, stage: currentStage, error: message })
  } finally {
    disposeCancellation(projectId)
  }
}
