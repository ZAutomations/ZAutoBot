/**
 * Rendering: one clip per scene, a concat pass, then the final graded export.
 *
 * Splitting it this way means a single bad scene can be re-rendered on its own, and the
 * expensive final pass (subtitles + music + loudness) runs once over the whole timeline.
 */
import { promises as fs } from 'node:fs'
import { dirname } from 'node:path'
import { LOUDNESS } from '@shared/constants'
import { escapeFilterPath, runFfmpeg } from './ffmpeg'
import { buildVideoFilter, MOTION_FPS } from './motion'

/** Extra video after the audio ends so a tail syllable is never clipped mid-word. */
export const TAIL_PADDING_SECONDS = 0.3

export interface RenderClipOptions {
  imagePath: string
  audioPath?: string
  durationSeconds: number
  /** Resolved motion style — `none` renders a still frame. Ignored for footage. */
  style: string
  width: number
  height: number
  outputPath: string
  /**
   * `footage` means `imagePath` is a downloaded stock video, not a picture: it is trimmed
   * or looped to the narration length and fitted with scale+crop instead of animated with
   * zoompan — real footage already has motion, and zoompan on video looks like a mistake.
   */
  inputKind?: 'image' | 'footage'
  isCancelled?: () => boolean
  onProgress?: (fraction: number) => void
  /** Per-attempt watchdog. The third attempt uses the spec's 8-minute ceiling. */
  timeoutMs?: number
}

export async function renderClip(options: RenderClipOptions): Promise<void> {
  const {
    imagePath,
    audioPath,
    durationSeconds,
    style,
    width,
    height,
    outputPath,
    inputKind,
    isCancelled,
    onProgress,
    timeoutMs
  } = options

  if (inputKind === 'footage') {
    return renderFootageClip(options)
  }

  const frames = Math.max(1, Math.ceil((durationSeconds + TAIL_PADDING_SECONDS) * MOTION_FPS))
  const filter = buildVideoFilter({ style, frames, width, height })

  const args: string[] = [
    '-y',
    '-loop',
    '1',
    '-framerate',
    String(MOTION_FPS),
    '-i',
    imagePath
  ]

  if (audioPath) args.push('-i', audioPath)

  args.push(
    '-vf',
    filter,
    '-frames:v',
    String(frames),
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    '20',
    '-pix_fmt',
    'yuv420p'
  )

  if (audioPath) {
    args.push('-c:a', 'aac', '-b:a', '192k', '-shortest')
  } else {
    args.push('-an')
  }

  args.push('-movflags', '+faststart', outputPath)

  await fs.mkdir(dirname(outputPath), { recursive: true })

  await runFfmpeg({
    args,
    totalDurationSeconds: durationSeconds + TAIL_PADDING_SECONDS,
    onProgress: onProgress ? (info) => onProgress(info.fraction) : undefined,
    isCancelled,
    timeoutMs,
    label: `clip ${outputPath.split(/[\\/]/).pop()}`
  })
}

/**
 * Render a stock-footage scene: the video is the visual, so there is no zoompan — the work
 * is making an arbitrary internet clip land on the same timeline contract every other clip
 * obeys: exactly `duration + tail` seconds, `width×height`, 30fps, yuv420p, h264.
 *
 * A clip shorter than the narration loops from the start (`-stream_loop -1`); a longer one
 * is cut at the timeline length. `-shortest` with the audio present keeps the end tight:
 * the loop makes video effectively endless, so audio ends the clip. Without audio the
 * explicit `-t` is the only bound, which is why it is always present.
 *
 * Scale-then-crop (not pad): stock footage is real cinematography, and letterboxing it
 * inside a generated-image frame would look like a slideshow, not a video.
 */
async function renderFootageClip(options: RenderClipOptions): Promise<void> {
  const { imagePath, audioPath, durationSeconds, width, height, outputPath, isCancelled, onProgress, timeoutMs } =
    options

  const targetSeconds = durationSeconds + TAIL_PADDING_SECONDS
  const filter = [
    `scale=${width}:${height}:force_original_aspect_ratio=increase`,
    `crop=${width}:${height}`,
    `fps=${MOTION_FPS}`,
    'format=yuv420p'
  ].join(',')

  const args: string[] = ['-y', '-stream_loop', '-1', '-i', imagePath]

  // Explicit stream mapping: with two inputs, ffmpeg's default pick for audio can be the
  // footage's own soundtrack, which would bury the narration.
  if (audioPath) args.push('-i', audioPath)

  args.push('-t', String(targetSeconds), '-vf', filter)

  if (audioPath) {
    args.push('-map', '0:v:0', '-map', '1:a:0', '-shortest', '-c:a', 'aac', '-b:a', '192k')
  } else {
    args.push('-an')
  }

  args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-movflags', '+faststart', outputPath)

  await fs.mkdir(dirname(outputPath), { recursive: true })

  await runFfmpeg({
    args,
    totalDurationSeconds: targetSeconds,
    onProgress: onProgress ? (info) => onProgress(info.fraction) : undefined,
    isCancelled,
    timeoutMs,
    label: `footage clip ${outputPath.split(/[\\/]/).pop()}`
  })
}

