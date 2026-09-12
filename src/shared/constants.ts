/**
 * Shared constants and defaults. Every value the spec pins down lives here so main and
 * renderer can never drift apart.
 */
import type {
  AppSettings,
  ImageProviderMeta,
  JobMode,
  Orientation,
  ProjectConfig,
  Resolution,
  TtsEngineMeta
} from './types'

// ---------------------------------------------------------------------------
// TTS engines
// ---------------------------------------------------------------------------

/**
 * Engine metadata, rendered as the engine switcher bar.
 *
 * To add an engine (Piper, Qwen3-TTS, NeuTTS, Gemini…): implement the `TtsEngine`
 * interface in `src/main/tts/engines/<id>.ts`, then add one entry here. The registry,
 * the fallback chain, the UI bar and the settings page all pick it up automatically.
 */
export const TTS_ENGINES: TtsEngineMeta[] = [
  {
    id: 'edge-tts',
    name: 'Edge TTS',
    badge: 'FREE',
    extension: 'mp3',
    needsKey: false,
    wordTimings: true,
    controls: { speed: true, pitch: true, volume: true },
    description: 'Free Microsoft neural voices. Returns word timings, so subtitles are exact.'
  },
  {
    id: 'gemini',
    name: 'Gemini TTS',
    badge: 'API KEY',
    extension: 'wav',
    needsKey: true,
    wordTimings: false,
    controls: { speed: true, emotion: true },
    description:
      'Google\'s 30 expressive voices, steerable in plain English. Needs an API key.'
  },
  {
    id: 'kokoro',
    name: 'Kokoro',
    badge: 'LOCAL',
    extension: 'wav',
    needsKey: false,
    wordTimings: false,
    controls: { speed: true },
    description: 'Runs offline on this machine. No key, no network.'
  },
  {
    id: 'azure',
    name: 'Azure Speech',
    badge: 'API KEY',
    extension: 'mp3',
    needsKey: true,
    wordTimings: true,
    controls: { speed: true, pitch: true, volume: true },
    description: 'HD voices over REST. Needs a key and region.'
  },
  {
    id: 'ai33',
    name: 'ai33.pro',
    badge: 'API KEY',
    extension: 'mp3',
    needsKey: true,
    wordTimings: true,
    controls: { speed: true },
    description: 'Async task API with an SRT transcript, so cue timings come back exact.'
  },
  {
    id: 'famespeak',
    name: 'FameSpeak',
    badge: 'API KEY',
    extension: 'mp3',
    needsKey: true,
    wordTimings: false,
    controls: {},
    description: 'Async REST. Only its documented fields are sent — unknown fields fail every request.'
  }
]

export const DEFAULT_TTS_ENGINE = 'edge-tts' as const

/**
 * Gemini TTS models, best first. The `-preview` tier is the one that carries the
 * expressive star-named voices; the 2.5 tiers are the stable fallbacks when a request for
 * the preview model is refused.
 */
export const GEMINI_TTS_MODELS = [
  'gemini-3.1-flash-tts-preview',
  'gemini-2.5-flash-tts',
  'gemini-2.5-pro-tts',
  'gemini-2.5-flash-lite-tts'
] as const

export const DEFAULT_GEMINI_TTS_MODEL = GEMINI_TTS_MODELS[0]

// ---------------------------------------------------------------------------
// Script AI
// ---------------------------------------------------------------------------

/**
 * An alias on purpose: pinned model ids get retired (`gemini-2.5-flash-lite` died
 * mid-life with a 404 "no longer available") and a pinned default silently breaks
 * every generation. The alias tracks whatever Google currently serves as flash.
 */
export const DEFAULT_SCRIPT_AI_MODEL = 'gemini-flash-latest'

/** Hard cap on conversation rounds — a runaway skill must not loop forever. */
export const SCRIPT_AI_MAX_ROUNDS = 40

/** How many times a cut-off reply may be nudged to continue. */
export const SCRIPT_AI_MAX_NUDGES = 10

/**
 * Fallback chain: chosen engine -> one immediate retry -> Kokoro -> Edge.
 * A video never ships silent; an API failure downgrades the voice, never the run.
 */
