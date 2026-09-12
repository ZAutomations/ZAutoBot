/**
 * The shell: a left rail and five pages.
 *
 * All five pages stay mounted for the life of the window. Two reasons: a running pipeline
 * must keep receiving events while the user is reading Settings, and the create wizard must
 * not lose a half-typed script because someone glanced at History.
 */
import { useEffect, useState } from 'react'
import { useApp } from './store/app'
import { usePipeline } from './store/pipeline'
import { ChannelsPage } from './pages/Channels'
import { CreatePage } from './pages/Create'
import { GenerationPage } from './pages/Generation'
import { HistoryPage } from './pages/History'
import { SettingsPage } from './pages/Settings'

type PageId = 'create' | 'generation' | 'history' | 'channels' | 'settings'

const PAGES: Array<{ id: PageId; label: string }> = [
  { id: 'create', label: 'Create Video' },
  { id: 'generation', label: 'Generation' },
  { id: 'history', label: 'History' },
  { id: 'channels', label: 'Channels' },
  { id: 'settings', label: 'Settings' }
]

export default function App(): React.JSX.Element {
  const [page, setPage] = useState<PageId>('create')
  const { load, ready, settings, info } = useApp()
  const runStatus = usePipeline((state) => state.status)

  useEffect(() => {
    void load()
  }, [load])

  // Keep the DOM attribute in step with the stored theme; CSS reads it, never JS.
  useEffect(() => {
    document.documentElement.dataset.theme = settings?.theme ?? 'dark'
  }, [settings?.theme])

  return (
    <div className="app">
      <nav className="nav">
        <div className="nav__brand">
          <h1>zBot</h1>
          <p>Type a title. Get the whole video.</p>
        </div>

        {PAGES.map((entry) => (
          <button
            key={entry.id}
            className={`nav__item${page === entry.id ? ' is-active' : ''}`}
            onClick={() => setPage(entry.id)}
            type="button"
          >
            {entry.label}
            {entry.id === 'generation' && runStatus === 'running' ? (
              <span className="spinner" style={{ marginLeft: 'auto' }} />
            ) : null}
          </button>
        ))}

        <div className="nav__spacer" />

        <div className="nav__foot">
          {info ? `v${info.version}` : ''}
          {info && !info.binariesBundled ? ' · ffmpeg from PATH' : ''}
        </div>
      </nav>

      <main className="content">
        {!ready ? (
          <div className="empty">Loading…</div>
        ) : (
          <>
            <div className={page === 'create' ? '' : 'hidden'}>
              <CreatePage onStarted={() => setPage('generation')} />
            </div>
            <div className={page === 'generation' ? '' : 'hidden'}>
              <GenerationPage onBack={() => setPage('create')} />
            </div>
            <div className={page === 'history' ? '' : 'hidden'}>
              <HistoryPage onOpenGeneration={() => setPage('generation')} />
            </div>
            <div className={page === 'channels' ? '' : 'hidden'}>
              <ChannelsPage />
            </div>
            <div className={page === 'settings' ? '' : 'hidden'}>
              <SettingsPage />
            </div>
          </>
        )}
      </main>
    </div>
  )
}
