/**
 * Camera motion for per-scene clips.
 *
 * A clip is a still image animated with ffmpeg's `zoompan`. The image is first fitted to
 * the target canvas (scaled down and padded, never cropped), then scaled 2x so zoompan's
 * integer rounding does not produce visible jitter at these low zoom levels.
 *
 * `d=1` with a looped input means every output frame is one input frame, so `on` (the
 * output frame index) is a clean time axis and `z` can be any function of it.
 */
import { ORIENTATION_ASPECT } from '@shared/constants'
import type { Orientation } from '@shared/types'

export const MOTION_FPS = 30

/** Styles `auto` rotates through, in order. */
const AUTO_ROTATION = [
  'ken-burns',
  'zoom-in',
  'pan-left',
  'drift',
  'zoom-out',
  'pan-right',
  'cinematic-dolly',
  'parallax'
]

/** Mood keywords -> a style an AI director would pick. First match wins. */
const MOOD_STYLES: Array<{ pattern: RegExp; style: string }> = [
  { pattern: /calm|sad|peace|gentle|soft|serene/, style: 'breathe' },
  { pattern: /energ|excit|action|hype|fast|urgent|intense/, style: 'crash-zoom' },
  { pattern: /mysteri|dark|tense|suspense|eerie|horror|creep/, style: 'bullet-time' },
  { pattern: /happy|warm|joy|bright|fun|upbeat|cheer/, style: 'ken-burns' },
  { pattern: /drama|epic|cinematic|grand|majestic|sweep/, style: 'cinematic-dolly' },
  { pattern: /hope|rise|up|grow|progress|ascend|build/, style: 'zoom-in' },
  { pattern: /loss|down|fall|decline|fade|retreat/, style: 'zoom-out' },
  { pattern: /wide|landscape|vast|journey|travel|explore/, style: 'parallax' }
]

/**
 * Turn the configured style into the one a scene actually renders with.
 * `none` means still frames — right for flat/whiteboard artwork.
 */
export function resolveMotionStyle(
  style: string,
  sceneIndex: number,
  mood?: string,
  motionEnabled = true
): string {
  if (!motionEnabled) return 'none'
  if (style === 'auto') {
    return AUTO_ROTATION[sceneIndex % AUTO_ROTATION.length]
  }
  if (style === 'ai-director') {
    const text = (mood ?? '').toLowerCase()
    const match = MOOD_STYLES.find((entry) => entry.pattern.test(text))
    return match?.style ?? 'drift'
  }
  return style
}

interface ZoompanExpressions {
  z: string
  x: string
  y: string
}

const CENTER_X = 'iw/2-(iw/zoom/2)'
const CENTER_Y = 'ih/2-(ih/zoom/2)'

function expressions(style: string, frames: number): ZoompanExpressions {
  const n = Math.max(1, frames)
  // Normalised progress 0 -> 1 across the clip, as an ffmpeg expression fragment.
  const p = `(on/${n})`

  switch (style) {
    case 'zoom-in':
      return { z: `1+0.18*${p}`, x: CENTER_X, y: CENTER_Y }

    case 'zoom-out':
      return { z: `1.18-0.18*${p}`, x: CENTER_X, y: CENTER_Y }

    case 'ken-burns':
      return {
        z: `1+0.14*${p}`,
        x: `(iw-iw/zoom)*${p}`,
        y: `(ih-ih/zoom)*(1-${p})`
      }

    case 'pan-left':
      return {
        z: '1.12',
        x: `(iw-iw/zoom)*(1-${p})`,
        y: `(ih-ih/zoom)/2`
      }

    case 'pan-right':
      return {
        z: '1.12',
        x: `(iw-iw/zoom)*${p}`,
        y: `(ih-ih/zoom)/2`
      }

    case 'drift':
      return {
        z: '1.1',
        x: `(iw-iw/zoom)*${p}`,
        y: `(ih-ih/zoom)*${p}`
      }

    case 'parallax':
      return {
        z: `1.08+0.06*${p}`,
        x: `(iw-iw/zoom)*(1-${p})`,
        y: `(ih-ih/zoom)/2`
      }

    case 'cinematic-dolly':
      return {
        z: `1+0.1*${p}`,
        x: CENTER_X,
        y: `(ih-ih/zoom)*(0.5+0.1*sin(2*PI*${p}))`
      }

    case 'breathe':
      // A very small scale pulse. Deliberately almost invisible — this is the default.
      return {
        z: `1.04+0.02*sin(2*PI*${p})`,
        x: CENTER_X,
        y: CENTER_Y
      }

    case 'crash-zoom':
      // Fast at the start, easing out.
      return { z: `1+0.55*(1-pow(1-${p},3))`, x: CENTER_X, y: CENTER_Y }

    case 'bullet-time':
      return { z: `1+0.06*${p}`, x: CENTER_X, y: CENTER_Y }

    default:
      return { z: '1', x: CENTER_X, y: CENTER_Y }
  }
}

export interface BuildFilterOptions {
  style: string
  frames: number
  width: number
  height: number
  fps?: number
}

/**
 * The `-vf` chain for one clip: fit -> pad -> (optional) zoompan at the exact output size.
 *
 * Both dimensions must be even — x264 in yuv420p refuses odd sizes.
 */
export function buildVideoFilter(options: BuildFilterOptions): string {
  const { style, frames, width, height, fps = MOTION_FPS } = options
  const w = makeEven(width)
  const h = makeEven(height)

  // Fit inside the canvas without cropping, then pad the remainder. `setsar=1` stops
  // ffmpeg from inventing a sample aspect ratio that would stretch the frame later.
  const fit = [
    `scale=${makeEven(w * 2)}:${makeEven(h * 2)}:force_original_aspect_ratio=decrease`,
    `pad=${makeEven(w * 2)}:${makeEven(h * 2)}:(ow-iw)/2:(oh-ih)/2`,
    'setsar=1'
  ]

  if (style === 'none' || frames <= 1) {
    return [...fit.slice(0, 2), 'setsar=1', `scale=${w}:${h}`, `fps=${fps}`].join(',')
  }

  const { z, x, y } = expressions(style, frames)
  const zoompan = [
    `zoompan=z='${z}'`,
    `x='${x}'`,
    `y='${y}'`,
    'd=1',
    `s=${w}x${h}`,
    `fps=${fps}`
  ].join(':')

  return [...fit, zoompan].join(',')
}

export function makeEven(value: number): number {
  const rounded = Math.max(2, Math.round(value))
  return rounded % 2 === 0 ? rounded : rounded - 1
}

/**
 * Target render size for an orientation and quality tier.
 *
 * The tier names the *short* side, so 1080p is 1080x1920 in portrait and 1920x1080 in
 * landscape. Which axis that lands on follows from the aspect: portrait is taller than it
 * is wide, so the short side is the width; landscape is the other way round.
 */
export function targetSize(
  orientation: Orientation,
  shortSide: number
): { width: number; height: number } {
  const { w, h } = ORIENTATION_ASPECT[orientation]
  if (w < h) {
    return { width: makeEven(shortSide), height: makeEven((shortSide * h) / w) }
  }
  return { width: makeEven((shortSide * w) / h), height: makeEven(shortSide) }
}