// ---------------------------------------------------------------------------
// Concat
// ---------------------------------------------------------------------------

/**
 * Join the per-scene clips. All clips come from the same encoder settings, so a stream
 * copy is valid and near-instant; if it ever fails we fall back to a re-encode rather
 * than losing the run.
 */
export async function concatClips(options: {
  clips: string[]
  outputPath: string
  isCancelled?: () => boolean
  onProgress?: (fraction: number) => void
  totalDurationSeconds?: number
}): Promise<void> {
  const { clips, outputPath, isCancelled, onProgress, totalDurationSeconds } = options
  if (!clips.length) throw new Error('Nothing to concatenate — no clips were rendered')

  const listPath = `${outputPath}.concat.txt`
  await fs.mkdir(dirname(outputPath), { recursive: true })
  // The concat demuxer wants single quotes escaped; Windows paths also need forward slashes.
  const list = clips.map((clip) => `file '${clip.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`)
  await fs.writeFile(listPath, list.join('\n'), 'utf8')

  try {
    try {
      await runFfmpeg({
        args: ['-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', '-movflags', '+faststart', outputPath],
        isCancelled,
        onProgress: onProgress ? (info) => onProgress(info.fraction) : undefined,
        totalDurationSeconds,
        label: 'concat'
      })
    } catch (err) {
      if (isCancelled?.()) throw err
      console.warn('[render] stream-copy concat failed, re-encoding:', (err as Error).message)
      await runFfmpeg({
        args: [
          '-y',
          '-f',
          'concat',
          '-safe',
          '0',
          '-i',
          listPath,
          '-c:v',
          'libx264',
          '-preset',
          'veryfast',
          '-crf',
          '20',
          '-pix_fmt',
          'yuv420p',
          '-c:a',
          'aac',
          '-b:a',
          '192k',
          '-movflags',
          '+faststart',
          outputPath
        ],
        isCancelled,
        onProgress: onProgress ? (info) => onProgress(info.fraction) : undefined,
        totalDurationSeconds,
        timeoutMs: 30 * 60 * 1000,
        label: 'concat (re-encode)'
      })
    }
  } finally {
    await fs.rm(listPath, { force: true }).catch(() => undefined)
  }
}

// ---------------------------------------------------------------------------
// Final render
// ---------------------------------------------------------------------------

export interface RenderFinalOptions {
  videoPath: string
  outputPath: string
  /** Absolute path to a generated .ass file, when subtitles are enabled. */
  assPath?: string
  musicPath?: string
  musicVolume: number
  width: number
  height: number
  isCancelled?: () => boolean
  onProgress?: (fraction: number) => void
  totalDurationSeconds?: number
}

/**
 * Burn subtitles, mix the music bed under the narration, and normalise loudness.
 *
 * `normalize=0` on the mix is important: amix otherwise halves every input, so the
 * narration quietly drops by 6 dB the moment music is added.
 */
export async function renderFinal(options: RenderFinalOptions): Promise<void> {
  const {
    videoPath,
    outputPath,
    assPath,
    musicPath,
    musicVolume,
    isCancelled,
    onProgress,
    totalDurationSeconds
  } = options

  const args: string[] = ['-y', '-i', videoPath]
  const hasMusic = Boolean(musicPath)
  if (hasMusic) {
    // Loop the bed so it covers a video longer than the track.
    args.push('-stream_loop', '-1', '-i', musicPath as string)
  }

  const chains: string[] = []

  if (assPath) {
    chains.push(`[0:v]subtitles=filename='${escapeFilterPath(assPath)}'[v]`)
  } else {
    chains.push('[0:v]null[v]')
  }

  if (hasMusic) {
    chains.push(`[0:a]volume=1.0[nar]`)
    chains.push(`[1:a]volume=${musicVolume}[mus]`)
    chains.push('[nar][mus]amix=inputs=2:duration=first:normalize=0[amixed]')
  } else {
    chains.push('[0:a]anull[amixed]')
  }

  chains.push(
    `[amixed]loudnorm=I=${LOUDNESS.I}:TP=${LOUDNESS.TP}:LRA=${LOUDNESS.LRA}[aout]`
  )

  args.push(
    '-filter_complex',
    chains.join(';'),
    '-map',
    '[v]',
    '-map',
    '[aout]',
    '-c:v',
    'libx264',
    '-preset',
    'medium',
    '-crf',
    '20',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-b:a',
    '192k',
    '-movflags',
    '+faststart',
    // The music stream is looped forever; stop at the end of the narration.
    '-shortest',
    outputPath
  )

  await fs.mkdir(dirname(outputPath), { recursive: true })

  await runFfmpeg({
    args,
    totalDurationSeconds,
    onProgress: onProgress ? (info) => onProgress(info.fraction) : undefined,
    isCancelled,
    label: 'final render'
  })
}
