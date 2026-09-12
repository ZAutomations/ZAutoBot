/**
 * Settings and media handlers: settings, the voice engines, image providers and music.
 */
import { promises as fs } from 'node:fs'
import { extname, join } from 'node:path'
import { IPC_CHANNELS } from '@shared/ipc'
import type {
  AppSettings,
  EngineTestResult,
  Scene,
  TtsProviderId,
  TtsVoice,
  VoicePreviewResult
} from '@shared/types'
import { probeProvider, signOut } from '../images/browser/browserProvider'
import {
  connect as connectChrome,
  probe as probeChrome,
  signOut as signOutChrome
} from '../images/browser/chromeProvider'
import { SIGN_IN_URL, type BrowserProviderId } from '../images/browser/config'
import { dumpChromePage, dumpProviderPage } from '../images/browser/debug'
import { openSignInWindow } from '../images/browser/session'
import { getImageProvider, imageProviderAvailability } from '../images/registry'
import { assetPath, getProject, loadStory, saveStory } from '../store/projects'
import { loadSettings, saveSettings } from '../store/settings'
import { paths } from '../store/paths'
import {
  clearVoiceCache,
  engineAvailability,
  engineMeta,
  getEngine,
  listVoices,
  previewVoice,
  synthesizeWithFallback
} from '../tts'
import { handle } from './handle'

const PREVIEW_TEXT = 'This is how this voice will read your script.'

const AUDIO_EXTENSIONS = new Set(['.mp3', '.wav', '.m4a', '.aac', '.ogg', '.flac'])

/**
 * Only the two browser-automation providers keep a session to connect. Anything else
 * reaching here is a bug in the caller, not a state the user can cause.
 */
function asBrowserProvider(id: string): BrowserProviderId {
  if (id === 'metaai' || id === 'gemini') return id
  throw new Error(`${id} has no browser session to connect.`)
}

/**
 * Gemini signs in through the user's own Chrome; Meta AI signs in through an Electron window
 * this app owns. Same button, two different browsers — see `chromeProvider.ts` for why.
 */
function isChromeProvider(id: BrowserProviderId): boolean {
  return id === 'gemini'
}

export function registerSettingsHandlers(): void {
  handle(IPC_CHANNELS.SETTINGS_GET, (): Promise<AppSettings> => loadSettings())

  handle(
    IPC_CHANNELS.SETTINGS_SET,
    async (patch: Partial<AppSettings>): Promise<AppSettings> => {
      const next = await saveSettings(patch)
      // A new API key can unlock a different voice list, so the cached one is now wrong.
      if (patch.azureKey !== undefined || patch.ai33Key !== undefined) clearVoiceCache()
      return next
    }
  )

  /**
   * Test an engine. The key currently being typed lives in the renderer until Save, so the
   * patch is merged in memory for the test rather than written to disk first.
   */
  handle(
    IPC_CHANNELS.SETTINGS_TEST_ENGINE,
    async (engineId: TtsProviderId, pending: Partial<AppSettings> = {}): Promise<EngineTestResult> => {
      const engine = getEngine(engineId)
      if (!engine) return { ok: false, message: `Unknown engine: ${engineId}` }

      const settings: AppSettings = { ...(await loadSettings()), ...pending }

      if (engine.test) return engine.test(settings)

      // No test hook on this engine — fall back to reporting whether it can run at all.
      const available = await engine.isAvailable(settings)
      return {
        ok: available,
        message: available
          ? `${engineMeta(engineId)?.name ?? engineId} is ready.`
          : engine.unavailableReason(settings)
      }
    }
  )
}