export const TTS_FALLBACK_CHAIN = ['kokoro', 'edge-tts'] as const

// ---------------------------------------------------------------------------
// Image providers
// ---------------------------------------------------------------------------

export const IMAGE_PROVIDERS: ImageProviderMeta[] = [
  {
    id: 'metaai',
    name: 'Meta AI',
    kind: 'browser',
    description: 'Free. Drives Meta AI in your own signed-in session. Tried first.'
  },
  {
    id: 'gemini',
    name: 'Google Gemini',
    kind: 'browser',
    description: 'Free. Drives Gemini in your own signed-in session. Used when Meta AI fails.'
  },
  {
    id: 'local',
    name: 'Local Folder',
    kind: 'local',
    description: 'Uses image files from a folder you pick. No login, no network.'
  }
]

/**
 * Which provider to try, in order, when the chosen one fails to produce a scene.
 *
 * Kept free-provider-first: the whole point of browser automation here is that a video
 * costs nothing to make. `local` is deliberately absent — falling back to it would
 * silently pad a video with unrelated stock files instead of surfacing the failure.
 */
export const IMAGE_FALLBACK_ORDER = ['metaai', 'gemini'] as const

/**
 * Up to `imageConcurrency` generations at once. The RAM ladder keeps low-memory machines
 * from swapping; the user may raise it, capped at 30.
 */
export const IMAGE_CONCURRENCY_MAX = 30

/** How many times a provider gets to try one scene before the next fallback takes over. */
export const IMAGE_RETRY_DEFAULT = 2

export function defaultImageConcurrency(totalRamGb: number): number {
  if (totalRamGb < 8) return 4
  if (totalRamGb < 16) return 10
  return 20
}

// ---------------------------------------------------------------------------
// Motion and subtitles
// ---------------------------------------------------------------------------

export type MotionTier = 'ultra' | 'pro' | 'auto'

export interface MotionStyle {
  id: string
  name: string
  tier: MotionTier
  description: string
}

/**
 * Camera motion styles for the per-scene clips.
 * Defaults are deliberately subtle: `breathe` with a hard cut.
 */
export const ANIMATION_STYLES: MotionStyle[] = [
  { id: 'crash-zoom', name: 'Crash Zoom', tier: 'ultra', description: 'Fast punch in.' },
  { id: 'bullet-time', name: 'Bullet Time', tier: 'ultra', description: 'Slow, heavy push.' },
  { id: 'ken-burns', name: 'Ken Burns', tier: 'ultra', description: 'Classic slow zoom and drift.' },
  { id: 'zoom-in', name: 'Zoom In', tier: 'ultra', description: 'Steady push forward.' },
  { id: 'zoom-out', name: 'Zoom Out', tier: 'ultra', description: 'Steady pull back.' },
  { id: 'pan-left', name: 'Pan Left', tier: 'pro', description: 'Lateral travel, left.' },
  { id: 'pan-right', name: 'Pan Right', tier: 'pro', description: 'Lateral travel, right.' },
  { id: 'parallax', name: 'Parallax', tier: 'pro', description: 'Foreground drift against background.' },
  { id: 'cinematic-dolly', name: 'Cinematic Dolly', tier: 'pro', description: 'Slow film-style dolly.' },
  { id: 'drift', name: 'Drift', tier: 'pro', description: 'Gentle diagonal float.' },
  { id: 'breathe', name: 'Organic Breathe', tier: 'pro', description: 'Very subtle scale pulse. The default.' },
  { id: 'auto', name: 'Auto Mix', tier: 'auto', description: 'Rotates styles across scenes.' },
  { id: 'ai-director', name: 'AI Director', tier: 'auto', description: 'Picks per scene from its mood.' }
]

export const DEFAULT_ANIMATION_STYLE = 'breathe'

export interface TransitionStyle {
  id: string
  name: string
}

/**
 * `dark-fade` tints the frame edges — on bright artwork it reads as an unwanted vignette,
 * so it is NOT the default and the UI says so.
 */
export const TRANSITION_STYLES: TransitionStyle[] = [
  { id: 'hard-cut', name: 'Hard Cut' },
  { id: 'cross-fade', name: 'Cross Fade' },
  { id: 'dark-fade', name: 'Dark Fade (tints edges)' }
]

