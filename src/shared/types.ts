/**
 * Everything shared between main, preload and renderer.
 *
 * This file is the single source of truth for the app's data shapes. It must stay free of
 * any Node or DOM API so both processes can import it.
 */

// ---------------------------------------------------------------------------
// Modes and formats
// ---------------------------------------------------------------------------

/** Which pipeline a project runs. Images/audio modes short-circuit the video pipeline. */
export type JobMode = 'video' | 'images' | 'audio'

/** Shorts are 9:16 vertical, Longs are 16:9 landscape. Drives the export folder too. */
export type Orientation = 'short' | 'long'

export type Resolution = '1080p' | '1440p'

export type Theme = 'dark' | 'light'

// ---------------------------------------------------------------------------
// Story / scenes
// ---------------------------------------------------------------------------

export interface Scene {
  sceneNumber: number
  narration: string
  imagePrompt: string
  mood: string
  /**
   * Starts as a word-count estimate and is OVERWRITTEN with the measured length of the
   * synthesized audio (ffprobe) once voice exists. Never trust it before the voice stage.
   */
  durationSeconds: number
  imagePath?: string
  audioPath?: string
  clipPath?: string
  /**
   * Identifies the motion settings the cached clip was rendered with. When this no longer
   * matches the project's current settings the clip MUST be re-rendered — a stale clip
   * silently ignores a motion change.
   */
  clipMotionKey?: string
  /**
   * Per-word timings from the voice engine, when it reports them. Persisted with the
   * scene so the subtitles stage (and a later audio regeneration) can rebuild exact cues
   * without re-synthesising.
   */
  wordTimings?: WordTiming[]
}

export interface Story {
  title: string
  scenes: Scene[]
  thumbnailPrompt?: string
  thumbnailPath?: string
}

// ---------------------------------------------------------------------------
// Pipeline / project
// ---------------------------------------------------------------------------

export const PIPELINE_STAGES = [
  'story',
  'images',
  'voice',
  'thumbnail',
  'clips',
  'review',
  'subtitles',
  'rendering',
  'export'
] as const

export type PipelineStage = (typeof PIPELINE_STAGES)[number]

export type StageStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped'

export interface StageState {
  status: StageStatus
  startedAt?: number
  finishedAt?: number
  error?: string
  /** Set when a stage error came from an automatic retry — used to persist the counter. */
  attempts?: number
}

export type ProjectStatus = 'idle' | 'running' | 'paused' | 'done' | 'failed' | 'cancelled'

export interface ProjectConfig {
  mode: JobMode
  orientation: Orientation
  resolution: Resolution
  channelId?: string
  channelName?: string

  imageProvider: string
  imageConcurrency: number
  /**
   * Attempts per provider before giving up on a scene. The pipeline then moves down the
   * fallback order (Meta AI → Gemini), so the worst case is `retries × fallbacks` tries.
   */
  imageRetries: number
  /** Folder the local-folder provider draws from. */
  imageSourceDir?: string

  motionEnabled: boolean
  animationStyle: string
  transitionStyle: string

  subtitlesEnabled: boolean
  subtitleStyle: string

  ttsEngine: TtsProviderId
  voiceId: string

  musicPath?: string
  musicVolume: number
}

export interface Project {
  id: string
  createdAt: number
  updatedAt: number
  title: string
  mode: JobMode
  status: ProjectStatus
  config: ProjectConfig
  stages: Record<string, StageState>
  /** asset key -> absolute path (cover, final video, thumbnail, music…) */
  assets: Record<string, string>
  outputPath?: string
  error?: string
}

// ---------------------------------------------------------------------------
// Channels and skills
// ---------------------------------------------------------------------------

export interface Channel {
  id: string
  name: string
  skillId?: string
  shortsOutputDir?: string
  longsOutputDir?: string
  createdAt: number
}

/** A locked "channel rulebook" — markdown text that Script AI writes a package against. */
export interface Skill {
  id: string
  name: string
  content: string
  updatedAt: number
}

/** Pushed on `scriptai:progress` while a package is being written. */
export interface ScriptAiProgress {
  round: number
  chars: number
  /** The tail of the model's output so far — proof it is alive and on track. */
  tail: string
  /** Set while waiting out a quota/spacing delay rather than writing. */
  waitingMs?: number
}

// ---------------------------------------------------------------------------
// TTS
// ---------------------------------------------------------------------------

export type TtsProviderId = 'edge-tts' | 'gemini' | 'kokoro' | 'azure' | 'ai33' | 'famespeak'

export type EngineBadge = 'LOCAL' | 'FREE' | 'API KEY'

export type AudioExtension = 'mp3' | 'wav'

/**
 * Metadata for one engine, rendered in the engine switcher bar.
 *
 * Adding an engine later (Piper, Qwen3, NeuTTS, Gemini…) means: implement `TtsEngine`
 * in `src/main/tts/engines/<id>.ts` and add one entry here. Nothing else changes.
 */
export interface TtsEngineMeta {
  id: TtsProviderId
  name: string
  badge: EngineBadge
  extension: AudioExtension
  needsKey: boolean
  /** True when the engine returns per-word timings — those give exact subtitles. */
  wordTimings: boolean
  /** Delivery controls this engine documents. Unknown fields on strict APIs fail requests. */
  controls: {
    speed?: boolean
    pitch?: boolean
    volume?: boolean
    emotion?: boolean
  }
  description: string
}

export interface TtsVoice {
  id: string
  name: string
  locale: string
  gender?: 'Male' | 'Female' | 'Unknown'
  tier?: 'free' | 'premium'
}

