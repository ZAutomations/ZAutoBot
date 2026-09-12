/**
 * Subtitle generation (ASS / libass).
 *
 * Cues come from the engine's **word timings** when it has them (edge, ai33) — those give
 * exact, per-word sync. Otherwise they are estimated by distributing the scene's measured
 * duration across its words.
 *
 * Two absolute rules from the spec:
 *  - the caption canvas MUST equal the render size, or every overlay lands wrong;
 *  - the font scales with the frame (`size * shortSide / 1080`), or captions are visibly
 *    smaller at 2K than at 1080p.
 */
import type { WordTiming } from '@shared/types'
import { makeEven } from './motion'

export interface CaptionCue {
  text: string
  startMs: number
  endMs: number
}

const MAX_CUE_CHARS = 42
const MAX_CUE_WORDS = 8
const MAX_CUE_MS = 3200
/** A pause longer than this always breaks the cue. */
const GAP_BREAK_MS = 800
/** Never emit a cue shorter than this; a flash of text is worse than a slight overlap. */
const MIN_CUE_MS = 320

// ---------------------------------------------------------------------------
// Cues
// ---------------------------------------------------------------------------

export function cuesFromWords(words: WordTiming[]): CaptionCue[] {
  const cues: CaptionCue[] = []
  let current: WordTiming[] = []

  const flush = (): void => {
    if (!current.length) return
    const text = current.map((w) => w.text).join(' ').replace(/\s+/g, ' ').trim()
    if (text) {
      cues.push({
        text,
        startMs: current[0].startMs,
        endMs: Math.max(current[current.length - 1].endMs, current[0].startMs + MIN_CUE_MS)
      })
    }
    current = []
  }

  for (const word of words) {
    if (!word.text.trim()) continue

    if (current.length) {
      const previous = current[current.length - 1]
      const prospective = [...current.map((w) => w.text), word.text].join(' ')
      const tooLong = prospective.length > MAX_CUE_CHARS
      const tooManyWords = current.length >= MAX_CUE_WORDS
      const longPause = word.startMs - previous.endMs > GAP_BREAK_MS
      const tooLongInTime = word.endMs - current[0].startMs > MAX_CUE_MS
      if (tooLong || tooManyWords || longPause || tooLongInTime) flush()
    }

    current.push(word)
  }
  flush()

  return cues
}

/** Estimated cues, for engines that return no timings. */
export function cuesFromText(text: string, durationSeconds: number): CaptionCue[] {
  const words = text.split(/\s+/).filter(Boolean)
  if (!words.length || durationSeconds <= 0) return []

  // Group by the same limits the word-timing path uses.
  const groups: string[][] = []
  let current: string[] = []
  for (const word of words) {
    const prospective = [...current, word].join(' ')
    if (current.length && (prospective.length > MAX_CUE_CHARS || current.length >= MAX_CUE_WORDS)) {
      groups.push(current)
      current = []
    }
    current.push(word)
  }
  if (current.length) groups.push(current)

  const totalChars = groups.reduce((sum, g) => sum + g.join(' ').length, 0) || 1
  const totalMs = durationSeconds * 1000

  let cursor = 0
  return groups.map((group) => {
    const chars = group.join(' ').length
    const span = (chars / totalChars) * totalMs
    const startMs = cursor
    cursor += span
    return { text: group.join(' '), startMs, endMs: Math.max(cursor, startMs + MIN_CUE_MS) }
  })
}

export function buildCues(
  text: string,
  durationSeconds: number,
  words?: WordTiming[]
): CaptionCue[] {
  if (words && words.length) return cuesFromWords(words)
  return cuesFromText(text, durationSeconds)
}

// ---------------------------------------------------------------------------
// ASS
// ---------------------------------------------------------------------------

interface AssStylePreset {
  fontName: string
  /** Font size at a 1080px short side; scaled from there. */
  fontSizeAt1080: number
  bold: boolean
  primary: string
  outline: string
  back: string
  /** 1 = outline + shadow, 3 = opaque box. */
  borderStyle: 1 | 3
  outlineWidth: number
  shadow: number
  marginVAt1080: number
  alignment: number
}

