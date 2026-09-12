/**
 * The create wizard.
 *
 * Four steps: what kind of run, where the script comes from, how it should look and sound,
 * then start. The parsed script is shown in full before anything is written to disk — the
 * importer is deterministic, so what is on screen is exactly what the pipeline will use.
 */
import { useEffect, useMemo, useState } from 'react'
import {
  ANIMATION_STYLES,
  defaultProjectConfig,
  SUBTITLE_STYLES,
  TRANSITION_STYLES
} from '@shared/constants'
import type {
  EngineAvailability,
  ImageProviderMeta,
  JobMode,
  ProjectConfig,
  ProviderAvailability,
  ScriptAiProgress,
  ScriptImportResult,
  Skill,
  TtsProviderId,
  TtsVoice
} from '@shared/types'
import { useApp } from '../store/app'
import { usePipeline } from '../store/pipeline'

const STEPS = ['Kind of run', 'Script', 'Look and sound', 'Start']

const MODES: Array<{ id: JobMode; name: string; description: string }> = [
  { id: 'video', name: 'Video', description: 'Images, voice, clips, subtitles and a final MP4.' },
  { id: 'images', name: 'Images only', description: 'Generate the scene artwork and stop.' },
  { id: 'audio', name: 'Audio only', description: 'Narration per scene, no visuals.' }
]

