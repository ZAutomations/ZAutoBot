/**
 * Project handlers.
 *
 * A project is created from an already-parsed script, so the wizard can show the scene
 * breakdown before anything is written to disk.
 */
import { shell } from 'electron'
import { IPC_CHANNELS } from '@shared/ipc'
import { PIPELINE_STAGES } from '@shared/types'
import type { JobMode, ParsedScript, Project, ProjectConfig, StageState, Story } from '@shared/types'
import { storyFromScript } from '../script/toStory'
import {
  Cancellation,
  disposeCancellation,
  isPipelineRunning
} from '../pipeline/cancellation'
import { runExportStage } from '../pipeline/stages'
import { ProgressReporter } from '../pipeline/context'
import { paths } from '../store/paths'
import {
  createProject,
  deleteProject,
  getProject,
  listProjects,
  loadStory,
  saveStory,
  setProjectStatus,
  updateProject
} from '../store/projects'
import { loadSettings } from '../store/settings'
import { handle } from './handle'

export function registerProjectHandlers(): void {
  handle(IPC_CHANNELS.PROJECT_LIST, (): Promise<Project[]> => listProjects())

  handle(
    IPC_CHANNELS.PROJECT_GET,
    async (id: string): Promise<{ project: Project; story: Story | null } | null> => {
      const project = await getProject(id)
      if (!project) return null
      return { project, story: await loadStory(id) }
    }
  )

  handle(IPC_CHANNELS.PROJECT_STORY_GET, (id: string): Promise<Story | null> => loadStory(id))

  handle(
    IPC_CHANNELS.PROJECT_CREATE,
    async (input: {
      title: string
      mode: JobMode
      config?: Partial<ProjectConfig>
      script: ParsedScript
    }): Promise<Project> => {
      const project = await createProject({
        title: input.title || input.script.title,
        mode: input.mode,
        config: input.config
      })

      await saveStory(project.id, storyFromScript(input.script))
      return (await getProject(project.id)) ?? project
    }
  )

  handle(IPC_CHANNELS.PROJECT_DELETE, async (id: string) => {
    // Never yank a project's folder out from under a running pipeline.
    if (isPipelineRunning(id)) throw new Error('Stop the run before deleting this project.')
    disposeCancellation(id)
    await deleteProject(id)
  })

  handle(
    IPC_CHANNELS.PROJECT_UPDATE_CONFIG,
    async (id: string, patch: Partial<ProjectConfig>): Promise<Project | null> =>
      updateProject(id, (project) => ({ ...project, config: { ...project.config, ...patch } }))
  )

  /**
   * Send the run back to the review gate. Later stages are reset to pending and their
   * cached clips are dropped, because a changed voice or motion setting makes them stale.
   */
  handle(IPC_CHANNELS.PROJECT_RESET_TO_REVIEW, async (id: string): Promise<Project | null> => {
    return updateProject(id, (project) => {
      const stages: Record<string, StageState> = { ...project.stages }
      const from = PIPELINE_STAGES.indexOf('review')
      for (const stage of PIPELINE_STAGES.slice(from)) stages[stage] = { status: 'pending' }
      return { ...project, stages, status: 'idle', error: undefined }
    })
  })

  handle(IPC_CHANNELS.PROJECT_OPEN_FOLDER, async (id: string, subPath?: string) => {
    const target = subPath ?? paths.projectDir(id)
    const error = await shell.openPath(target)
    if (error) throw new Error(error)
  })

  /** Re-run just the copy step, for when the channel's output folder changed. */
  handle(IPC_CHANNELS.PROJECT_EXPORT, async (id: string): Promise<string | undefined> => {
    const project = await getProject(id)
    if (!project) throw new Error('Project not found.')

    const story = await loadStory(id)
    if (!story) throw new Error('This project has no script.')

    const settings = await loadSettings()
    await setProjectStatus(id, 'running')

    const emit = {
      progress: () => undefined,
      sceneUpdated: () => undefined,
      complete: () => undefined,
      error: () => undefined,
      log: () => undefined
    }

    try {
      const result = await runExportStage({
        project,
        story,
        settings,
        cancellation: new Cancellation(),
        emit,
        progress: new ProgressReporter(id, emit)
      })
      await setProjectStatus(id, 'done')
      return result
    } catch (err) {
      const message = (err as Error).message
      await updateProject(id, (p) => ({ ...p, status: 'failed', error: message }))
      throw err
    }
  })
}