/** ASS colours are `&HAABBGGRR` — alpha first, channels reversed. */
const ASS_STYLES: Record<string, AssStylePreset> = {
  'bottom-bar': {
    fontName: 'Arial',
    fontSizeAt1080: 56,
    bold: true,
    primary: '&H00FFFFFF',
    outline: '&H00000000',
    back: '&H99000000',
    borderStyle: 3,
    outlineWidth: 0,
    shadow: 0,
    marginVAt1080: 120,
    alignment: 2
  },
  'bold-outline': {
    fontName: 'Arial',
    fontSizeAt1080: 62,
    bold: true,
    primary: '&H00FFFFFF',
    outline: '&H00000000',
    back: '&H00000000',
    borderStyle: 1,
    outlineWidth: 4,
    shadow: 2,
    marginVAt1080: 130,
    alignment: 2
  },
  neon: {
    fontName: 'Arial',
    fontSizeAt1080: 60,
    bold: true,
    primary: '&H00FFFFFF',
    outline: '&H004264C9', // the app accent, as a glow
    back: '&H00000000',
    borderStyle: 1,
    outlineWidth: 3,
    shadow: 0,
    marginVAt1080: 130,
    alignment: 2
  },
  glass: {
    fontName: 'Arial',
    fontSizeAt1080: 54,
    bold: false,
    primary: '&H00FFFFFF',
    outline: '&H40FFFFFF',
    back: '&H80000000',
    borderStyle: 3,
    outlineWidth: 0,
    shadow: 0,
    marginVAt1080: 120,
    alignment: 2
  },
  minimal: {
    fontName: 'Arial',
    fontSizeAt1080: 44,
    bold: false,
    primary: '&H00FFFFFF',
    outline: '&H00000000',
    back: '&H00000000',
    borderStyle: 1,
    outlineWidth: 2,
    shadow: 0,
    marginVAt1080: 90,
    alignment: 2
  }
}

function assTime(ms: number): string {
  const total = Math.max(0, Math.round(ms))
  const centis = Math.floor((total % 1000) / 10)
  const seconds = Math.floor(total / 1000) % 60
  const minutes = Math.floor(total / 60_000) % 60
  const hours = Math.floor(total / 3_600_000)
  return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(
    centis
  ).padStart(2, '0')}`
}

function escapeAssText(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/\{/g, '(').replace(/\}/g, ')').replace(/\r?\n/g, '\\N')
}

export interface BuildAssOptions {
  width: number
  height: number
  style: string
}

/**
 * Render a complete .ass file. `width`/`height` are the render size, and the short side
 * drives font scaling so captions keep their proportion between 1080p and 2K.
 */
export function buildAss(cues: CaptionCue[], options: BuildAssOptions): string {
  const width = makeEven(options.width)
  const height = makeEven(options.height)
  const shortSide = Math.min(width, height)
  const scale = shortSide / 1080

  const preset = ASS_STYLES[options.style] ?? ASS_STYLES['bottom-bar']
  const fontSize = Math.round(preset.fontSizeAt1080 * scale)
  const marginV = Math.round(preset.marginVAt1080 * scale)

  const header = [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${width}`,
    `PlayResY: ${height}`,
    'WrapStyle: 2',
    'ScaledBorderAndShadow: yes',
    'YCbCr Matrix: TV.709',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    [
      'Style: Default',
      preset.fontName,
      fontSize,
      preset.primary,
      preset.primary,
      preset.outline,
      preset.back,
      preset.bold ? -1 : 0,
      0,
      0,
      0,
      100,
      100,
      0,
      0,
      preset.borderStyle,
      preset.outlineWidth,
      preset.shadow,
      preset.alignment,
      Math.round(width * 0.05),
      Math.round(width * 0.05),
      marginV,
      1
    ].join(','),
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text'
  ]

  const events = cues.map((cue) => {
    const text = escapeAssText(cue.text)
    return `Dialogue: 0,${assTime(cue.startMs)},${assTime(cue.endMs)},Default,,0,0,0,,${text}`
  })

  return [...header, ...events, ''].join('\n')
}

/**
 * libass positions every cue from its own timestamps, so cues for a concatenated video
 * must be shifted by each scene's start offset first.
 */
export function shiftCues(cues: CaptionCue[], offsetMs: number): CaptionCue[] {
  return cues.map((cue) => ({
    ...cue,
    startMs: cue.startMs + offsetMs,
    endMs: cue.endMs + offsetMs
  }))
}
