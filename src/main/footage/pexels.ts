/**
 * Pexels stock footage, for scenes the script marked as `Footage:`.
 *
 * Pexels is the one stock API that is both free and permissive: an ordinary API key,
 * generous hourly limits, direct download links on the video files themselves (no
 * per-download auth), and a license that allows commercial use with no attribution —
 * which is what a monetized YouTube channel needs. Scenes are the unit of work, so the
 * 200-requests-an-hour budget is never under pressure: one search covers one scene.
 *
 * Nothing here knows about scenes or the pipeline. It searches, picks a file, downloads.
 * Choosing the clip is deliberately boring: the first search result whose height covers
 * the target canvas. Search relevance on Pexels is good enough that "top result" is the
 * right default, and a re-roll (ask for result #2) can come later without touching this
 * file's contract.
 */
import { createWriteStream } from 'node:fs'
import { rename, rm } from 'node:fs/promises'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'

const SEARCH_URL = 'https://api.pexels.com/videos/search'

/** One downloadable rendition of a clip. */
interface PexelsVideoFile {
  link: string
  quality?: string
  width?: number
  height?: number
  file_type?: string
}

/** One search result. */
export interface PexelsVideo {
  id: number
  duration: number
  image?: string
  video_files: PexelsVideoFile[]
}

interface SearchResponse {
  videos?: PexelsVideo[]
}

export class PexelsError extends Error {}

/** Search terms become a query string; orientation keeps the aspect ratio honest. */
export async function searchFootage(options: {
  query: string
  apiKey: string
  orientation: 'portrait' | 'landscape'
  perPage?: number
  signal?: AbortSignal
}): Promise<PexelsVideo[]> {
  const params = new URLSearchParams({
    query: options.query,
    orientation: options.orientation,
    per_page: String(options.perPage ?? 10)
  })

  let response: Response
  try {
    response = await fetch(`${SEARCH_URL}?${params}`, {
      headers: { Authorization: options.apiKey },
      signal: options.signal
    })
  } catch (err) {
    throw new PexelsError(`Pexels search failed: ${(err as Error).message}`)
  }

  if (response.status === 401 || response.status === 403) {
    throw new PexelsError('Pexels rejected the API key — check it in Settings.')
  }
  if (response.status === 429) {
    throw new PexelsError('Pexels rate limit reached — wait a minute and run again.')
  }
  if (!response.ok) {
    throw new PexelsError(`Pexels search failed (HTTP ${response.status}).`)
  }

  const data = (await response.json()) as SearchResponse
  return data.videos ?? []
}

/**
 * The file to download for one clip: the smallest rendition that still covers the target
 * canvas, so a 1080p video never downloads a 4K file it will only downscale.
 *
 * Falls back to the largest available when nothing covers — a soft clip is better than no
 * clip, and the renderer scales whatever it gets.
 */
export function pickVideoFile(video: PexelsVideo, targetHeight: number): PexelsVideoFile | null {
  const files = video.video_files.filter(
    (file) => file.link && file.file_type !== 'video/HLS' && !file.link.includes('m3u8')
  )
  if (!files.length) return null

  const covering = files
    .filter((file) => (file.height ?? 0) >= targetHeight)
    .sort((a, b) => (a.height ?? 0) - (b.height ?? 0))
  if (covering.length) return covering[0]

  return files.sort((a, b) => (b.height ?? 0) - (a.height ?? 0))[0]
}

/** Download a rendition to `outputPath`. The link itself needs no authentication. */
export async function downloadVideoFile(
  file: PexelsVideoFile,
  outputPath: string,
  signal?: AbortSignal
): Promise<void> {
  const tempPath = `${outputPath}.part`

  try {
    const response = await fetch(file.link, { signal })
    if (!response.ok || !response.body) {
      throw new PexelsError(`Download failed (HTTP ${response.status}).`)
    }

    // Stream to disk: footage renditions are tens of megabytes, and buffering one in
    // memory per concurrent scene is exactly the kind of spike that gets a tool killed.
    await pipeline(Readable.fromWeb(response.body as never), createWriteStream(tempPath))
    await rename(tempPath, outputPath)
  } catch (err) {
    await rm(tempPath, { force: true }).catch(() => undefined)
    throw err
  }
}