export function registerTtsHandlers(): void {
  handle(IPC_CHANNELS.TTS_LIST_ENGINES, async () => {
    const settings = await loadSettings()
    return engineAvailability(settings)
  })

  handle(
    IPC_CHANNELS.TTS_LIST_VOICES,
    async (engineId: TtsProviderId, force = false): Promise<TtsVoice[]> => {
      const settings = await loadSettings()
      return listVoices(engineId, settings, force)
    }
  )

  handle(
    IPC_CHANNELS.TTS_TEST_KEY,
    async (engineId: TtsProviderId, pending: Partial<AppSettings> = {}): Promise<EngineTestResult> => {
      const engine = getEngine(engineId)
      if (!engine) return { ok: false, message: `Unknown engine: ${engineId}` }

      const settings: AppSettings = { ...(await loadSettings()), ...pending }
      if (engine.test) return engine.test(settings)

      // No test hook: proving the key works means actually asking for the voice list.
      try {
        const voices = await engine.listVoices(settings)
        return voices.length
          ? { ok: true, message: `Connected — ${voices.length} voices available.` }
          : { ok: false, message: 'Connected, but the engine returned no voices.' }
      } catch (err) {
        return { ok: false, message: (err as Error).message }
      }
    }
  )

  handle(
    IPC_CHANNELS.TTS_PREVIEW,
    async (input: {
      engine: TtsProviderId
      voiceId: string
      text?: string
    }): Promise<VoicePreviewResult> => {
      const settings = await loadSettings()
      const extension = engineMeta(input.engine)?.extension ?? 'mp3'
      const outputPath = join(paths.root(), 'preview', `preview.${extension}`)

      const result = await previewVoice({
        text: input.text?.trim() || PREVIEW_TEXT,
        engine: input.engine,
        voiceId: input.voiceId,
        options: { outputPath },
        settings
      })

      return { audioPath: result.audioPath, durationSeconds: result.durationSeconds }
    }
  )

  /**
   * Re-synthesize one scene and re-measure it. The clip is invalidated too, because its
   * length was baked in from the old audio.
   */
  handle(
    IPC_CHANNELS.TTS_REGENERATE,
    async (input: { projectId: string; sceneNumber: number; text?: string }): Promise<Scene> => {
      const project = await getProject(input.projectId)
      if (!project) throw new Error('Project not found.')

      const story = await loadStory(input.projectId)
      if (!story) throw new Error('This project has no script.')

      const scene = story.scenes.find((s) => s.sceneNumber === input.sceneNumber)
      if (!scene) throw new Error(`No scene ${input.sceneNumber}.`)

      const settings = await loadSettings()
      const text = input.text?.trim() || scene.narration
      const extension = engineMeta(project.config.ttsEngine)?.extension ?? 'mp3'
      const outputPath = assetPath(
        project.id,
        'audio',
        `scene-${String(scene.sceneNumber).padStart(3, '0')}.${extension}`
      )

      const result = await synthesizeWithFallback({
        text,
        engine: project.config.ttsEngine,
        voiceId: project.config.voiceId,
        options: { outputPath, mood: scene.mood },
        settings
      })

      scene.narration = text
      scene.audioPath = result.audioPath
      scene.wordTimings = result.wordTimings
      if (result.durationSeconds > 0) scene.durationSeconds = result.durationSeconds

      // The cached clip was cut to the old audio length — it must not be reused.
      scene.clipPath = undefined
      scene.clipMotionKey = undefined

      await saveStory(project.id, story)
      return scene
    }
  )
}

