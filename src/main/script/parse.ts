/**
 * Script import — deterministic, no AI.
 *
 * The user's words pass through untouched. Every layout parser produces the same
 * `RawParse` intermediate, and `assemble()` applies the two rules that matter:
 *
 *  - **the scene count comes from the image prompts**, and
 *  - narration that was not pre-split gets distributed across those scenes.
 *
 * Supported layouts: marked single file, asset-block prompt files, separate files, JSON.
 * A sectioned "AI package" and the line-number AI re-read are follow-ups.
 */
import { distributeNarration } from './narration'
import type { ParsedScene, ParsedScript, RawParse } from './types'

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const str = (value: unknown): string => {
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'number') return String(value)
  return ''
}

function normalizeLabel(raw: string): string {
  return raw.toLowerCase().replace(/[*_#]/g, '').replace(/\s+/g, ' ').trim()
}

const NARRATION_LABELS = new Set([
  'narration',
  'voiceover',
  'voice over',
  'vo',
  'script',
  'text',
  'spoken',
  'speech',
  'dialog',
  'dialogue',
  'line',
  'lines'
])

const IMAGE_LABELS = new Set([
  'image',
  'image prompt',
  'img',
  'prompt',
  'visual',
  'picture',
  'pic',
  'photo',
  'shot',
  'frame',
  'b-roll',
  'broll'
])

/**
 * Labels that mean this scene is stock footage, not a generated image. The line's value is
 * search terms ("aerial city traffic"), and the scene keeps its slot in the count — the
 * pipeline downloads a clip instead of generating a picture for it.
 */
const FOOTAGE_LABELS = new Set([
  'footage',
  'footage prompt',
  'stock',
  'stock footage',
  'stock video',
  'video',
  'video clip',
  'clip'
])

const MOOD_LABELS = new Set(['mood', 'tone', 'style', 'vibe', 'atmosphere', 'emotion'])
const TITLE_LABELS = new Set(['title', 'video title', 'name', 'subject'])
const THUMBNAIL_LABELS = new Set([
  'thumbnail',
  'thumb',
  'cover',
  'thumbnail prompt',
  'thumbnail image'
])

// ---------------------------------------------------------------------------
// assemble
// ---------------------------------------------------------------------------

function assemble(raw: RawParse): ParsedScript {
  const warnings = [...raw.warnings]

  const sceneCount = Math.max(raw.prompts.length, raw.narrations?.length ?? 0)
  if (sceneCount === 0) {
    throw new Error('No scenes found — the script has no image prompts or narration.')
  }

  let narrations: string[]

  const perSceneNarration = raw.narrations?.filter((n) => n.trim()).length ?? 0
  if (perSceneNarration === sceneCount) {
    // Already split per scene — use it verbatim.
    narrations = raw.narrations as string[]
  } else if (raw.narrationBlob?.trim()) {
    narrations = distributeNarration(raw.narrationBlob, sceneCount)
    warnings.push(
      `Narration was not split per scene — divided across ${sceneCount} scenes automatically.`
    )
  } else if (raw.narrations?.length) {
    narrations = raw.narrations
  } else {
    narrations = Array.from({ length: sceneCount }, () => '')
  }

  const scenes: ParsedScene[] = []
  for (let index = 0; index < sceneCount; index++) {
    const visual = raw.visuals?.[index]
    scenes.push({
      sceneNumber: index + 1,
      narration: (narrations[index] ?? '').trim(),
      imagePrompt: (raw.prompts[index] ?? '').trim(),
      mood: (raw.moods?.[index] ?? '').trim(),
      visual: visual === 'footage' ? 'footage' : undefined
    })
  }

  return {
    title: raw.title.trim() || 'Untitled video',
    scenes,
    thumbnailPrompt: raw.thumbnailPrompt?.trim() || undefined,
    layout: raw.layout,
    warnings
  }
}

// ---------------------------------------------------------------------------
// Layout: JSON
// ---------------------------------------------------------------------------

function parseJson(text: string): RawParse | null {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    return null
  }
  if (!data || typeof data !== 'object') return null

  const obj = data as Record<string, unknown>
  const rawScenes = Array.isArray(obj.scenes)
    ? obj.scenes
    : Array.isArray(data)
      ? (data as unknown[])
      : null
  if (!rawScenes) return null

  const prompts: string[] = []
  const narrations: string[] = []
  const moods: string[] = []
  const visuals: Array<'image' | 'footage' | undefined> = []

  for (const entry of rawScenes) {
    if (typeof entry === 'string') {
      prompts.push('')
      narrations.push(entry.trim())
      moods.push('')
      visuals.push(undefined)
      continue
    }
    const scene = (entry ?? {}) as Record<string, unknown>
    // `"visual": "footage"` is a *kind*, not a prompt — the search terms live in a
    // footage-named field. Anything else in `visual` stays a prompt, as before.
    if (str(scene.visual).toLowerCase() === 'footage') {
      visuals.push('footage')
      prompts.push(str(scene.footagePrompt ?? scene.footage ?? scene.stock ?? scene.clip))
    } else {
      visuals.push(undefined)
      prompts.push(
        str(scene.imagePrompt ?? scene.image_prompt ?? scene.prompt ?? scene.image ?? scene.visual)
      )
    }
    narrations.push(
      str(scene.narration ?? scene.text ?? scene.script ?? scene.voiceover ?? scene.vo)
    )
    moods.push(str(scene.mood ?? scene.tone ?? scene.style))
  }

  return {
    title: str(obj.title ?? obj.name),
    prompts,
    narrations,
    moods,
    visuals: visuals.some((v) => v === 'footage') ? visuals : undefined,
    thumbnailPrompt: str(obj.thumbnailPrompt ?? obj.thumbnail_prompt ?? obj.thumbnail) || undefined,
    layout: 'json',
    warnings: []
  }
}

// ---------------------------------------------------------------------------
// Layout: marked single file
// ---------------------------------------------------------------------------

const WORD_SCENE_MARKER =
  /^\s*#{0,6}\s*(?:\*\*|__)?\s*(SCENE|SHOT|PART|SECTION)\s*#?\s*(\d+)\s*(?:\*\*|__)?\s*[:\-–—.]?\s*(.*)$/i

/** A line that is nothing but a number — only used when no word marker exists. */
const BARE_NUMBER_MARKER = /^\s*#{0,6}\s*(?:\*\*|__)?\s*(\d{1,3})\s*(?:\*\*|__)?\s*[.)\-:]?\s*$/

const LABEL_LINE = /^\s*(?:\*\*|__)?\s*([A-Za-z][A-Za-z /&]{0,28}?)\s*(?:\*\*|__)?\s*:\s*(.*)$/

interface SceneAccumulator {
  narration: string[]
  image: string[]
  mood: string[]
  /** Set when any label in this scene named stock footage rather than a generated image. */
  footage?: boolean
}

function markerRest(line: string, hasWordMarker: boolean): string | undefined {
  if (hasWordMarker) {
    const match = WORD_SCENE_MARKER.exec(line)
    return match ? match[3].trim() : undefined
  }
  const match = BARE_NUMBER_MARKER.exec(line)
  return match ? '' : undefined
}

function parseMarked(text: string): RawParse | null {
  const lines = text.split(/\r?\n/)
  const hasWordMarker = lines.some((line) => WORD_SCENE_MARKER.test(line))

  const accumulators: SceneAccumulator[] = []
  let current: SceneAccumulator | null = null
  let field: keyof SceneAccumulator = 'narration'
  let title = ''
  let thumbnailPrompt = ''
  let markersFound = 0
  let imageLabelsFound = 0

  const ensure = (): SceneAccumulator => {
    if (!current) {
      current = { narration: [], image: [], mood: [] }
      accumulators.push(current)
    }
    return current
  }

  for (const line of lines) {
    const rest = markerRest(line, hasWordMarker)
    if (rest !== undefined) {
      markersFound++
      current = { narration: [], image: [], mood: [] }
      accumulators.push(current)
      // Plain text following a marker is narration until a label says otherwise.
      field = 'narration'
      if (rest) current.narration.push(rest)
      continue
    }

    const labelMatch = LABEL_LINE.exec(line)
    if (labelMatch) {
      const label = normalizeLabel(labelMatch[1])
      const value = labelMatch[2].trim()

      if (TITLE_LABELS.has(label)) {
        if (value) title = value
        continue
      }
      if (THUMBNAIL_LABELS.has(label)) {
        if (value) thumbnailPrompt = value
        field = 'narration'
        continue
      }
      if (NARRATION_LABELS.has(label)) {
        if (value) ensure().narration.push(value)
        field = 'narration'
        continue
      }
      if (IMAGE_LABELS.has(label)) {
        imageLabelsFound++
        if (value) ensure().image.push(value)
        field = 'image'
        continue
      }
      if (FOOTAGE_LABELS.has(label)) {
        imageLabelsFound++
        const scene = ensure()
        if (value) scene.image.push(value)
        scene.footage = true
        field = 'image'
        continue
      }
      if (MOOD_LABELS.has(label)) {
        if (value) ensure().mood.push(value)
        field = 'mood'
        continue
      }
      // Not a known label — it is content, fall through.
    }

    if (!line.trim()) continue
    if (line.trim().startsWith('#')) continue // a stray heading is not narration

    ensure()[field].push(line.trim())
  }

  // A file with neither scene markers nor image labels is not this layout.
  if (!markersFound && !imageLabelsFound) return null

  const prompts = accumulators.map((acc) => acc.image.join(' ').trim())
  const narrations = accumulators.map((acc) => acc.narration.join(' ').trim())
  const moods = accumulators.map((acc) => acc.mood.join(' ').trim())
  const visuals = accumulators.map((acc) => (acc.footage ? 'footage' : undefined))
  const anyFootage = visuals.some((v) => v === 'footage')

  return {
    title,
    prompts,
    narrations,
    moods,
    visuals: anyFootage ? visuals : undefined,
    thumbnailPrompt: thumbnailPrompt || undefined,
    layout: markersFound ? 'marked scenes' : 'labelled blocks',
    warnings: []
  }
}

// ---------------------------------------------------------------------------
// Layout: asset-block prompt files
// ---------------------------------------------------------------------------

const ASSET_HEADER =
  /^\s*#{0,6}\s*(?:\*\*|__)?\s*(ASSET|IMG|IMAGE|PROMPT|VISUAL|PIC|PICTURE|PANEL|FOOTAGE|STOCK)\s*#?\s*(\d+)\s*(.*)$/i

const RULE_LINE = /^\s*[-=_*~]{3,}\s*$/

const SECTION_HEADER =
  /^\s*#{0,6}\s*(?:\*\*|__)?\s*(BONUS|APPENDIX|EXTRA|CREDITS|OUTRO|THUMBNAIL|THUMB|COVER)\b\s*(.*)$/i

/**
 * A header remainder is either a slug (ignored) or an inline prompt.
 * Slugs are single tokens (`ocean_waves_intro`); anything with a space is a prompt.
 */
function headerRemainderIsPrompt(rest: string): string | null {
  const trimmed = rest.trim()
  if (!trimmed) return null
  // A metadata row — timings, "character", "bg …" — is never part of the prompt.
  if (trimmed.startsWith('|') || trimmed.startsWith(',')) return null
  const looksLikeSlug = !/\s/.test(trimmed) && trimmed.length <= 40
  return looksLikeSlug ? null : trimmed
}

function parseAssetBlocks(text: string): RawParse | null {
  const lines = text.split(/\r?\n/)

  const prompts: string[] = []
  const visuals: Array<'image' | 'footage' | undefined> = []
  let buffer: string[] | null = null
  let section: 'prompts' | 'thumbnail' | 'appendix' = 'prompts'
  let thumbnailBuffer: string[] = []
  let numbers: number[] = []

  const flush = (): void => {
    if (buffer) {
      prompts.push(buffer.join(' ').replace(/\s+/g, ' ').trim())
      buffer = null
    }
  }

  for (const line of lines) {
    if (RULE_LINE.test(line)) continue

    const sectionMatch = SECTION_HEADER.exec(line)
    if (sectionMatch) {
      const name = sectionMatch[1].toUpperCase()
      flush()
      if (name === 'THUMBNAIL' || name === 'THUMB' || name === 'COVER') {
        section = 'thumbnail'
        const inline = sectionMatch[2].trim()
        if (inline) thumbnailBuffer.push(inline)
      } else {
        section = 'appendix'
      }
      continue
    }

    const assetMatch = ASSET_HEADER.exec(line)
    if (assetMatch) {
      flush()
      section = 'prompts'
      numbers.push(Number(assetMatch[2]))
      visuals.push(/^(FOOTAGE|STOCK)$/i.test(assetMatch[1]) ? 'footage' : undefined)
      const inline = headerRemainderIsPrompt(assetMatch[3])
      buffer = inline ? [inline] : []
      continue
    }

    if (section === 'thumbnail') {
      if (line.trim()) thumbnailBuffer.push(line.trim())
      continue
    }
    if (section === 'appendix') continue

    if (buffer) {
      if (line.trim()) buffer.push(line.trim())
    } else if (line.trim()) {
      // Text before the first header — treat as a title line.
      continue
    }
  }
  flush()

  if (!numbers.length) return null

  const warnings: string[] = []
  const highest = Math.max(...numbers)
  const skipped = highest - numbers.length
  if (skipped > 0) {
    warnings.push(
      `Prompt numbers skip ${skipped} value${skipped === 1 ? '' : 's'} (highest is ${highest}, ${numbers.length} prompts found) — the skipped scenes reuse the nearest generated image.`
    )
  }

  const emptyPrompts = prompts.filter((p) => !p).length
  if (emptyPrompts) {
    warnings.push(`${emptyPrompts} prompt block(s) had no text under their header.`)
  }

  return {
    title: '',
    prompts,
    narrationBlob: undefined,
    visuals: visuals.some((v) => v === 'footage') ? visuals : undefined,
    thumbnailPrompt: thumbnailBuffer.join(' ').trim() || undefined,
    layout: 'asset blocks',
    warnings
  }
}

// ---------------------------------------------------------------------------
// Layout: separate files
// ---------------------------------------------------------------------------

function splitPromptBlocks(text: string): string[] {
  return text
    .split(/\r?\n\s*\r?\n/)
    .map((block) => block.trim())
    .filter((block) => block && !RULE_LINE.test(block))
}

export function parseSeparateFiles(input: {
  narration: string
  prompts?: string
  thumbnail?: string
  title?: string
}): ParsedScript {
  const narration = input.narration ?? ''
  const promptsText = (input.prompts ?? '').trim()

  // A prompts file that uses headers should be read as asset blocks.
  if (promptsText && ASSET_HEADER.test(promptsText)) {
    const raw = parseAssetBlocks(promptsText)
    if (raw) {
      raw.narrationBlob = narration
      raw.title = input.title ?? raw.title
      if (input.thumbnail?.trim()) raw.thumbnailPrompt = input.thumbnail.trim()
      return assemble(raw)
    }
  }

  const prompts = promptsText ? splitPromptBlocks(promptsText) : []

  if (prompts.length) {
    const raw: RawParse = {
      title: input.title ?? '',
      prompts,
      narrationBlob: narration,
      thumbnailPrompt: input.thumbnail?.trim() || undefined,
      layout: 'separate files',
      warnings: []
    }
    return assemble(raw)
  }

  // No prompts — the narration's own paragraphs define the scenes (audio-only work).
  const paragraphs = narration
    .split(/\r?\n\s*\r?\n/)
    .map((p) => p.trim())
    .filter(Boolean)

  if (!paragraphs.length) {
    throw new Error('Nothing to import — the narration file is empty.')
  }

  return assemble({
    title: input.title ?? '',
    prompts: paragraphs.map(() => ''),
    narrations: paragraphs,
    thumbnailPrompt: input.thumbnail?.trim() || undefined,
    layout: 'separate files (narration only)',
    warnings: [
      'No image prompts were supplied — scenes come from the narration paragraphs.'
    ]
  })
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

export function parseScriptText(text: string, filename?: string): ParsedScript {
  const trimmed = text.trim()
  if (!trimmed) throw new Error('The file is empty.')

  const looksLikeJson = trimmed.startsWith('{') || trimmed.startsWith('[')
  if (looksLikeJson) {
    const json = parseJson(trimmed)
    if (json) return assemble(json)
    // Fall through: a script that merely starts with a brace is still a script.
  }

  const marked = parseMarked(text)
  if (marked && marked.prompts.some((p) => p)) return assemble(marked)

  const assets = parseAssetBlocks(text)
  if (assets && assets.prompts.some((p) => p)) return assemble(assets)

  // Marked with narration only (no prompts) is still valid for audio mode.
  if (marked) return assemble(marked)

  throw new Error(
    `Could not find scenes in ${filename ?? 'the script'}. Expected scene markers ` +
      '(SCENE 1 / SHOT 1), IMAGE: labels, or numbered prompt blocks.'
  )
}
