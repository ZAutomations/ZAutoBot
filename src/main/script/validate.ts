/**
 * Mode-aware script validation.
 *
 * A full video needs narration AND a prompt per scene; images mode only needs prompts;
 * audio mode only needs narration. Validating against the wrong mode is how a perfectly
 * good audio-only script gets rejected with a complaint about image prompts.
 *
 * Anything that is recoverable (skipped asset numbers, extra prompts) is a **warning**, so
 * the run continues and the user is told what happened.
 */
import type { JobMode } from '@shared/types'
import type { ParsedScript } from './types'

export interface ValidationResult {
  ok: boolean
  errors: string[]
  warnings: string[]
}

export function validateScript(script: ParsedScript, mode: JobMode): ValidationResult {
  const errors: string[] = []
  const warnings = [...script.warnings]

  const scenes = script.scenes ?? []
  if (!scenes.length) {
    errors.push('The script has no scenes.')
    return { ok: false, errors, warnings }
  }

  const needsNarration = mode === 'video' || mode === 'audio'
  const needsPrompt = mode === 'video' || mode === 'images'

  const missingNarration: number[] = []
  const missingPrompt: number[] = []

  for (const scene of scenes) {
    if (needsNarration && !scene.narration.trim()) missingNarration.push(scene.sceneNumber)
    if (needsPrompt && !scene.imagePrompt.trim()) missingPrompt.push(scene.sceneNumber)
  }

  if (missingNarration.length) {
    errors.push(
      `No narration for scene${missingNarration.length === 1 ? '' : 's'} ${summarize(missingNarration)}.`
    )
  }
  if (missingPrompt.length) {
    errors.push(
      `No image prompt for scene${missingPrompt.length === 1 ? '' : 's'} ${summarize(missingPrompt)}.`
    )
  }

  if (mode === 'video' && scenes.length > 1 && script.thumbnailPrompt === undefined) {
    warnings.push('No thumbnail prompt — the run will finish without a thumbnail.')
  }

  return { ok: errors.length === 0, errors, warnings }
}

/** `1, 2, 3 … 40` — never print a hundred numbers into a toast. */
function summarize(numbers: number[]): string {
  if (numbers.length <= 8) return numbers.join(', ')
  return `${numbers.slice(0, 8).join(', ')} … (${numbers.length} total)`
}
