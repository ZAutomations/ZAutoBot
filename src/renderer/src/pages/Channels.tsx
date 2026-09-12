/**
 * Channels — a name, and where its Shorts and Longs go.
 *
 * The orientation chosen in the wizard decides which of the two folders a finished video is
 * copied into, so both are worth setting even if the channel only makes one format today.
 */
import { useState } from 'react'
import type { Channel } from '@shared/types'
import { useApp } from '../store/app'

interface Draft {
  id?: string
  name: string
  shortsOutputDir: string
  longsOutputDir: string
}

const EMPTY: Draft = { name: '', shortsOutputDir: '', longsOutputDir: '' }

export function ChannelsPage(): React.JSX.Element {
  const { channels, refreshChannels, setError } = useApp()
  const [draft, setDraft] = useState<Draft>(EMPTY)
  const [busy, setBusy] = useState(false)

  async function pickDir(field: 'shortsOutputDir' | 'longsOutputDir'): Promise<void> {
    const dir = await window.api.app.pickDir({
      title: field === 'shortsOutputDir' ? 'Shorts output folder' : 'Longs output folder'
    })
    if (dir) setDraft((current) => ({ ...current, [field]: dir }))
  }

  async function save(): Promise<void> {
    if (!draft.name.trim()) return
    setBusy(true)
    try {
      await window.api.channels.save({
        id: draft.id,
        name: draft.name.trim(),
        shortsOutputDir: draft.shortsOutputDir || undefined,
        longsOutputDir: draft.longsOutputDir || undefined
      })
      await refreshChannels()
      setDraft(EMPTY)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function remove(channel: Channel): Promise<void> {
    await window.api.channels.remove(channel.id)
    await refreshChannels()
    if (draft.id === channel.id) setDraft(EMPTY)
  }

  return (
    <div className="page">
      <div className="page__head">
        <h2>Channels</h2>
        <p>Where each kind of video is exported to.</p>
      </div>

      <div className="card">
        <h3 className="card__title">{draft.id ? 'Edit channel' : 'New channel'}</h3>

        <div className="field">
          <label htmlFor="channel-name">Name</label>
          <input
            id="channel-name"
            type="text"
            value={draft.name}
            onChange={(event) => setDraft((c) => ({ ...c, name: event.target.value }))}
            placeholder="e.g. History Shorts"
          />
        </div>

        <div className="field">
          <label>Shorts output folder (9:16)</label>
          <div className="row">
            <span className="mono muted" style={{ flex: 1, overflowWrap: 'anywhere' }}>
              {draft.shortsOutputDir || 'Not set'}
            </span>
            <button className="btn" onClick={() => void pickDir('shortsOutputDir')}>
              Choose…
            </button>
          </div>
        </div>

        <div className="field">
          <label>Longs output folder (16:9)</label>
          <div className="row">
            <span className="mono muted" style={{ flex: 1, overflowWrap: 'anywhere' }}>
              {draft.longsOutputDir || 'Not set'}
            </span>
            <button className="btn" onClick={() => void pickDir('longsOutputDir')}>
              Choose…
            </button>
          </div>
        </div>

        <div className="row">
          <button className="btn btn--primary" onClick={() => void save()} disabled={busy || !draft.name.trim()}>
            {draft.id ? 'Save changes' : 'Add channel'}
          </button>
          {draft.id ? (
            <button className="btn btn--ghost" onClick={() => setDraft(EMPTY)}>
              Cancel
            </button>
          ) : null}
        </div>
      </div>

      {channels.length === 0 ? (
        <div className="empty">No channels yet.</div>
      ) : (
        <div className="list">
          {channels.map((channel) => (
            <div className="list__item" key={channel.id}>
              <div className="list__main">
                <div className="list__title">{channel.name}</div>
                <div className="list__meta">
                  Shorts: {channel.shortsOutputDir || 'not set'} · Longs:{' '}
                  {channel.longsOutputDir || 'not set'}
                </div>
              </div>
              <button
                className="btn"
                onClick={() =>
                  setDraft({
                    id: channel.id,
                    name: channel.name,
                    shortsOutputDir: channel.shortsOutputDir ?? '',
                    longsOutputDir: channel.longsOutputDir ?? ''
                  })
                }
              >
                Edit
              </button>
              <button className="btn btn--danger" onClick={() => void remove(channel)}>
                Delete
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
