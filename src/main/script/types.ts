/**
 * Script import types.
 *
 * The shapes that cross IPC (`ParsedScene`, `ParsedScript`) live in `@shared/types` so the
 * renderer can use them too. This file re-exports those and adds the main-process-only
 * intermediate shape.
 */
export type { ParsedScene, ParsedScript } from '@shared/types'

/**
 * Intermediate shape every layout parser produces, before narration is distributed.
 *
 * `prompts` is what defines the scene count — narration is fitted to it afterwards.
 */
export interface RawParse {
  title: string
  /** One entry per scene. THIS list defines the scene count. */
  prompts: string[]
  /** Per-scene narration, only when the source already split it. */
  narrations?: string[]
  /** A single narration block to distribute across the scenes. */
  narrationBlob?: string
  moods?: string[]
  /**
   * Per-scene visual kind, parallel to `prompts`. A `'footage'` entry means stock video;
   * absent means the default (a generated image). Sparse by design — consumers read by
   * index and treat anything missing as the default.
   */
  visuals?: Array<'image' | 'footage' | undefined>
  thumbnailPrompt?: string
  layout: string
  warnings: string[]
}
