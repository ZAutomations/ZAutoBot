/**
 * The parts of generating an image that have nothing to do with the transport.
 *
 * Writing the prompt, confirming it was sent, and getting the bytes onto disk as a real PNG
 * are identical whether the page is in an Electron window or in a tab of the user's Chrome.
 * They live here so that a fix to any of them lands in both — the failure mode of leaving
 * them duplicated is a bug fixed in one driver and quietly still present in the other.
 */
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { GenerateImageOptions } from '@shared/types'
import { runFfmpeg } from '../../video/ffmpeg'

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47])

/** How long to give a composer to empty itself before assuming Enter did not submit. */
const SEND_CONFIRM_MS = 1_500

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Abort the current attempt if the user asked for it.
 *
 * The `where` lands in the message because a cancel that surfaces as a bare "Cancelled"
 * gives no clue which wait was abandoned — and cancellation runs through the same error
 * path as a genuine failure, so the message is often the only thing distinguishing them.
 */
export function throwIfCancelled(isCancelled: (() => boolean) | undefined, where: string): void {
  if (isCancelled?.()) throw new Error(`Cancelled (${where})`)
}

/**
 * The page operations sending a prompt needs, and nothing else.
 *
 * Deliberately narrow: this is the whole surface the send logic depends on, so a page type
 * that satisfies it can be driven without either driver knowing about the other.
 */
export interface PromptPage {
  pressEnter(): Promise<void>
  composerHasText(): Promise<boolean>
  clickSend(): Promise<boolean>
}

/**
 * The prompt actually sent.
 *
 * The orientation clause is not decoration: these models default to square or landscape,
 * and this app renders 9:16. Asking for the frame up front beats cropping a composed
 * landscape shot down to a narrow strip and losing whatever was at the edges.
 */
export function buildPrompt(options: GenerateImageOptions): string {
  const parts = [options.prompt.trim()]
  if (options.mood?.trim()) parts.push(`Mood: ${options.mood.trim()}.`)
  parts.push('Vertical 9:16 composition, full-bleed, no text or watermarks.')
  return parts.join(' ')
}

/**
 * Send the prompt and confirm it actually left.
 *
 * Enter is tried first because it sidesteps the send-button matching the spec warns about.
 * If the composer still holds the text afterwards, Enter was a newline and the button is
 * the only way through.
 */
export async function submitPrompt(
  page: PromptPage,
  isCancelled?: () => boolean
): Promise<void> {
  await page.pressEnter()
  await sleep(SEND_CONFIRM_MS)
  throwIfCancelled(isCancelled, 'sending the prompt')

  if (!(await page.composerHasText())) return

  if (!(await page.clickSend())) {
    throw new Error('The prompt would not send — neither Enter nor a send button worked.')
  }
}

/**
 * Write the page's bytes as a real PNG.
 *
 * The path the pipeline hands over always ends in `.png`, but generators return whatever
 * they feel like — often WebP. Writing WebP bytes under a `.png` name works by accident
 * (ffmpeg sniffs content) and then breaks something much later, so anything that is not
 * already a PNG is converted here instead.
 */
export async function writeAsPng(
  bytes: Buffer,
  outputPath: string,
  isCancelled?: () => boolean
): Promise<void> {
  await fs.mkdir(dirname(outputPath), { recursive: true })

  if (bytes.subarray(0, 4).equals(PNG_MAGIC)) {
    await fs.writeFile(outputPath, bytes)
    return
  }

  const temporary = join(tmpdir(), `zbot-image-${process.pid}-${Date.now()}.bin`)
  try {
    await fs.writeFile(temporary, bytes)
    await runFfmpeg({
      args: ['-y', '-i', temporary, '-frames:v', '1', outputPath],
      isCancelled,
      label: 'converting the generated image to PNG'
    })
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => undefined)
  }
}
