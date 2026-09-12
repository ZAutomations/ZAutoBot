/**
 * Narration distribution.
 *
 * When narration is not already split per scene, it has to be divided to match the scene
 * count that the image prompts define. The rules here are the owner's:
 *
 *  - sentence-based first, merging the **smallest adjacent pairs** until the counts match
 *    (that is what a writer does by hand);
 *  - only then fall back to **even word counts**.
 *
 * A comma-based splitter was tried once and reverted: pause-based cuts produce wildly
 * uneven chunks, and a two-word scene is a one-second image flash.
 */
import { ESTIMATED_WORDS_PER_MINUTE } from '@shared/constants'

/** Splits on terminal punctuation, keeping the punctuation with its sentence. */
export function splitSentences(text: string): string[] {
  const matches = text.match(/[^.!?]+[.!?]+["')\]]*|[^.!?]+$/g)
  if (!matches) return []
  return matches.map((s) => s.trim()).filter(Boolean)
}

/** Word-count duration estimate, used until the real audio is measured. */
export function estimateDurationSeconds(text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length
  if (!words) return 0
  return (words / ESTIMATED_WORDS_PER_MINUTE) * 60
}

function splitByEvenWords(text: string, parts: number): string[] {
  const words = text.trim().split(/\s+/).filter(Boolean)
  if (!words.length) return Array.from({ length: parts }, () => '')

  const per = words.length / parts
  const out: string[] = []
  for (let i = 0; i < parts; i++) {
    const start = Math.round(i * per)
    const end = Math.round((i + 1) * per)
    out.push(words.slice(start, end).join(' '))
  }
  return out
}

function mergeSmallestPairs(sentences: string[], target: number): string[] {
  const groups: string[][] = sentences.map((s) => [s])

  while (groups.length > target) {
    let bestIndex = 0
    let bestLength = Number.POSITIVE_INFINITY

    for (let i = 0; i < groups.length - 1; i++) {
      const combined = groups[i].join(' ').length + groups[i + 1].join(' ').length
      if (combined < bestLength) {
        bestLength = combined
        bestIndex = i
      }
    }

    groups[bestIndex] = [...groups[bestIndex], ...groups[bestIndex + 1]]
    groups.splice(bestIndex + 1, 1)
  }

  return groups.map((group) => group.join(' ').trim())
}

export function distributeNarration(text: string, sceneCount: number): string[] {
  const clean = text.trim()
  if (sceneCount <= 0) return []
  if (!clean) return Array.from({ length: sceneCount }, () => '')
  if (sceneCount === 1) return [clean]

  const sentences = splitSentences(clean)

  if (sentences.length >= sceneCount) {
    return mergeSmallestPairs(sentences, sceneCount)
  }

  // Fewer sentences than scenes — split by even word counts so every scene gets a
  // comparable slice of the runtime.
  return splitByEvenWords(clean, sceneCount)
}