/**
 * Whether an engine can actually run right now, and why not when it cannot. Lives in
 * shared because the engine switcher bar is rendered from it.
 */
export interface EngineAvailability {
  meta: TtsEngineMeta
  available: boolean
  reason: string
}

export interface WordTiming {
  text: string
  startMs: number
  endMs: number
}

export interface SynthesizeOptions {
  /** Absolute path the audio must be written to. */
  outputPath: string
  speed?: number
  pitch?: number
  volume?: number
  mood?: string
  /** Cancellation probe, checked between chunks/retries. */
  isCancelled?: () => boolean
}

export interface SynthesizeResult {
  audioPath: string
  durationSeconds: number
  /** Present for engines with word timings (edge, ai33). Drives exact subtitles. */
  wordTimings?: WordTiming[]
  engine: TtsProviderId
  voiceId: string
}

// ---------------------------------------------------------------------------
// Image providers
// ---------------------------------------------------------------------------

export interface ImageProviderMeta {
  id: string
  name: string
  /** Browser providers need a logged-in WebContentsView; local needs nothing. */
  kind: 'browser' | 'local'
  description: string
}

export interface ProviderAvailability {
  meta: ImageProviderMeta
  ready: boolean
  reason: string
}

export interface GenerateImageOptions {
  prompt: string
  outputPath: string
  /** 0-based scene position — lets a non-generative source hand back images in order. */
  index: number
  /** Folder to draw from, for sources that read existing files instead of generating. */
  sourceDir?: string
  /** Scene mood, used by providers that can steer style. */
  mood?: string
  isCancelled?: () => boolean
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/**
 * Secrets are stored on disk as `<name>Enc` (Electron safeStorage). The plain field only
 * ever exists in memory, and `*Enc` fields are NEVER allowed to reach the renderer.
 */
export interface AppSettings {
  theme: Theme
  imageProvider: string
  imageConcurrency: number
  /** Retry count inherited by new projects — see `ProjectConfig.imageRetries`. */
  imageRetries: number
  /** Default image source folder for new projects. */
  imageSourceDir?: string
  ttsEngine: TtsProviderId
  voiceId: string
  /** One Gemini key per line, rotated on quota. */
  scriptAiKeys: string[]
  scriptAiModel: string
  azureKey?: string
  azureRegion?: string
  ai33Key?: string
  fameSpeakKey?: string
  geminiKey?: string
  /**
   * Path to a Google service-account JSON. Preferred over `geminiKey` when set: it is the
   * only one of the two that carries TTS quota and supports the style prompt.
   */
  geminiServiceAccountPath?: string
  /** Gemini TTS model id. The preview tier is the one with the expressive voices. */
  geminiModel: string
  /**
   * Natural-language style/emotion instruction sent alongside the narration
   * (`"read this warmly, like a documentary narrator"`). Empty means neutral delivery.
   */
  geminiStyle?: string
  /** Folder holding a Kokoro ONNX model. Empty means fetch the standard one. */
  kokoroModelDir?: string
  musicDir?: string
  musicVolume: number
  loudnessTarget: number
  defaultChannelId?: string
  lastOutputDir?: string
}

// ---------------------------------------------------------------------------
// Pipeline events
// ---------------------------------------------------------------------------

export interface PipelineProgress {
  projectId: string
  stage: PipelineStage | string
  stageStatus: StageStatus
  overallPercent: number
  message?: string
  imagesDone?: number
  imagesTotal?: number
  voiceDone?: number
  voiceTotal?: number
  sceneIndex?: number
  elapsedMs?: number
}

export interface PipelineErrorEvent {
  projectId: string
  stage: string
  error: string
  /** True when the pipeline itself scheduled this retry (manual retry resets the counter). */
  fromAutoRetry?: boolean
}

// ---------------------------------------------------------------------------
// Script import
// ---------------------------------------------------------------------------

export interface ParsedScene {
  sceneNumber: number
  narration: string
  imagePrompt: string
  mood: string
}

/**
 * The importer is deliberately deterministic — the user's words pass through untouched.
 * An AI may later FIND structure in an unknown file, but it never rewrites a prompt.
 */
export interface ParsedScript {
  title: string
  scenes: ParsedScene[]
  thumbnailPrompt?: string
  /** Which parser matched — surfaced in the UI so an odd result is explainable. */
  layout: string
  warnings: string[]
}

export interface ScriptValidation {
  ok: boolean
  errors: string[]
  warnings: string[]
}

export interface ScriptImportResult {
  script: ParsedScript
  validation: ScriptValidation
  /** Set when the script came from a file, so the UI can show where it came from. */
  filePath?: string
}

// ---------------------------------------------------------------------------
// IPC plumbing
// ---------------------------------------------------------------------------

/**
 * Handlers never reject across the bridge — an Electron rejection arrives with the channel
 * name glued onto the message. Returning a result keeps the renderer's error text readable.
 */
export type IpcResult<T> = { ok: true; data: T } | { ok: false; error: string }

export interface AppInfo {
  version: string
  platform: string
  userDataDir: string
  ffmpegPath: string
  ffprobePath: string
  /** False when the binaries are neither bundled nor on PATH. */
  binariesBundled: boolean
}

export interface PickOptions {
  title?: string
  filters?: Array<{ name: string; extensions: string[] }>
  defaultPath?: string
}

export interface EngineTestResult {
  ok: boolean
  message: string
  /**
   * File the test produced, when it produced one.
   *
   * A passing image test leaves something on disk worth looking at, and the user should not
   * have to parse a path back out of `message` to open it.
   */
  artifactPath?: string
}

export interface VoicePreviewResult {
  audioPath: string
  durationSeconds: number
}
