/**
 * ffprobe wrapper.
 *
 * Two things every caller needs and the spec makes load-bearing:
 *  - the **measured** duration of synthesized audio, which overwrites the word-count
 *    estimate on the scene;
 *  - the true dimensions, before anything decides how to scale or pad.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { binaries } from './binaries'

const execFileAsync = promisify(execFile)

export interface ProbeResult {
  width: number
  height: number
  durationSeconds: number
  hasAudio: boolean
  hasVideo: boolean
}

interface FfprobeStream {
  codec_type?: string
  width?: number
  height?: number
}

interface FfprobeOutput {
  format?: { duration?: string }
  streams?: FfprobeStream[]
}

export async function probe(file: string, timeoutMs = 30_000): Promise<ProbeResult> {
  const { ffprobe } = binaries()

  const { stdout } = await execFileAsync(
    ffprobe,
    [
      '-v',
      'error',
      '-print_format',
      'json',
      '-show_format',
      '-show_streams',
      file
    ],
    { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, windowsHide: true }
  )

  const data = JSON.parse(stdout) as FfprobeOutput
  const streams = data.streams ?? []
  const video = streams.find((s) => s.codec_type === 'video')
  const audio = streams.find((s) => s.codec_type === 'audio')

  return {
    width: video?.width ?? 0,
    height: video?.height ?? 0,
    durationSeconds: Number(data.format?.duration ?? 0) || 0,
    hasAudio: Boolean(audio),
    hasVideo: Boolean(video)
  }
}

/**
 * Duration only. Returns 0 rather than throwing when the file is unreadable — an
 * unmeasurable voice must cost the run its exactness, never the run itself.
 */
export async function probeDuration(file: string, timeoutMs = 30_000): Promise<number> {
  try {
    const result = await probe(file, timeoutMs)
    return result.durationSeconds
  } catch (err) {
    console.warn(`[ffprobe] could not measure ${file}:`, (err as Error).message)
    return 0
  }
}
