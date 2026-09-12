/**
 * The generation screen.
 *
 * Everything here is pushed from the main process — this page never polls. The stage list is
 * driven by `pipeline:progress`, so a stage that is skipped (subtitles off, thumbnail absent)
 * shows as skipped rather than sitting at pending forever.
 */
import { useEffect, useState } from 'react'
import { PIPELINE_STAGES } from '@shared/types'
import type { Project, Story } from '@shared/types'
import { usePipeline } from '../store/pipeline'
import { useApp } from '../store/app'

const STAGE_LABELS: Record<string, string> = {
  story: 'Story',
  images: 'Images',
  voice: 'Voice',
  thumbnail: 'Thumbnail',
  clips: 'Clips',
  review: 'Review',
  subtitles: 'Subtitles',
  rendering: 'Rendering',
  export: 'Export'
}

function formatElapsed(ms: number): string {
  const total = Math.floor(ms / 1000)
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}

export function GenerationPage({ onBack }: { onBack: () => void }): React.JSX.Element {
  const pipeline = usePipeline()
  const { projects } = useApp()
  const [project, setProject] = useState<Project | null>(null)
  const [story, setStory] = useState<Story | null>(null)

  const projectId = pipeline.projectId

  // Load the record once so the header and scene grid have a title to show.
  useEffect(() => {
    if (!projectId) return
    let cancelled = false

    void window.api.projects.get(projectId).then((result) => {
      if (cancelled || !result) return
      setProject(result.project)
      setStory(result.story)
    })

    return () => {
      cancelled = true
    }
  }, [projectId])

  // Re-read the record whenever the run ends, so the header status is not stale.
  useEffect(() => {
    if (!projectId) return
    if (pipeline.status !== 'done' && pipeline.status !== 'failed') return

    void window.api.projects.get(projectId).then((result) => {
      if (result) setProject(result.project)
    })
  }, [pipeline.status, projectId])

  if (!projectId || !pipeline.projectId) {
    return (
      <div className="page">
        <div className="page__head">
          <h2>Generation</h2>
          <p>Nothing is running right now.</p>
        </div>
        <div className="empty">Start a run from the Create Video page.</div>
      </div>
    )
  }

  const title = project?.title ?? projects.find((p) => p.id === projectId)?.title ?? 'Untitled'
  const scenes = story?.scenes ?? []

  async function cancel(): Promise<void> {
    await window.api.pipeline.cancel(projectId as string)
  }

  async function pause(): Promise<void> {
    await window.api.pipeline.pause(projectId as string)
  }

  async function resume(): Promise<void> {
    await window.api.pipeline.resume(projectId as string)
  }

  async function retry(): Promise<void> {
    usePipeline.getState().watch(projectId as string)
    await window.api.pipeline.retry(projectId as string)
  }

  return (
    <div className="page">
      <div className="page__head">
        <h2>{title}</h2>
        <p>
          {pipeline.status === 'running'
            ? `Running — ${formatElapsed(pipeline.elapsedMs)} elapsed`
            : pipeline.status === 'done'
              ? 'Finished'
              : pipeline.status === 'failed'
                ? 'Stopped with an error'
                : 'Idle'}
        </p>
      </div>

      <div className="card">
        <div className="row" style={{ justifyContent: 'space-between', marginBottom: 10 }}>
          <strong>{pipeline.overallPercent}%</strong>
          <div className="row">
            {pipeline.status === 'running' ? (
              <>
                <button className="btn" onClick={pause}>
                  Pause
                </button>
                <button className="btn" onClick={resume}>
                  Resume
                </button>
                <button className="btn btn--danger" onClick={cancel}>
                  Stop
                </button>
              </>
            ) : (
              <button className="btn btn--primary" onClick={retry}>
                Run again
              </button>
            )}
          </div>
        </div>
        <div className="progress">
          <div className="progress__fill" style={{ width: `${pipeline.overallPercent}%` }} />
        </div>
      </div>

      {pipeline.error ? (
        <div className="alert alert--error">
          <strong>{STAGE_LABELS[pipeline.error.stage] ?? pipeline.error.stage}:</strong>{' '}
          {pipeline.error.error}
        </div>
      ) : null}

      {pipeline.status === 'done' && pipeline.outputPath ? (
        <div className="alert alert--ok">
          Exported to <span className="mono">{pipeline.outputPath}</span>
          <div className="row" style={{ marginTop: 10 }}>
            <button
              className="btn"
              onClick={() => void window.api.app.openPath(pipeline.outputPath as string)}
            >
              Show in folder
            </button>
            <button className="btn btn--ghost" onClick={onBack}>
              Create another
            </button>
          </div>
        </div>
      ) : null}

      <div className="card">
        <h3 className="card__title">Stages</h3>
        <div className="stage-list">
          {PIPELINE_STAGES.map((stage) => {
            const view = pipeline.stages[stage] ?? { status: 'pending' as const }
            return (
              <div key={stage} className={`stage is-${view.status}`}>
                <span className={`stage__dot is-${view.status}`} />
                <span className="stage__name">{STAGE_LABELS[stage] ?? stage}</span>
                <span className="stage__msg">{view.message ?? ''}</span>
                <span className="stage__pct">{view.status}</span>
              </div>
            )
          })}
        </div>
      </div>

      {scenes.length ? (
        <div className="card">
          <h3 className="card__title">Scenes</h3>
          <div className="scene-grid">
            {scenes.map((scene) => {
              const live = pipeline.sceneOverrides[scene.sceneNumber] ?? scene
              return (
                <div className="scene" key={scene.sceneNumber}>
                  <div className="scene__no">
                    <span>Scene {scene.sceneNumber}</span>
                    <span>{live.durationSeconds.toFixed(1)}s</span>
                  </div>
                  <div className="scene__body">
                    <strong>{live.imagePrompt || '—'}</strong>
                    {live.narration}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      ) : null}

      {pipeline.logs.length ? (
        <div className="card">
          <h3 className="card__title">Log</h3>
          <div className="log">{pipeline.logs.join('\n')}</div>
        </div>
      ) : null}
    </div>
  )
}