export function registerImageHandlers(): void {
  handle(IPC_CHANNELS.IMAGE_LIST_PROVIDERS, async () => {
    const settings = await loadSettings()
    return imageProviderAvailability(settings)
  })

  /**
   * Open the provider's real page so the user can sign in — in real Chrome for Gemini, in an
   * Electron window for Meta AI. Whichever it is, the profile behind it is persistent, which
   * is what makes this a one-time job.
   */
  handle(IPC_CHANNELS.IMAGE_CONNECT, async (providerId: string): Promise<boolean> => {
    const id = asBrowserProvider(providerId)

    if (isChromeProvider(id)) {
      await connectChrome()
      return true
    }

    // The sign-in URL, not the home URL: Gemini's app page greets signed-out visitors with a
    // working composer, which hides the sign-in link the user actually needs.
    openSignInWindow(id, SIGN_IN_URL[id])
    return true
  })

  handle(IPC_CHANNELS.IMAGE_DISCONNECT, async (providerId: string): Promise<boolean> => {
    const id = asBrowserProvider(providerId)
    if (isChromeProvider(id)) await signOutChrome()
    else await signOut(id)
    return true
  })

  handle(IPC_CHANNELS.IMAGE_PROBE, async (providerId: string): Promise<EngineTestResult> => {
    const id = asBrowserProvider(providerId)
    return isChromeProvider(id) ? probeChrome() : probeProvider(id)
  })

  /**
   * Generate one real image.
   *
   * "Is the prompt box reachable" is not the same question as "can this thing make a
   * picture" — both apps show a composer before you sign in, and Gemini does so while
   * signed out. Producing an actual file is the only answer that cannot be misread.
   */
  handle(IPC_CHANNELS.IMAGE_TEST, async (providerId: string): Promise<EngineTestResult> => {
    const id = asBrowserProvider(providerId)
    const provider = getImageProvider(id)
    if (!provider) return { ok: false, message: `${id} is not registered.` }

    const outputPath = join(paths.root(), 'preview', `test-${id}.png`)
    const started = Date.now()

    try {
      await provider.generate(
        {
          prompt: 'A calm ocean at sunrise, wide open water, soft light',
          outputPath,
          index: 0,
          mood: 'calm'
        },
        await loadSettings()
      )

      const { size } = await fs.stat(outputPath)
      if (size < 8_000) {
        return { ok: false, message: `${id} produced only ${size} bytes — that is not an image.` }
      }

      return {
        ok: true,
        message: `${id} produced a real image in ${((Date.now() - started) / 1000).toFixed(0)}s.`,
        artifactPath: outputPath
      }
    } catch (err) {
      return { ok: false, message: (err as Error).message }
    }
  })

  handle(IPC_CHANNELS.IMAGE_DEBUG, async (providerId: string): Promise<string> => {
    const id = asBrowserProvider(providerId)
    const dump = isChromeProvider(id) ? await dumpChromePage(id) : await dumpProviderPage(id)
    const outputPath = join(paths.root(), 'preview', `${id}-debug.txt`)
    await fs.mkdir(join(paths.root(), 'preview'), { recursive: true })
    await fs.writeFile(outputPath, dump, 'utf8')
    return outputPath
  })

  handle(
    IPC_CHANNELS.IMAGE_REGENERATE,
    async (input: { projectId: string; sceneNumber: number; prompt?: string }): Promise<Scene> => {
      const project = await getProject(input.projectId)
      if (!project) throw new Error('Project not found.')

      const story = await loadStory(input.projectId)
      if (!story) throw new Error('This project has no script.')

      const scene = story.scenes.find((s) => s.sceneNumber === input.sceneNumber)
      if (!scene) throw new Error(`No scene ${input.sceneNumber}.`)

      const provider = getImageProvider(project.config.imageProvider)
      if (!provider) throw new Error(`Unknown image provider: ${project.config.imageProvider}`)

      const settings = await loadSettings()
      const prompt = input.prompt?.trim() || scene.imagePrompt
      const outputPath = assetPath(
        project.id,
        'images',
        `scene-${String(scene.sceneNumber).padStart(3, '0')}.png`
      )

      scene.imagePath = await provider.generate(
        {
          prompt,
          outputPath,
          index: story.scenes.indexOf(scene),
          sourceDir: project.config.imageSourceDir ?? settings.imageSourceDir,
          mood: scene.mood
        },
        settings
      )

      scene.imagePrompt = prompt
      // A new frame means the old clip no longer matches it.
      scene.clipPath = undefined
      scene.clipMotionKey = undefined

      await saveStory(project.id, story)
      return scene
    }
  )
}

export function registerMusicHandlers(): void {
  /**
   * Music is just a folder of audio files. Picking one per project keeps the settings
   * simple; no library index to go stale.
   */
  handle(IPC_CHANNELS.MUSIC_LIST, async (dir?: string): Promise<string[]> => {
    const settings = await loadSettings()
    const target = dir?.trim() || settings.musicDir?.trim()
    if (!target) return []

    let entries: string[]
    try {
      entries = await fs.readdir(target)
    } catch {
      return []
    }

    return entries
      .filter((name) => AUDIO_EXTENSIONS.has(extname(name).toLowerCase()))
      .map((name) => join(target, name))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }))
  })
}
