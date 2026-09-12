/**
 * One footage scene, start to finish: search, pick, download.
 *
 * Retries walk down the search results rather than repeating the same one — a clip that
 * failed to download will fail the same way twice, but the next result is a different file
 * on a different CDN path. When the results run out, the scene fails and the pipeline's
 * normal fallback story applies (image generation, then nearest-neighbour fill-in) — stock
 * footage is an enhancement, never a hard dependency of a run.
 */
import type { AppSettings } from '@shared/types'
import type { Orientation } from '@shared/types'
import {
  downloadVideoFile,
  pickVideoFile,
  searchFootage,
  PexelsError,
  type PexelsVideo
} from './pexels'

export interface FootageOptions {
  /** Search terms — the scene's imagePrompt when the script used a Footage line. */
  query: string
  outputPath: string
  /** Rendition selection: the smallest file that still covers this canvas. */
  targetHeight: number
  orientation: Orientation
  isCancelled?: () => boolean
}

/** How many search results one scene may burn before it is someone else's problem. */
const MAX_RESULTS_PER_SCENE = 3

export async function generateSceneFootage(
  options: FootageOptions,
  settings: AppSettings
): Promise<string> {
  const apiKey = (settings.pexelsApiKey ?? '').trim()
  if (!apiKey) {
    throw new PexelsError('No Pexels API key — add one in Settings to use footage scenes.')
  }

  const query = options.query.trim()
  if (!query) {
    throw new PexelsError('The footage scene has no search terms.')
  }

  const cancelled = options.isCancelled
  const orientation = options.orientation === 'long' ? 'landscape' : 'portrait'

  let videos: PexelsVideo[]
  try {
    videos = await searchFootage({
      query,
      apiKey,
      orientation,
      signal: AbortSignal.timeout(20_000)
    })
  } catch (err) {
    if (cancelled?.()) throw new Error('Cancelled (waiting for Pexels search).')
    throw err
  }

  if (cancelled?.()) throw new Error('Cancelled (after the Pexels search).')

  if (!videos.length) {
    throw new PexelsError(`No Pexels footage matched "${query}".`)
  }

  const failures: string[] = []

  for (const video of videos.slice(0, MAX_RESULTS_PER_SCENE)) {
    if (cancelled?.()) throw new Error('Cancelled (downloading footage).')

    const file = pickVideoFile(video, options.targetHeight)
    if (!file) {
      failures.push(`clip ${video.id}: no downloadable video file`)
      continue
    }

    try {
      await downloadVideoFile(file, options.outputPath, downloadSignal(cancelled))
      return options.outputPath
    } catch (err) {
      if (cancelled?.()) throw new Error('Cancelled (downloading footage).')
      failures.push(`clip ${video.id}: ${(err as Error).message}`)
    }
  }

  throw new PexelsError(
    `Every matching clip failed to download for "${query}" (${failures.join('; ')}).`
  )
}

/** An AbortSignal that trips when the run is cancelled, so long downloads stop mid-file. */
function downloadSignal(cancelled?: () => boolean): AbortSignal | undefined {
  if (!cancelled) return undefined
  const controller = new AbortController()
  const timer = setInterval(() => {
    if (cancelled()) {
      controller.abort()
      clearInterval(timer)
    }
  }, 500)
  // If the caller's promise settles without the signal ever mattering, nothing else will
  // clear the interval — abort-time does it, but a signal that is never aborted would poll
  // forever. Tied to the signal: abort clears it, and a fresh download makes a new one.
  controller.signal.addEventListener('abort', () => clearInterval(timer))
  return controller.signal
}
