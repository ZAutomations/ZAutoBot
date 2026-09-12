/**
 * Local folder provider — uses image files the user already has.
 *
 * It is a real option (bring your own artwork), and it is also what lets the whole
 * pipeline be proven end to end without a logged-in browser session in the loop.
 */
import { promises as fs } from 'node:fs'
import { dirname, extname, join } from 'node:path'
import type { GenerateImageOptions } from '@shared/types'
import type { ImageProvider } from '../types'

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.gif'])

/**
 * Natural order, so `image2.png` sorts before `image10.png` — a plain lexicographic sort
 * scrambles any folder numbered without zero padding.
 */
async function listImages(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true })
  return entries
    .filter((entry) => entry.isFile() && IMAGE_EXTENSIONS.has(extname(entry.name).toLowerCase()))
    .map((entry) => join(dir, entry.name))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }))
}

export const localFolderProvider: ImageProvider = {
  id: 'local',

  async isReady() {
    return true
  },

  readyReason() {
    return ''
  },

  async generate(options: GenerateImageOptions): Promise<string> {
    const dir = options.sourceDir?.trim()
    if (!dir) {
      throw new Error('No image folder selected — choose one in the project settings.')
    }

    const files = await listImages(dir)
    if (!files.length) {
      throw new Error(`No image files found in ${dir}`)
    }

    if (options.isCancelled?.()) throw new Error('Cancelled')

    // Fewer images than scenes? Cycle rather than fail — the run stays alive and the
    // warning about reuse is raised by the parser, not by a crash here.
    const source = files[options.index % files.length]

    await fs.mkdir(dirname(options.outputPath), { recursive: true })
    await fs.copyFile(source, options.outputPath)

    return options.outputPath
  }
}