export function CreatePage({ onStarted }: { onStarted: () => void }): React.JSX.Element {
  const { settings, channels, refreshProjects } = useApp()

  const [step, setStep] = useState(0)
  const [mode, setMode] = useState<JobMode>('video')

  const [imported, setImported] = useState<ScriptImportResult | null>(null)
  const [pasted, setPasted] = useState('')
  const [importError, setImportError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const [config, setConfig] = useState<ProjectConfig>(() => defaultProjectConfig('video'))
  const [configured, setConfigured] = useState(false)

  const [engines, setEngines] = useState<EngineAvailability[]>([])
  const [providers, setProviders] = useState<ProviderAvailability[]>([])

  // Switching mode changes which fields matter, so start from that mode's defaults once.
  useEffect(() => {
    if (configured) return
    if (!settings) return
    setConfig((current) => ({
      ...defaultProjectConfig(mode),
      channelId: current.channelId,
      orientation: current.orientation,
      resolution: current.resolution,
      imageProvider: settings.imageProvider,
      imageConcurrency: settings.imageConcurrency,
      imageRetries: settings.imageRetries,
      imageSourceDir: settings.imageSourceDir,
      ttsEngine: settings.ttsEngine,
      voiceId: settings.voiceId,
      musicVolume: settings.musicVolume
    }))
  }, [mode, settings, configured])

  useEffect(() => {
    void window.api.tts.listEngines().then(setEngines).catch(() => undefined)
    void window.api.images.listProviders().then(setProviders).catch(() => undefined)
  }, [])

  const patch = (next: Partial<ProjectConfig>): void => {
    setConfigured(true)
    setConfig((current) => ({ ...current, ...next }))
  }

  const scenes = imported?.script.scenes ?? []
  const totalWords = useMemo(
    () => scenes.reduce((sum, scene) => sum + scene.narration.split(/\s+/).filter(Boolean).length, 0),
    [scenes]
  )

  async function pickScript(): Promise<void> {
    setImportError(null)
    try {
      const result = await window.api.script.pick(mode)
      if (!result) return
      setImported(result)
    } catch (err) {
      setImportError((err as Error).message)
    }
  }

  async function parsePasted(): Promise<void> {
    setImportError(null)
    try {
      setImported(await window.api.script.parseText(pasted, mode, 'pasted script'))
    } catch (err) {
      setImportError((err as Error).message)
    }
  }

  async function start(): Promise<void> {
    if (!imported) return

    setBusy(true)
    setImportError(null)
    try {
      const project = await window.api.projects.create({
        title: imported.script.title || 'Untitled',
        mode,
        config,
        script: imported.script
      })

      // Subscribe BEFORE starting, or the first progress events land with no listener.
      usePipeline.getState().watch(project.id)
      await window.api.pipeline.start(project.id)
      await refreshProjects()
      onStarted()
    } catch (err) {
      setImportError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const canAdvance =
    step === 0
      ? true
      : step === 1
        ? Boolean(imported?.validation.ok)
        : step === 2
          ? true
          : Boolean(imported?.validation.ok)

  return (
    <div className="page">
      <div className="page__head">
        <h2>Create a run</h2>
        <p>Bring a script. zBot handles the images, the voice, the cuts and the export.</p>
      </div>

      <div className="chips" style={{ marginBottom: 20 }}>
        {STEPS.map((label, index) => (
          <button
            key={label}
            type="button"
            className={`chip${index === step ? ' is-active' : ''}`}
            onClick={() => index <= step && setStep(index)}
            disabled={index > step}
          >
            {index + 1}. {label}
          </button>
        ))}
      </div>

      {importError ? <div className="alert alert--error">{importError}</div> : null}

      {step === 0 ? (
        <div className="card">
          <h3 className="card__title">What should this run produce?</h3>
          <div className="grid-2">
            {MODES.map((entry) => (
              <button
                key={entry.id}
                type="button"
                className={`chip${mode === entry.id ? ' is-active' : ''}`}
                style={{ flexDirection: 'column', alignItems: 'flex-start', padding: 16 }}
                onClick={() => {
                  setMode(entry.id)
                  setConfigured(false)
                }}
              >
                <strong>{entry.name}</strong>
                <span className="muted" style={{ fontSize: 12 }}>
                  {entry.description}
                </span>
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {step === 1 ? (
        <ScriptStep
          imported={imported}
          pasted={pasted}
          mode={mode}
          onPasted={setPasted}
          onPick={pickScript}
          onParse={parsePasted}
          onClear={() => setImported(null)}
          onImported={setImported}
        />
      ) : null}

      {step === 2 ? (
        <LookAndSoundStep
          mode={mode}
          config={config}
          patch={patch}
          engines={engines}
          providers={providers}
        />
      ) : null}

      {step === 3 ? (
        <div className="card">
          <h3 className="card__title">Ready</h3>
          <p className="muted">
            {scenes.length} scene{scenes.length === 1 ? '' : 's'}
            {mode !== 'images' ? ` · about ${Math.max(1, Math.round(totalWords / 150))} min of narration` : ''}
            {mode === 'video' ? ` · ${config.orientation === 'short' ? '9:16 Short' : '16:9 Long'}` : ''}
          </p>

          {channels.length === 0 && mode === 'video' ? (
            <div className="alert alert--warn">
              No channel yet — the finished video will be written to the project folder. Create a
              channel on the Channels page to send it straight to a Shorts or Longs folder.
            </div>
          ) : null}

          <button className="btn btn--primary" onClick={start} disabled={busy || !canAdvance}>
            {busy ? 'Starting…' : 'Start the run'}
          </button>
        </div>
      ) : null}

      <div className="row" style={{ marginTop: 18 }}>
        <button className="btn" onClick={() => setStep((s) => Math.max(0, s - 1))} disabled={step === 0}>
          Back
        </button>
        {step < 3 ? (
          <button
            className="btn btn--primary"
            onClick={() => setStep((s) => Math.min(3, s + 1))}
            disabled={!canAdvance}
          >
            Next
          </button>
        ) : null}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Step 2 — script
// ---------------------------------------------------------------------------

function ScriptStep(props: {
  imported: ScriptImportResult | null
  pasted: string
  mode: JobMode
  onPasted: (value: string) => void
  onPick: () => void
  onParse: () => void
  onClear: () => void
  onImported: (result: ScriptImportResult) => void
}): React.JSX.Element {
  const { imported, pasted, mode, onPasted, onPick, onParse, onClear, onImported } = props

  return (
    <>
      <div className="card">
        <h3 className="card__title">Import a script</h3>
        <p className="card__hint">
          Markdown, plain text or JSON. Numbered scenes become scenes; the narration is fitted to
          them.
        </p>
        <div className="row">
          <button className="btn" onClick={onPick}>
            Choose a file…
          </button>
          {imported ? (
            <button className="btn btn--ghost" onClick={onClear}>
              Clear
            </button>
          ) : null}
          {imported ? <span className="muted mono">{imported.filePath ?? 'pasted'}</span> : null}
        </div>
      </div>

      {!imported ? (
        <div className="card">
          <h3 className="card__title">…or let AI write it</h3>
          <FromSkillCard mode={mode} onImported={onImported} />
        </div>
      ) : null}

      {!imported ? (
        <div className="card">
          <h3 className="card__title">…or paste it</h3>
          <textarea
            value={pasted}
            onChange={(event) => onPasted(event.target.value)}
            placeholder={'My video title\n\n1. Scene one narration\n\nImage prompt for scene one\n\n2. …'}
          />
          <div className="row" style={{ marginTop: 10 }}>
            <button className="btn" onClick={onParse} disabled={!pasted.trim()}>
              Read this text
            </button>
          </div>
        </div>
      ) : null}

      {imported ? (
        <div className="card">
          <h3 className="card__title">
            {imported.script.title || 'Untitled'} — {imported.script.scenes.length} scenes
          </h3>
          <p className="card__hint">Read as: {imported.script.layout}</p>

          {imported.validation.errors.length ? (
            <div className="alert alert--error">
              This script cannot run as-is:
              <ul>
                {imported.validation.errors.map((error) => (
                  <li key={error}>{error}</li>
                ))}
              </ul>
            </div>
          ) : null}

          {imported.validation.warnings.length ? (
            <div className="alert alert--warn">
              <ul>
                {imported.validation.warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            </div>
          ) : null}

          <div className="scene-grid" style={{ marginTop: 14 }}>
            {imported.script.scenes.map((scene) => (
              <div className="scene" key={scene.sceneNumber}>
                <div className="scene__no">
                  <span>Scene {scene.sceneNumber}</span>
                  {scene.mood ? <span>{scene.mood}</span> : null}
                </div>
                <div className="scene__body">
                  <strong>{scene.imagePrompt || 'No image prompt'}</strong>
                  {scene.narration || 'No narration'}
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </>
  )
}

// ---------------------------------------------------------------------------
// Step 2 — from skill (Script AI)
// ---------------------------------------------------------------------------

/**
 * Skill + title in, a complete script package out.
 *
 * Generation is a long conversation — minutes of streaming, possibly quota waits between
 * rounds — so the card shows the model's tail as it arrives and a Cancel button, and the
 * result lands in the same `imported` state as a pasted or picked script: the deterministic
 * importer reads it, the same validation runs, nothing downstream can tell it was written
 * by a model.
 */
function FromSkillCard(props: {
  mode: JobMode
  onImported: (result: ScriptImportResult) => void
}): React.JSX.Element {
  const { mode, onImported } = props

  const [skills, setSkills] = useState<Skill[]>([])
  const [skillId, setSkillId] = useState('')
  const [title, setTitle] = useState('')
  const [pasteOpen, setPasteOpen] = useState(false)
  const [pastedSkill, setPastedSkill] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [progress, setProgress] = useState<ScriptAiProgress | null>(null)

  const loadSkills = (): void => {
    void window.api.skills
      .list()
      .then((list) => {
        setSkills(list)
        setSkillId((current) =>
          current && list.some((skill) => skill.id === current) ? current : (list[0]?.id ?? '')
        )
      })
      .catch(() => undefined)
  }

  useEffect(loadSkills, [])

  useEffect(() => {
    if (!busy) return
    return window.api.scriptai.onProgress(setProgress)
  }, [busy])

  async function uploadSkill(): Promise<void> {
    setError(null)
    try {
      const skill = await window.api.skills.pick()
      if (skill) loadSkills()
    } catch (err) {
      setError((err as Error).message)
    }
  }

  async function savePastedSkill(): Promise<void> {
    setError(null)
    try {
      const skill = await window.api.skills.save({ content: pastedSkill })
      setPastedSkill('')
      setPasteOpen(false)
      loadSkills()
      setSkillId(skill.id)
    } catch (err) {
      setError((err as Error).message)
    }
  }

  async function generate(): Promise<void> {
    if (!skillId || !title.trim()) return
    setBusy(true)
    setError(null)
    setProgress({ round: 1, chars: 0, tail: 'starting…' })
    try {
      const result = await window.api.scriptai.generate({
        skillId,
        title: title.trim(),
        mode
      })
      onImported(result)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
      setProgress(null)
    }
  }

  return (
    <>
      <p className="card__hint">
        A skill is the rulebook — format, tone, length. Add one below, give the video a title,
        and Gemini writes the whole package: scenes, narration, image prompts.
      </p>

      <div className="grid-2">
        <div className="field">
          <label htmlFor="skill">Skill</label>
          <select
            id="skill"
            value={skillId}
            disabled={busy}
            onChange={(event) => setSkillId(event.target.value)}
          >
            {skills.length === 0 ? <option value="">No skill yet — add one below</option> : null}
            {skills.map((skill) => (
              <option key={skill.id} value={skill.id}>
                {skill.name}
              </option>
            ))}
          </select>
          <div className="row" style={{ marginTop: 8 }}>
            <button className="btn" type="button" disabled={busy} onClick={() => setPasteOpen((open) => !open)}>
              Paste a skill
            </button>
            <button className="btn" type="button" disabled={busy} onClick={() => void uploadSkill()}>
              Upload…
            </button>
          </div>
        </div>

        <div className="field">
          <label htmlFor="video-title">Video title</label>
          <input
            id="video-title"
            type="text"
            value={title}
            disabled={busy}
            placeholder="What is this video about?"
            onChange={(event) => setTitle(event.target.value)}
          />
          <span className="muted" style={{ fontSize: 12 }}>
            The title is the brief — the skill is only the rules.
          </span>
        </div>
      </div>

      {pasteOpen ? (
        <div className="field" style={{ marginTop: 12 }}>
          <textarea
            rows={6}
            value={pastedSkill}
            onChange={(event) => setPastedSkill(event.target.value)}
            placeholder="Paste the skill's markdown here…"
          />
          <div className="row" style={{ marginTop: 8 }}>
            <button
              className="btn"
              type="button"
              disabled={!pastedSkill.trim()}
              onClick={() => void savePastedSkill()}
            >
              Save this skill
            </button>
          </div>
        </div>
      ) : null}

      {error ? <div className="alert alert--error" style={{ marginTop: 12 }}>{error}</div> : null}

      {busy ? (
        <div className="alert" style={{ marginTop: 12 }}>
          <strong>
            Writing{progress ? ` — round ${progress.round}` : '…'}
            {progress?.waitingMs
              ? ` · waiting out a quota pause (${Math.ceil(progress.waitingMs / 1000)}s)`
              : ''}
          </strong>
          {progress && progress.chars > 0 ? (
            <>
              <span className="muted" style={{ display: 'block', fontSize: 12 }}>
                {progress.chars.toLocaleString()} characters so far
              </span>
              <span className="mono muted" style={{ display: 'block', fontSize: 12 }}>
                …{progress.tail}
              </span>
            </>
          ) : null}
        </div>
      ) : null}

      <div className="row" style={{ marginTop: 12 }}>
        <button
          className="btn btn--primary"
          type="button"
          disabled={busy || !skillId || !title.trim()}
          onClick={() => void generate()}
        >
          {busy ? 'Writing…' : 'Write with AI'}
        </button>
        {busy ? (
          <button
            className="btn"
            type="button"
            onClick={() => void window.api.scriptai.cancel().catch(() => undefined)}
          >
            Cancel
          </button>
        ) : null}
      </div>
    </>
  )
}

// ---------------------------------------------------------------------------
// Step 3 — look and sound
// ---------------------------------------------------------------------------

function LookAndSoundStep(props: {
  mode: JobMode
  config: ProjectConfig
  patch: (next: Partial<ProjectConfig>) => void
  engines: EngineAvailability[]
  providers: ProviderAvailability[]
}): React.JSX.Element {
  const { mode, config, patch, engines, providers } = props
  const { channels } = useApp()

  const [voices, setVoices] = useState<TtsVoice[]>([])
  const [voiceError, setVoiceError] = useState<string | null>(null)

  useEffect(() => {
    if (mode === 'images') return
    let cancelled = false

    setVoiceError(null)
    window.api.tts
      .listVoices(config.ttsEngine)
      .then((list) => {
        if (!cancelled) setVoices(list)
      })
      .catch((err: Error) => {
        if (!cancelled) {
          setVoices([])
          setVoiceError(err.message)
        }
      })

    return () => {
      cancelled = true
    }
  }, [config.ttsEngine, mode])

  async function pickImageFolder(): Promise<void> {
    const dir = await window.api.app.pickDir({ title: 'Choose the images folder' })
    if (dir) patch({ imageSourceDir: dir })
  }

  async function pickMusic(): Promise<void> {
    const file = await window.api.app.pickFile({
      title: 'Choose a music bed',
      filters: [{ name: 'Audio', extensions: ['mp3', 'wav', 'm4a', 'aac', 'ogg'] }]
    })
    if (file) patch({ musicPath: file })
  }

  return (
    <>
      <div className="card">
        <h3 className="card__title">Output</h3>
        <div className="grid-2">
          <div className="field">
            <label htmlFor="channel">Channel</label>
            <select
              id="channel"
              value={config.channelId ?? ''}
              onChange={(event) => patch({ channelId: event.target.value || undefined })}
            >
              <option value="">No channel</option>
              {channels.map((channel) => (
                <option key={channel.id} value={channel.id}>
                  {channel.name}
                </option>
              ))}
            </select>
          </div>

          <div className="field">
            <label htmlFor="resolution">Quality</label>
            <select
              id="resolution"
              value={config.resolution}
              onChange={(event) =>
                patch({ resolution: event.target.value as ProjectConfig['resolution'] })
              }
            >
              <option value="1080p">1080p</option>
              <option value="1440p">1440p</option>
            </select>
          </div>
        </div>

        <div className="field">
          <label>Format</label>
          <div className="chips">
            {(['short', 'long'] as const).map((orientation) => (
              <button
                key={orientation}
                type="button"
                className={`chip${config.orientation === orientation ? ' is-active' : ''}`}
                onClick={() => patch({ orientation })}
              >
                {orientation === 'short' ? 'Short — 9:16' : 'Long — 16:9'}
              </button>
            ))}
          </div>
        </div>
      </div>

      {mode !== 'audio' ? (
        <div className="card">
          <h3 className="card__title">Images</h3>
          <div className="field">
            <label>Source</label>
            <div className="chips">
              {providers.map((provider) => (
                <button
                  key={provider.meta.id}
                  type="button"
                  className={`chip${config.imageProvider === provider.meta.id ? ' is-active' : ''}`}
                  onClick={() => patch({ imageProvider: provider.meta.id })}
                >
                  {provider.meta.name}
                </button>
              ))}
            </div>
            <span className="muted" style={{ fontSize: 12 }}>
              {providers.find((p) => p.meta.id === config.imageProvider)?.meta.description ?? ''}
            </span>
          </div>

          {config.imageProvider === 'local' ? (
            <div className="field">
              <label>Folder</label>
              <div className="row">
                <span className="mono muted" style={{ flex: 1, overflowWrap: 'anywhere' }}>
                  {config.imageSourceDir || 'No folder chosen'}
                </span>
                <button className="btn" onClick={pickImageFolder}>
                  Choose…
                </button>
              </div>
              <span className="muted" style={{ fontSize: 12 }}>
                One image per scene, in filename order. Fewer images than scenes means they repeat.
              </span>
            </div>
          ) : null}
        </div>
      ) : null}

      {mode !== 'audio' ? (
        <div className="card">
          <h3 className="card__title">Motion</h3>
          <div className="field">
            <div className="chips">
              <button
                type="button"
                className={`chip${!config.motionEnabled ? ' is-active' : ''}`}
                onClick={() => patch({ motionEnabled: false })}
              >
                Still frames
              </button>
              <button
                type="button"
                className={`chip${config.motionEnabled ? ' is-active' : ''}`}
                onClick={() => patch({ motionEnabled: true })}
              >
                Camera motion
              </button>
            </div>
          </div>

          {config.motionEnabled ? (
            <>
              <div className="field">
                <label>Style</label>
                <div className="chips">
                  {ANIMATION_STYLES.map((style) => (
                    <button
                      key={style.id}
                      type="button"
                      title={style.description}
                      className={`chip${config.animationStyle === style.id ? ' is-active' : ''}`}
                      onClick={() => patch({ animationStyle: style.id })}
                    >
                      {style.name}
                    </button>
                  ))}
                </div>
              </div>

              <div className="field">
                <label>Between scenes</label>
                <div className="chips">
                  {TRANSITION_STYLES.map((style) => (
                    <button
                      key={style.id}
                      type="button"
                      className={`chip${config.transitionStyle === style.id ? ' is-active' : ''}`}
                      onClick={() => patch({ transitionStyle: style.id })}
                    >
                      {style.name}
                    </button>
                  ))}
                </div>
              </div>
            </>
          ) : null}
        </div>
      ) : null}

      {mode !== 'images' ? (
        <div className="card">
          <h3 className="card__title">Voice</h3>
          <div className="field">
            <label>Engine</label>
            <div className="chips">
              {engines.map((engine) => (
                <button
                  key={engine.meta.id}
                  type="button"
                  title={engine.available ? engine.meta.description : engine.reason}
                  className={`chip${config.ttsEngine === engine.meta.id ? ' is-active' : ''}`}
                  disabled={!engine.available}
                  onClick={() =>
                    patch({ ttsEngine: engine.meta.id as TtsProviderId, voiceId: '' })
                  }
                >
                  {engine.meta.name}
                  <span
                    className={`badge${engine.meta.badge === 'FREE' ? ' badge--free' : ''}${
                      engine.meta.badge === 'LOCAL' ? ' badge--local' : ''
                    }`}
                  >
                    {engine.meta.badge}
                  </span>
                </button>
              ))}
            </div>
          </div>

          <div className="field">
            <label htmlFor="voice">Voice</label>
            <select
              id="voice"
              value={config.voiceId}
              onChange={(event) => patch({ voiceId: event.target.value })}
            >
              <option value="">Default narrator</option>
              {voices.map((voice) => (
                <option key={voice.id} value={voice.id}>
                  {voice.name} — {voice.locale}
                  {voice.gender ? ` · ${voice.gender}` : ''}
                </option>
              ))}
            </select>
            {voiceError ? (
              <span className="muted" style={{ fontSize: 12 }}>
                Could not load voices: {voiceError}
              </span>
            ) : null}
          </div>
        </div>
      ) : null}

      {mode === 'video' ? (
        <div className="card">
          <h3 className="card__title">Subtitles and music</h3>
          <div className="field">
            <div className="chips">
              <button
                type="button"
                className={`chip${config.subtitlesEnabled ? ' is-active' : ''}`}
                onClick={() => patch({ subtitlesEnabled: true })}
              >
                Burn in subtitles
              </button>
              <button
                type="button"
                className={`chip${!config.subtitlesEnabled ? ' is-active' : ''}`}
                onClick={() => patch({ subtitlesEnabled: false })}
              >
                No subtitles
              </button>
            </div>
          </div>

          {config.subtitlesEnabled ? (
            <div className="field">
              <label>Caption style</label>
              <div className="chips">
                {SUBTITLE_STYLES.map((style) => (
                  <button
                    key={style.id}
                    type="button"
                    className={`chip${config.subtitleStyle === style.id ? ' is-active' : ''}`}
                    onClick={() => patch({ subtitleStyle: style.id })}
                  >
                    {style.name}
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          <div className="field">
            <label>Music bed</label>
            <div className="row">
              <span className="mono muted" style={{ flex: 1, overflowWrap: 'anywhere' }}>
                {config.musicPath || 'No music'}
              </span>
              <button className="btn" onClick={pickMusic}>
                Choose…
              </button>
              {config.musicPath ? (
                <button className="btn btn--ghost" onClick={() => patch({ musicPath: undefined })}>
                  Remove
                </button>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}
    </>
  )
}
