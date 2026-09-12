/**
 * Live pipeline state.
 *
 * Events arrive pushed from the main process; this store folds them into one view. The
 * subscriptions are attached exactly once, at module load, and every event is filtered by
 * project id — a second window running another project must not tick this one's bar.
 */
import { create } from 'zustand'
import { PIPELINE_STAGES } from '@shared/types'
import type { PipelineProgress, ProjectStatus, Scene, StageStatus } from '@shared/types'

export interface StageView {
  status: StageStatus
  message?: string
}

interface PipelineState {
  projectId: string | null
  status: ProjectStatus
  overallPercent: number
  activeStage: string | null
  stages: Record<string, StageView>
  sceneOverrides: Record<number, Scene>
  logs: string[]
  error: { stage: string; error: string } | null
  outputPath: string | null
  elapsedMs: number

  watch: (projectId: string) => void
  stopWatching: () => void
  /** Reopen a past run from History without pretending it is live. */
  open: (input: {
    projectId: string
    status: ProjectStatus
    stages: Record<string, { status: StageStatus; error?: string }>
    outputPath?: string
  }) => void
  /** Seed the stage list from a project record when reopening a finished run. */
  seed: (stages: Record<string, { status: StageStatus; error?: string }>) => void
}

function emptyStages(): Record<string, StageView> {
  const stages: Record<string, StageView> = {}
  for (const stage of PIPELINE_STAGES) stages[stage] = { status: 'pending' }
  return stages
}

const MAX_LOG_LINES = 400

export const usePipeline = create<PipelineState>((set, get) => ({
  projectId: null,
  status: 'idle',
  overallPercent: 0,
  activeStage: null,
  stages: emptyStages(),
  sceneOverrides: {},
  logs: [],
  error: null,
  outputPath: null,
  elapsedMs: 0,

  watch(projectId) {
    set({
      projectId,
      status: 'running',
      overallPercent: 0,
      activeStage: 'story',
      stages: emptyStages(),
      sceneOverrides: {},
      logs: [],
      error: null,
      outputPath: null,
      elapsedMs: 0
    })
  },

  stopWatching() {
    set({ status: 'idle', projectId: null })
  },

  open({ projectId, status, stages, outputPath }) {
    const merged = emptyStages()
    for (const [name, state] of Object.entries(stages)) {
      merged[name] = { status: state.status, message: state.error || undefined }
    }

    set({
      projectId,
      status,
      stages: merged,
      outputPath: outputPath ?? null,
      error: null,
      logs: [],
      sceneOverrides: {},
      overallPercent: status === 'done' ? 100 : 0,
      activeStage: null
    })
  },

  seed(stages) {
    const merged = emptyStages()
    for (const [name, state] of Object.entries(stages)) {
      merged[name] = { status: state.status, message: state.error || undefined }
    }
    set({ stages: merged })
  }
}))

/** True when this event belongs to the run currently on screen. */
function isForMe(projectId: string): boolean {
  return usePipeline.getState().projectId === projectId
}

window.api.pipeline.onProgress((data: PipelineProgress) => {
  if (!isForMe(data.projectId)) return

  usePipeline.setState((state) => {
    const stages = { ...state.stages }
    const previous = stages[data.stage] ?? { status: 'pending' as StageStatus }

    stages[data.stage] = {
      status: data.stageStatus,
      message: data.message ?? previous.message
    }

    return {
      stages,
      overallPercent: data.overallPercent,
      elapsedMs: data.elapsedMs ?? state.elapsedMs,
      activeStage: data.stageStatus === 'running' ? data.stage : state.activeStage
    }
  })
})

window.api.pipeline.onSceneUpdated(({ projectId, scene }) => {
  if (!isForMe(projectId)) return
  usePipeline.setState((state) => ({
    sceneOverrides: { ...state.sceneOverrides, [scene.sceneNumber]: scene }
  }))
})

window.api.pipeline.onLog(({ projectId, message }) => {
  if (!isForMe(projectId)) return
  usePipeline.setState((state) => ({
    logs: [...state.logs, message].slice(-MAX_LOG_LINES)
  }))
})

window.api.pipeline.onComplete(({ projectId, outputPath }) => {
  if (!isForMe(projectId)) return
  usePipeline.setState({
    status: 'done',
    overallPercent: 100,
    activeStage: null,
    outputPath: outputPath ?? null
  })
})

window.api.pipeline.onError(({ projectId, stage, error, fromAutoRetry }) => {
  if (!isForMe(projectId)) return

  usePipeline.setState((state) => ({
    // A retry notice is not a failure — the run is still going.
    status: fromAutoRetry ? state.status : 'failed',
    error: { stage, error }
  }))
})
