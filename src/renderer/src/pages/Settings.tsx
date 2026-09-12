/**
 * Settings — the defaults new projects start from, plus the API keys.
 *
 * Keys never come back from the main process. The field shows a placeholder when a key is
 * stored and only sends a value when the user actually types one, so opening this page can
 * never blank a working key.
 */
import { useEffect, useState } from 'react'
import { IMAGE_CONCURRENCY_MAX, GEMINI_TTS_MODELS, DEFAULT_SCRIPT_AI_MODEL } from '@shared/constants'
import type {
  AppSettings,
  EngineAvailability,
  ProviderAvailability,
  TtsProviderId
} from '@shared/types'
import { useApp } from '../store/app'

/** Which stored field holds each engine's credential. */
const KEY_FIELD: Partial<Record<TtsProviderId, keyof AppSettings>> = {
  azure: 'azureKey',
  ai33: 'ai33Key',
  famespeak: 'fameSpeakKey',
  gemini: 'geminiKey'
}

export function SettingsPage(): React.JSX.Element {
  const { settings, saveSettings, info } = useApp()
  const [engines, setEngines] = useState<EngineAvailability[]>([])
  const [providers, setProviders] = useState<ProviderAvailability[]>([])
  const [keyDrafts, setKeyDrafts] = useState<Record<string, string>>({})
  const [aiKeyDraft, setAiKeyDraft] = useState('')
  const [pexelsKeyDraft, setPexelsKeyDraft] = useState('')
  const [notice, setNotice] = useState<string | null>(null)
  const [testImage, setTestImage] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void window.api.tts.listEngines().then(setEngines).catch(() => undefined)
    void refreshProviders()
  }, [])

  async function refreshProviders(): Promise<void> {
    await window.api.images
      .listProviders()
      .then(setProviders)
      .catch(() => undefined)
  }

  if (!settings) {
    return (
      <div className="page">
        <div className="empty">Loading…</div>
      </div>
    )
  }

  const patch = (next: Partial<AppSettings>): void => {
    void saveSettings(next)
  }

  async function pickDir(field: 'imageSourceDir' | 'musicDir'): Promise<void> {
    const dir = await window.api.app.pickDir({
      title: field === 'imageSourceDir' ? 'Default images folder' : 'Music folder'
    })
    if (dir) patch({ [field]: dir } as Partial<AppSettings>)
  }

  async function pickServiceAccount(): Promise<void> {
    const file = await window.api.app.pickFile({
      title: 'Google service-account JSON',
      filters: [{ name: 'JSON', extensions: ['json'] }]
    })
    if (file) patch({ geminiServiceAccountPath: file })
  }

  async function pickKokoroDir(): Promise<void> {
    const dir = await window.api.app.pickDir({ title: 'Kokoro model folder' })
    if (dir) patch({ kokoroModelDir: dir })
  }

  /**
   * Sign a browser provider in.
   *
   * Where this opens depends on the provider, and the difference matters to the user.
   * Meta AI opens in an Electron window this app owns, in its own persistent partition.
   * Gemini opens in the *real Chrome* installed on the machine, on a profile of its own —
   * Google's sign-in refuses embedded browsers outright, so Chrome is the only way through.
   * Either way, whatever the user does there — password, 2FA, captcha — works exactly as it
   * does in a normal browser, and nothing about the credentials passes through this app.
   */
  async function connectProvider(providerId: string): Promise<void> {
    setNotice(
      providerId === 'gemini'
        ? 'Chrome is opening — sign in to Google there, then press Test.'
        : `Sign in to ${providerId} in the window that just opened, then press Test.`
    )
    try {
      await window.api.images.connect(providerId)
    } catch (err) {
      setNotice((err as Error).message)
    }
  }

  /** The honest check: load the page and look for the prompt box. */
  async function probeProvider(providerId: string): Promise<void> {
    setBusy(true)
    setNotice(null)
    try {
      const result = await window.api.images.probe(providerId)
      setNotice(`${providerId}: ${result.message}`)
    } catch (err) {
      setNotice((err as Error).message)
    } finally {
      setBusy(false)
      await refreshProviders()
    }
  }

  /**
   * The unambiguous check.
   *
   * "The prompt box is reachable" is not proof — both apps show a composer before sign-in,
   * and Gemini shows one while signed out. Making a real picture is the only result that
   * cannot be misread, so this is the button to press when a status looks wrong.
   */
  async function testProvider(providerId: string): Promise<void> {
    setBusy(true)
    setNotice(null)
    setTestImage(null)
    try {
      const result = await window.api.images.test(providerId)
      setNotice(`${providerId}: ${result.message}`)
      if (result.ok && result.artifactPath) setTestImage(result.artifactPath)
    } catch (err) {
      setNotice((err as Error).message)
    } finally {
      setBusy(false)
      await refreshProviders()
    }
  }

  /**
   * Ground-truth snapshot of what the provider's page actually contains.
   *
   * When Test fails, this is the answer to "is it signed out, or did the layout change?"
   * written straight to a file — the URL, every editable box, whether the page says login
   * anywhere, and which cookies exist. It opens so it can be read back to me.
   */
  async function debugProvider(providerId: string): Promise<void> {
    setBusy(true)
    setNotice('Capturing the page — a few seconds…')
    try {
      const path = await window.api.images.debug(providerId)
      setNotice(`Page report written to ${path}`)
      void window.api.app.openPath(path)
    } catch (err) {
      setNotice((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function disconnectProvider(providerId: string): Promise<void> {
    setBusy(true)
    setNotice(null)
    setTestImage(null)
    try {
      await window.api.images.disconnect(providerId)
      setNotice(
        providerId === 'gemini'
          ? 'gemini: signed out — Chrome was closed and its zBot profile erased.'
          : `${providerId}: session cleared. Use Connect to sign in again.`
      )
    } catch (err) {
      // A failure here used to be swallowed and reported as success, which made the button
      // look like it did nothing while the session was still sitting there.
      setNotice(`${providerId}: could not clear the session — ${(err as Error).message}`)
    } finally {
      setBusy(false)
      await refreshProviders()
    }
  }

  /** Both engine cards use the same flow: a real one-line synthesis, not just a ping. */
  async function runEngineTest(engineId: TtsProviderId): Promise<void> {
    setBusy(true)
    setNotice(null)
    try {
      const result = await window.api.settings.testEngine(engineId)
      setNotice(`${engineId}: ${result.message}`)
    } catch (err) {
      setNotice((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function saveKey(engineId: TtsProviderId): Promise<void> {
    const field = KEY_FIELD[engineId]
    if (!field) return

    const value = keyDrafts[engineId] ?? ''
    setBusy(true)
    setNotice(null)
    try {
      // Test before saving, so a bad key never becomes the stored one.
      const result = await window.api.settings.testEngine(engineId, { [field]: value })
      setNotice(`${engineId}: ${result.message}`)
      if (result.ok) {
        await saveSettings({ [field]: value } as Partial<AppSettings>)
        setKeyDrafts((current) => ({ ...current, [engineId]: '' }))
      }
    } catch (err) {
      setNotice((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  /**
   * Test the typed key pool, then save it as the pool on success.
   *
   * Same rule as the engine keys: nothing is stored until it has actually answered one
   * request. A partial paste (a line cut in half) would otherwise quietly bench itself.
   */
  async function saveScriptAiKeys(): Promise<void> {
    const keys = aiKeyDraft
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
    if (!keys.length) return

    setBusy(true)
    setNotice(null)
    try {
      const result = await window.api.scriptai.test({ scriptAiKeys: keys })
      setNotice(`Script AI: ${result.message}`)
      if (result.ok) {
        await saveSettings({ scriptAiKeys: keys })
        setAiKeyDraft('')
      }
    } catch (err) {
      setNotice((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="page">
      <div className="page__head">
        <h2>Settings</h2>
        <p>Defaults for new runs. Existing projects keep the settings they were created with.</p>
      </div>

      {notice ? <div className="alert alert--warn">{notice}</div> : null}

      <div className="card">
        <h3 className="card__title">Appearance</h3>
        <div className="chips">
          {(['dark', 'light'] as const).map((theme) => (
            <button
              key={theme}
              type="button"
              className={`chip${settings.theme === theme ? ' is-active' : ''}`}
              onClick={() => patch({ theme })}
            >
              {theme === 'dark' ? 'Dark' : 'Light'}
            </button>
          ))}
        </div>
      </div>

      <div className="card">
        <h3 className="card__title">Default voice</h3>
        <div className="chips" style={{ marginBottom: 14 }}>
          {engines.map((engine) => (
            <button
              key={engine.meta.id}
              type="button"
              title={engine.available ? engine.meta.description : engine.reason}
              className={`chip${settings.ttsEngine === engine.meta.id ? ' is-active' : ''}`}
              disabled={!engine.available}
              onClick={() => patch({ ttsEngine: engine.meta.id, voiceId: '' })}
            >
              {engine.meta.name}
            </button>
          ))}
        </div>

        <div className="field">
          <label htmlFor="default-voice">Voice id</label>
          <input
            id="default-voice"
            type="text"
            value={settings.voiceId}
            onChange={(event) => patch({ voiceId: event.target.value })}
            placeholder="Leave empty for the engine's default narrator"
          />
        </div>
      </div>

      {engines.some((engine) => engine.meta.needsKey) ? (
        <div className="card">
          <h3 className="card__title">API keys</h3>
          <p className="card__hint">
            Stored with the operating system's encryption. A key is tested before it is saved; a
            stored key is never sent back to this window.
          </p>

          {engines
            .filter((engine) => engine.meta.needsKey)
            .map((engine) => {
              const field = KEY_FIELD[engine.meta.id]
              const stored = field ? Boolean(settings[field]) : false

              return (
                <div className="field" key={engine.meta.id}>
                  <label htmlFor={`key-${engine.meta.id}`}>
                    {engine.meta.name}
                    {stored ? ' — key saved' : ''}
                  </label>
                  <div className="row">
                    <input
                      id={`key-${engine.meta.id}`}
                      type="password"
                      style={{ flex: 1 }}
                      value={keyDrafts[engine.meta.id] ?? ''}
                      placeholder={stored ? '••••••••  (type to replace)' : 'Paste the key'}
                      onChange={(event) =>
                        setKeyDrafts((current) => ({
                          ...current,
                          [engine.meta.id]: event.target.value
                        }))
                      }
                    />
                    <button
                      className="btn"
                      disabled={busy || !(keyDrafts[engine.meta.id] ?? '').trim()}
                      onClick={() => void saveKey(engine.meta.id)}
                    >
                      Test and save
                    </button>
                  </div>
                  <span className="muted" style={{ fontSize: 12 }}>
                    {engine.reason}
                  </span>
                </div>
              )
            })}
        </div>
      ) : null}

      <div className="card">
        <h3 className="card__title">Script AI</h3>
        <p className="card__hint">
          Gemini keys for writing scripts from skills. One key per line — when one hits its
          per-minute quota, the next takes over mid-sentence. Keys are tested before they are
          saved and stored encrypted; a saved pool is never sent back to this window.
        </p>

        <div className="field">
          <label htmlFor="scriptai-keys">
            {settings.scriptAiKeys.length > 0
              ? `${settings.scriptAiKeys.length} key${settings.scriptAiKeys.length === 1 ? '' : 's'} saved — type to replace`
              : 'API keys'}
          </label>
          <textarea
            id="scriptai-keys"
            rows={3}
            style={{ fontFamily: 'monospace' }}
            value={aiKeyDraft}
            placeholder={settings.scriptAiKeys.length ? '••••••••  (type to replace)' : 'One key per line'}
            onChange={(event) => setAiKeyDraft(event.target.value)}
          />
          <div className="row" style={{ marginTop: 10 }}>
            <button
              className="btn"
              disabled={busy || !aiKeyDraft.split('\n').some((line) => line.trim())}
              onClick={() => void saveScriptAiKeys()}
            >
              Test and save
            </button>
          </div>
        </div>

        <div className="field">
          <label htmlFor="scriptai-model">Model</label>
          <input
            id="scriptai-model"
            type="text"
            value={settings.scriptAiModel}
            placeholder={DEFAULT_SCRIPT_AI_MODEL}
            onBlur={(event) =>
              patch({ scriptAiModel: event.target.value.trim() || DEFAULT_SCRIPT_AI_MODEL })
            }
          />
          <span className="muted" style={{ fontSize: 12 }}>
            An alias like <span className="mono">{DEFAULT_SCRIPT_AI_MODEL}</span> survives Google
            retiring pinned model ids; a pinned id breaks silently the day it dies.
          </span>
        </div>
      </div>

      <div className="card">
        <h3 className="card__title">Stock footage</h3>
        <p className="card__hint">
          A Pexels key lets scripts mix real footage into a video — scenes written as
          <span className="mono"> Footage: </span> search and download a clip instead of
          generating an image. Free key at pexels.com/api; clips are licensed for commercial
          use with no attribution. Stored encrypted, never sent back to this window.
        </p>

        <div className="field">
          <label htmlFor="pexels-key">
            {settings.pexelsApiKey ? 'API key saved — type to replace' : 'API key'}
          </label>
          <input
            id="pexels-key"
            type="password"
            style={{ fontFamily: 'monospace' }}
            value={pexelsKeyDraft}
            placeholder={settings.pexelsApiKey ? '••••••••  (type to replace)' : 'Pexels API key'}
            onChange={(event) => setPexelsKeyDraft(event.target.value)}
          />
          <div className="row" style={{ marginTop: 10 }}>
            <button
              className="btn"
              disabled={busy || !pexelsKeyDraft.trim()}
              onClick={() => {
                patch({ pexelsApiKey: pexelsKeyDraft.trim() })
                setPexelsKeyDraft('')
                setNotice('Pexels key saved — encrypted on disk.')
              }}
            >
              Save key
            </button>
            {settings.pexelsApiKey ? (
              <button
                className="btn"
                onClick={() => {
                  patch({ pexelsApiKey: '' })
                  setNotice('Pexels key removed. Footage scenes will fall back to images.')
                }}
              >
                Remove
              </button>
            ) : null}
          </div>
        </div>
      </div>

      <div className="card">
        <h3 className="card__title">Gemini TTS</h3>
        <p className="card__hint">
          A service account is preferred over an API key: it is the only one of the two that
          carries TTS quota, and the only one that accepts the style instruction below. API
          keys issued in AI Studio often allow no TTS at all.
        </p>

        <div className="field">
          <label>Service account JSON</label>
          <div className="row">
            <span className="mono muted" style={{ flex: 1, overflowWrap: 'anywhere' }}>
              {settings.geminiServiceAccountPath || 'Not set'}
            </span>
            <button className="btn" onClick={() => void pickServiceAccount()}>
              Choose…
            </button>
            {settings.geminiServiceAccountPath ? (
              <button
                className="btn"
                onClick={() => patch({ geminiServiceAccountPath: '' })}
              >
                Clear
              </button>
            ) : null}
          </div>
        </div>

        <div className="field">
          <label htmlFor="gemini-model">Model</label>
          <select
            id="gemini-model"
            value={settings.geminiModel}
            onChange={(event) => patch({ geminiModel: event.target.value })}
          >
            {GEMINI_TTS_MODELS.map((model) => (
              <option key={model} value={model}>
                {model}
              </option>
            ))}
          </select>
        </div>

        <div className="field">
          <label htmlFor="gemini-style">Style instruction</label>
          <input
            id="gemini-style"
            type="text"
            value={settings.geminiStyle ?? ''}
            placeholder="Leave empty to let each scene's mood choose one"
            onChange={(event) => patch({ geminiStyle: event.target.value })}
          />
          <span className="muted" style={{ fontSize: 12 }}>
            Plain English, e.g. “read warmly, like a documentary narrator”.
          </span>
        </div>

        <button className="btn" disabled={busy} onClick={() => void runEngineTest('gemini')}>
          Synthesize a test line
        </button>
      </div>

      <div className="card">
        <h3 className="card__title">Kokoro</h3>
        <p className="card__hint">
          Fully offline. Leave the folder empty to fetch the standard model on first use.
        </p>

        <div className="field">
          <label>Kokoro model folder</label>
          <div className="row">
            <span className="mono muted" style={{ flex: 1, overflowWrap: 'anywhere' }}>
              {settings.kokoroModelDir || 'Not set — using the bundled default'}
            </span>
            <button className="btn" onClick={() => void pickKokoroDir()}>
              Choose…
            </button>
            {settings.kokoroModelDir ? (
              <button className="btn" onClick={() => patch({ kokoroModelDir: '' })}>
                Clear
              </button>
            ) : null}
          </div>
        </div>

        <button className="btn" disabled={busy} onClick={() => void runEngineTest('kokoro')}>
          Synthesize a test line
        </button>
      </div>

      <div className="card">
        <h3 className="card__title">Images</h3>
        <div className="field">
          <label>Default images folder</label>
          <div className="row">
            <span className="mono muted" style={{ flex: 1, overflowWrap: 'anywhere' }}>
              {settings.imageSourceDir || 'Not set'}
            </span>
            <button className="btn" onClick={() => void pickDir('imageSourceDir')}>
              Choose…
            </button>
          </div>
        </div>

        <div className="field">
          <label htmlFor="concurrency">How many at once</label>
          <input
            id="concurrency"
            type="number"
            min={1}
            max={IMAGE_CONCURRENCY_MAX}
            value={settings.imageConcurrency}
            onChange={(event) =>
              patch({
                imageConcurrency: Math.max(
                  1,
                  Math.min(IMAGE_CONCURRENCY_MAX, Number(event.target.value) || 1)
                )
              })
            }
          />
        </div>
      </div>

      <div className="card">
        <h3 className="card__title">Image providers</h3>
        <p className="muted" style={{ marginTop: 0 }}>
          Meta AI and Gemini draw the pictures for your scenes, using your own signed-in
          account. No API key, and nothing to pay per video. Sign in once — the session is
          remembered from then on.
        </p>
        <p className="muted">
          The two work differently, and it is worth knowing which is which. <strong>Meta AI</strong>{' '}
          runs in a small “zBot workers” window this app keeps on screen while it renders (the
          pages must stay visible to work). <strong>Gemini</strong>{' '}
          runs in the Chrome already installed on your PC, on a profile of its own — your normal
          Chrome stays untouched, but you will see tabs open there while a video renders.
          <br />
          <strong>Connect…</strong> opens the real sign-in page. <strong>Test</strong> checks
          whether the prompt box is reachable, which both apps show even when signed out — so a
          pass there is not proof. <strong>Test image</strong> makes one actual picture, and that
          result cannot be misread.
        </p>

        {providers.map((provider) => (
          <div className="field" key={provider.meta.id}>
            <div className="row">
              <strong style={{ flex: 1 }}>{provider.meta.name}</strong>
              <span className="mono muted">
                {provider.meta.kind === 'local'
                  ? 'No login needed'
                  : provider.ready
                    ? 'Signed in'
                    : 'Not signed in'}
              </span>
            </div>
            <div className="muted">{provider.meta.description}</div>

            {provider.meta.kind === 'browser' && (
              <div className="row">
                <button
                  className="btn"
                  disabled={busy}
                  onClick={() => void connectProvider(provider.meta.id)}
                >
                  Connect…
                </button>
                <button
                  className="btn"
                  disabled={busy}
                  onClick={() => void probeProvider(provider.meta.id)}
                >
                  Test
                </button>
                <button
                  className="btn"
                  disabled={busy}
                  onClick={() => void testProvider(provider.meta.id)}
                >
                  Test image
                </button>
                <button
                  className="btn"
                  disabled={busy}
                  onClick={() => void disconnectProvider(provider.meta.id)}
                >
                  Sign out
                </button>
                <button
                  className="btn"
                  disabled={busy}
                  onClick={() => void debugProvider(provider.meta.id)}
                >
                  Debug page
                </button>
              </div>
            )}

            {testImage && (
              <button className="btn" onClick={() => void window.api.app.openPath(testImage)}>
                Open the test image
              </button>
            )}

            {!provider.ready && provider.reason && <div className="muted">{provider.reason}</div>}
          </div>
        ))}
      </div>

      <div className="card">
        <h3 className="card__title">Music</h3>
        <div className="field">
          <label>Music folder</label>
          <div className="row">
            <span className="mono muted" style={{ flex: 1, overflowWrap: 'anywhere' }}>
              {settings.musicDir || 'Not set'}
            </span>
            <button className="btn" onClick={() => void pickDir('musicDir')}>
              Choose…
            </button>
          </div>
        </div>
      </div>

      {info ? (
        <div className="card">
          <h3 className="card__title">This machine</h3>
          <div className="mono muted" style={{ display: 'grid', gap: 4 }}>
            <span>Version {info.version}</span>
            <span>ffmpeg: {info.ffmpegPath}</span>
            <span>Data: {info.userDataDir}</span>
            {!info.binariesBundled ? (
              <span>ffmpeg is coming from PATH — a packaged build should ship its own.</span>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  )
}
