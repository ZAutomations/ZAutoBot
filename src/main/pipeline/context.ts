/**
 * Shared pipeline plumbing: the emitter the IPC layer implements, the context every stage
 * receives, and the progress reporter that turns per-stage fractions into one percentage.
 */
import { STAGE_WEIGHTS } from '@shared/constants'
import type {
  AppSettings,
  PipelineErrorEvent,
  PipelineProgress,
  Project,
  Scene,
  Story
} from '@shared/types'
import type { Cancellation } from './cancellation'

export interface PipelineEmitter {
  progress(data: PipelineProgress): void
  sceneUpdated(projectId: string, scene: Scene): void
  complete(projectId: string, outputPath?: string): void
  error(data: PipelineErrorEvent): void
  log(projectId: string, message: string): void
}

type StageExtras = Omit<Partial<PipelineProgress>, 'projectId' | 'stage' | 'overallPercent'>

/**
 * Overall progress is the weighted sum of each stage's own fraction, so parallel stages
 * (images ∥ voice ∥ thumbnail) advance the bar together instead of fighting over it.
 */
export class ProgressReporter {
  private fractions = new Map<string, number>()
  private readonly startedAt = Date.now()

  constructor(
    private readonly projectId: string,
    private readonly emit: PipelineEmitter
  ) {}

  setStage(stage: string, fraction: number, extras: StageExtras = {}): void {
    const clamped = Math.min(1, Math.max(0, fraction))
    this.fractions.set(stage, clamped)

    let total = 0
    for (const [name, weight] of Object.entries(STAGE_WEIGHTS)) {
      total += weight * (this.fractions.get(name) ?? 0)
    }

    this.emit.progress({
      projectId: this.projectId,
      stage,
      stageStatus: 'running',
      overallPercent: Math.round(total),
      elapsedMs: Date.now() - this.startedAt,
      ...extras
    })
  }

  completeStage(stage: string, extras: StageExtras = {}): void {
    this.setStage(stage, 1, { stageStatus: 'done', ...extras })
  }

  failStage(stage: string, error: string): void {
    this.emit.progress({
      projectId: this.projectId,
      stage,
      stageStatus: 'failed',
      overallPercent: this.currentPercent(),
      elapsedMs: Date.now() - this.startedAt,
      message: error
    })
  }

  skipStage(stage: string, message: string): void {
    this.setStage(stage, 1, { stageStatus: 'skipped', message })
  }

  /**
   * The run stopped mid-stage. Unlike `skipStage` this does NOT advance the stage's
   * fraction — a stopped run must not report its unfinished work as complete.
   */
  markStopped(stage: string, message: string): void {
    this.emit.progress({
      projectId: this.projectId,
      stage,
      stageStatus: 'skipped',
      overallPercent: this.currentPercent(),
      elapsedMs: Date.now() - this.startedAt,
      message
    })
  }

  private currentPercent(): number {
    let total = 0
    for (const [name, weight] of Object.entries(STAGE_WEIGHTS)) {
      total += weight * (this.fractions.get(name) ?? 0)
    }
    return Math.round(total)
  }
}

export interface PipelineContext {
  project: Project
  story: Story
  settings: AppSettings
  cancellation: Cancellation
  emit: PipelineEmitter
  progress: ProgressReporter
}