export const DEFAULT_TRANSITION_STYLE = 'hard-cut'

export interface SubtitleStyle {
  id: string
  name: string
}

export const SUBTITLE_STYLES: SubtitleStyle[] = [
  { id: 'bottom-bar', name: 'Bottom Bar' },
  { id: 'bold-outline', name: 'Bold Outline' },
  { id: 'neon', name: 'Neon' },
  { id: 'glass', name: 'Glass' },
  { id: 'minimal', name: 'Minimal' }
]

export const DEFAULT_SUBTITLE_STYLE = 'bottom-bar'

// ---------------------------------------------------------------------------
// Render / audio defaults
// ---------------------------------------------------------------------------

/** Short side in pixels per quality tier. Both output dimensions are always made even. */
export const RENDER_SHORT_SIDE: Record<Resolution, number> = {
  '1080p': 1080,
  '1440p': 1440
}

export const ORIENTATION_ASPECT: Record<Orientation, { w: number; h: number }> = {
  short: { w: 9, h: 16 },
  long: { w: 16, h: 9 }
}

/** YouTube standard loudness. Verify with ebur128 when debugging. */
export const LOUDNESS = { I: -14, TP: -1.5, LRA: 11 }

export const DEFAULT_MUSIC_VOLUME = 0.12

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

/** Share of the overall progress bar each stage owns. Must sum to 100. */
export const STAGE_WEIGHTS: Record<string, number> = {
  story: 5,
  images: 35,
  voice: 25,
  thumbnail: 2,
  clips: 15,
  review: 2,
  subtitles: 3,
  rendering: 10,
  export: 3
}

/** Stages that run concurrently once `story` is done. */
export const PARALLEL_ASSET_STAGES = ['images', 'voice', 'thumbnail'] as const

/** Auto-retry: give up early when the identical error keeps repeating. */
export const AUTO_RETRY_MAX = 60
export const AUTO_RETRY_IDENTICAL_LIMIT = 3

/** Words per minute used for the first-pass duration estimate, before audio exists. */
export const ESTIMATED_WORDS_PER_MINUTE = 150

/**
 * Bump this whenever clip render logic changes. Cached clips carry the version they were
 * rendered with, so changing the renderer invalidates them instead of shipping stale video.
 */
export const CLIP_RENDER_VERSION = 1

/** The motion settings a clip was rendered under — `on|style|transition` or `off`. */
export function clipMotionKey(
  motionEnabled: boolean,
  animationStyle: string,
  transitionStyle: string
): string {
  const key = motionEnabled ? `on|${animationStyle}|${transitionStyle}` : 'off'
  return `v${CLIP_RENDER_VERSION} ${key}`
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

export const DEFAULT_SETTINGS: AppSettings = {
  theme: 'dark',
  imageProvider: 'local',
  imageConcurrency: 20,
  imageRetries: IMAGE_RETRY_DEFAULT,
  ttsEngine: DEFAULT_TTS_ENGINE,
  voiceId: '',
  scriptAiKeys: [],
  scriptAiModel: DEFAULT_SCRIPT_AI_MODEL,
  pexelsApiKey: '',
  geminiModel: DEFAULT_GEMINI_TTS_MODEL,
  geminiServiceAccountPath: '',
  musicVolume: DEFAULT_MUSIC_VOLUME,
  loudnessTarget: LOUDNESS.I
}

export function defaultProjectConfig(mode: JobMode = 'video'): ProjectConfig {
  return {
    mode,
    orientation: 'short',
    resolution: '1080p',
    imageProvider: 'local',
    imageConcurrency: 20,
    imageRetries: IMAGE_RETRY_DEFAULT,
    motionEnabled: true,
    animationStyle: DEFAULT_ANIMATION_STYLE,
    transitionStyle: DEFAULT_TRANSITION_STYLE,
    subtitlesEnabled: true,
    subtitleStyle: DEFAULT_SUBTITLE_STYLE,
    ttsEngine: DEFAULT_TTS_ENGINE,
    voiceId: '',
    musicVolume: DEFAULT_MUSIC_VOLUME
  }
}
