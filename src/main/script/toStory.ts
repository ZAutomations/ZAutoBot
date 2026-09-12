/**
 * Turn an imported script into the `Story` the pipeline runs on.
 *
 * Durations here are word-count estimates only; the voice stage overwrites every one of
 * them with the measured audio length. They exist so the progress bar and the review screen
 * have something sensible to show before any audio exists.
 */
import type { ParsedScript, Scene, Story } from '@shared/types'
import { estimateDurationSeconds } from './narration'

/** Fallback for a scene with no narration at all — never ship a zero-length clip. */
const MIN_SCENE_SECONDS = 3

export function storyFromScript(script: ParsedScript): Story {
  const scenes: Scene[] = script.scenes.map((parsed, index) => ({
    // Scene numbers are usually 1-based from the source; fall back to position.
    sceneNumber: parsed.sceneNumber || index + 1,
    narration: parsed.narration,
    imagePrompt: parsed.imagePrompt,
    mood: parsed.mood,
    durationSeconds: estimateDurationSeconds(parsed.narration) || MIN_SCENE_SECONDS
  }))

  return {
    title: script.title,
    scenes,
    thumbnailPrompt: script.thumbnailPrompt
  }
}
