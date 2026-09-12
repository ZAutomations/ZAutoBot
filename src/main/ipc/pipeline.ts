/**
 * Pipeline handlers.
 *
 * `start` deliberately does NOT await the run — a pipeline takes minutes and the renderer
 * would sit on a dead promise. It kicks the run off and returns; everything after that
 * arrives as pushed events.
 */
import { BrowserWindow } from 'electron'
import { IPC_CHANNELS } from '@shared/ipc'
import type { PipelineErrorEvent, PipelineProgress, Scene } from '@shared/types'
import { runPipeline } from '../pipeline/orchestrator'
import type { PipelineEmitter } from '../pipeline/context'
import {
  cancelPipeline,
  getCancellation,
  isPipelineRunning
} from '../pipeline/cancellation'
import { handle } from './handle'

/** Every event the pipeline raises goes to every open window; each one filters by id. */
function broadcast(channel: string, payload: unknown): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(channel, payload)
  }
}

const emitter: PipelineEmitter = {
  progress: (data: PipelineProgress) => broadcast(IPC_CHANNELS.PIPELINE_PROGRESS, data),
  sceneUpdated: (projectId: string, scene: Scene) =>
    broadcast(IPC_CHANNELS.PIPELINE_SCENE_UPDATED, { projectId, scene }),
  complete: (projectId: string, outputPath?: string) =>
    broadcast(IPC_CHANNELS.PIPELINE_COMPLETE, { projectId, outputPath }),
  error: (data: PipelineErrorEvent) => broadcast(IPC_CHANNELS.PIPELINE_ERROR, data),
  log: (projectId: string, message: string) =>
    broadcast(IPC_CHANNELS.PIPELINE_LOG, { projectId, message })
}

export function registerPipelineHandlers(): void {
  handle(IPC_CHANNELS.PIPELINE_START, (projectId: string) => {
    if (isPipelineRunning(projectId)) {
      throw new Error('This project is already running.')
    }

    // Not awaited — see the note at the top of this file.
    void runPipeline({ projectId, emit: emitter }).catch((err) => {
      // runPipeline handles its own failures; this only catches a bug in the orchestrator.
      console.error('[pipeline] unexpected failure:', err)
      broadcast(IPC_CHANNELS.PIPELINE_ERROR, {
        projectId,
        stage: 'unknown',
        error: (err as Error)?.message ?? String(err)
      })
    })
  })

  handle(IPC_CHANNELS.PIPELINE_RETRY, (projectId: string) => {
    // Retry is a fresh start: stages skip whatever is already on disk, so only the work
    // that failed is actually repeated.
    if (isPipelineRunning(projectId)) {
      throw new Error('This project is already running.')
    }

    void runPipeline({ projectId, emit: emitter }).catch((err) => {
      console.error('[pipeline] unexpected failure on retry:', err)
      broadcast(IPC_CHANNELS.PIPELINE_ERROR, {
        projectId,
        stage: 'unknown',
        error: (err as Error)?.message ?? String(err)
      })
    })
  })

  handle(IPC_CHANNELS.PIPELINE_CANCEL, (projectId: string): boolean =>
    cancelPipeline(projectId)
  )

  handle(IPC_CHANNELS.PIPELINE_PAUSE, (projectId: string): boolean => {
    const token = getCancellation(projectId)
    if (!token) return false
    token.pause()
    return true
  })

  handle(IPC_CHANNELS.PIPELINE_RESUME, (projectId: string): boolean => {
    const token = getCancellation(projectId)
    if (!token) return false
    token.resume()
    return true
  })
}
