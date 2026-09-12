/**
 * Past runs.
 *
 * A finished project is never re-run blindly: opening one restores its recorded stage
 * states, and "Run again" is an explicit choice. Stages skip assets already on disk, so
 * running again only repeats what actually failed.
 */
import { useEffect } from 'react'
import type { Project } from '@shared/types'
import { useApp } from '../store/app'
import { usePipeline } from '../store/pipeline'

const STATUS_LABEL: Record<Project['status'], string> = {
  idle: 'Not started',
  running: 'Running',
  paused: 'Paused',
  done: 'Done',
  failed: 'Failed',
  cancelled: 'Stopped'
}

function relativeTime(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000)
  if (seconds < 60) return 'just now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} h ago`
  return `${Math.floor(hours / 24)} d ago`
}

export function HistoryPage({
  onOpenGeneration
}: {
  onOpenGeneration: () => void
}): React.JSX.Element {
  const { projects, refreshProjects } = useApp()

  useEffect(() => {
    void refreshProjects()
  }, [refreshProjects])

  function open(project: Project): void {
    usePipeline.getState().open({
      projectId: project.id,
      status: project.status,
      stages: project.stages,
      outputPath: project.outputPath
    })
    onOpenGeneration()
  }

  async function remove(project: Project): Promise<void> {
    await window.api.projects.remove(project.id)
    await refreshProjects()
  }

  async function runAgain(project: Project): Promise<void> {
    usePipeline.getState().watch(project.id)
    await window.api.pipeline.retry(project.id)
    onOpenGeneration()
  }

  return (
    <div className="page">
      <div className="page__head">
        <h2>History</h2>
        <p>Every run this machine has produced.</p>
      </div>

      {projects.length === 0 ? (
        <div className="empty">Nothing here yet. Create a run to get started.</div>
      ) : (
        <div className="list">
          {projects.map((project) => (
            <div className="list__item" key={project.id}>
              <div className="list__main">
                <div className="list__title">{project.title}</div>
                <div className="list__meta">
                  {STATUS_LABEL[project.status]} · {project.mode} · {project.config.orientation} ·{' '}
                  {relativeTime(project.createdAt)}
                  {project.error ? ` · ${project.error}` : ''}
                </div>
              </div>

              <button className="btn" onClick={() => open(project)}>
                Open
              </button>

              {project.outputPath ? (
                <button
                  className="btn btn--ghost"
                  onClick={() => void window.api.app.openPath(project.outputPath as string)}
                >
                  Show file
                </button>
              ) : (
                <button className="btn" onClick={() => void runAgain(project)}>
                  Run
                </button>
              )}

              <button
                className="btn btn--ghost"
                onClick={() => void window.api.projects.openFolder(project.id)}
              >
                Folder
              </button>

              <button className="btn btn--danger" onClick={() => void remove(project)}>
                Delete
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
