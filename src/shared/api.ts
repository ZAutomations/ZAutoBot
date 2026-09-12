/**
 * The `window.api` contract.
 *
 * This is the ONLY way the renderer reaches the main process. It lives in `shared` so the
 * preload's implementation and the renderer's usage are checked against one definition —
 * adding a method here turns a missing handler into a compile error.
 *
 * Every method either resolves with real data or **rejects with a plain `Error`**: the
 * preload unwraps the `IpcResult` envelope, so the renderer writes ordinary try/catch.
 */
import type {
  AppInfo,
  AppSettings,
  Channel,
  EngineAvailability,
  EngineTestResult,
  JobMode,
  ParsedScript,
  PickOptions,
  PipelineErrorEvent,
  PipelineProgress,
  Project,
  ProjectConfig,
  ProviderAvailability,
  Scene,
  ScriptAiProgress,
  ScriptImportResult,
  Skill,
  Story,
  TtsProviderId,
  TtsVoice,
  VoicePreviewResult
} from './types'

/** Payload pushed on `pipeline:scene-updated`. */
export interface SceneUpdatedEvent {
  projectId: string
  scene: Scene
}

/** Payload pushed on `pipeline:complete`. */
export interface PipelineCompleteEvent {
  projectId: string
  outputPath?: string
}

/** Payload pushed on `pipeline:log`. */
export interface PipelineLogEvent {
  projectId: string
  message: string
}

/** Every `on*` subscription returns its own unsubscribe function. */
export type Unsubscribe = () => void

export interface ZBotApi {
  app: {
    info(): Promise<AppInfo>
    /** Reveal a file or folder in Explorer. */
    openPath(target: string): Promise<void>
    pickFile(options?: PickOptions): Promise<string | null>
    pickDir(options?: PickOptions): Promise<string | null>
  }

  settings: {
    get(): Promise<AppSettings>
    set(patch: Partial<AppSettings>): Promise<AppSettings>
    /** Test an engine, optionally with a key the user has typed but not saved yet. */
    testEngine(
      engineId: TtsProviderId,
      pending?: Partial<AppSettings>
    ): Promise<EngineTestResult>
  }

  script: {
    /** Opens a picker. Resolves `null` when the user cancels. */
    pick(mode: JobMode): Promise<ScriptImportResult | null>
    parseText(text: string, mode: JobMode, filename?: string): Promise<ScriptImportResult>
    parseFiles(input: {
      narrationPath?: string
      promptsPath?: string
      thumbnailPath?: string
      title?: string
      mode: JobMode
    }): Promise<ScriptImportResult>
  }

  scriptai: {
    /**
     * Run a skill + title through Gemini. Resolves with the imported package — minutes
     * can pass first; progress arrives through `onProgress`.
     */
    generate(input: { skillId: string; title: string; mode: JobMode }): Promise<ScriptImportResult>
    cancel(): Promise<boolean>
    onProgress(listener: (data: ScriptAiProgress) => void): Unsubscribe
    /** Test keys the user has typed but not necessarily saved yet. */
    test(pending?: Partial<AppSettings>): Promise<EngineTestResult>
  }

  skills: {
    list(): Promise<Skill[]>
    /** Name is optional — the skill's own frontmatter or heading names it. */
    save(input: { id?: string; name?: string; content: string }): Promise<Skill>
    remove(id: string): Promise<void>
    /** Opens a picker (md/txt/pdf/skill/zip), extracts and saves. `null` = cancelled. */
    pick(): Promise<Skill | null>
  }

  channels: {
    list(): Promise<Channel[]>
    save(input: Partial<Channel> & { name: string }): Promise<Channel>
    update(id: string, patch: Partial<Channel>): Promise<Channel | null>
    remove(id: string): Promise<void>
  }

  projects: {
    list(): Promise<Project[]>
    get(id: string): Promise<{ project: Project; story: Story | null } | null>
    story(id: string): Promise<Story | null>
    create(input: {
      title: string
      mode: JobMode
      config?: Partial<ProjectConfig>
      script: ParsedScript
    }): Promise<Project>
    remove(id: string): Promise<void>
    updateConfig(id: string, patch: Partial<ProjectConfig>): Promise<Project | null>
    resetToReview(id: string): Promise<Project | null>
    openFolder(id: string, subPath?: string): Promise<void>
    export(id: string): Promise<string | undefined>
  }

  pipeline: {
    /** Kicks off the run and returns immediately — progress arrives as events. */
    start(projectId: string): Promise<void>
    retry(projectId: string): Promise<void>
    cancel(projectId: string): Promise<boolean>
    pause(projectId: string): Promise<boolean>
    resume(projectId: string): Promise<boolean>

    onProgress(listener: (data: PipelineProgress) => void): Unsubscribe
    onComplete(listener: (data: PipelineCompleteEvent) => void): Unsubscribe
    onError(listener: (data: PipelineErrorEvent) => void): Unsubscribe
    onSceneUpdated(listener: (data: SceneUpdatedEvent) => void): Unsubscribe
    onLog(listener: (data: PipelineLogEvent) => void): Unsubscribe
  }

  tts: {
    listEngines(): Promise<EngineAvailability[]>
    listVoices(engineId: TtsProviderId, force?: boolean): Promise<TtsVoice[]>
    testKey(
      engineId: TtsProviderId,
      pending?: Partial<AppSettings>
    ): Promise<EngineTestResult>
    preview(input: {
      engine: TtsProviderId
      voiceId: string
      text?: string
    }): Promise<VoicePreviewResult>
    /** Re-synthesize one scene. The scene's clip is invalidated as a side effect. */
    regenerate(input: { projectId: string; sceneNumber: number; text?: string }): Promise<Scene>
  }

  images: {
    listProviders(): Promise<ProviderAvailability[]>
    regenerate(input: {
      projectId: string
      sceneNumber: number
      prompt?: string
    }): Promise<Scene>
    /** Opens a visible window so the user can sign the provider in. */
    connect(providerId: string): Promise<boolean>
    /** Forgets the provider's saved session. */
    disconnect(providerId: string): Promise<boolean>
    /** Loads the provider's page and checks for the prompt box — the real sign-in test. */
    probe(providerId: string): Promise<EngineTestResult>
    /** Generates one actual image; the only unambiguous proof the provider works. */
    test(providerId: string): Promise<EngineTestResult>
    /** Writes a page ground-truth report to a file and returns its path. For diagnosing a failed probe. */
    debug(providerId: string): Promise<string>
  }

  music: {
    list(dir?: string): Promise<string[]>
  }
}
