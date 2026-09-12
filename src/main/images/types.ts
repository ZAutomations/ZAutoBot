/**
 * The image provider contract.
 *
 * Meta AI and Gemini are browser-automation providers: they drive a real logged-in
 * WebContentsView. They are deliberately behind this interface so the pipeline does not
 * care which one produced a frame — and so a fragile provider can never be the only path.
 */
import type { AppSettings, GenerateImageOptions } from '@shared/types'

export interface ImageProvider {
  readonly id: string

  /** False when the provider cannot run (not signed in, no folder chosen). */
  isReady(settings: AppSettings): Promise<boolean>

  /**
   * Human-readable reason shown next to the provider when it cannot be used.
   *
   * Only meaningful when `isReady` returned false — implementations may assume that and
   * describe the blocking condition rather than re-deriving whether one exists.
   */
  readyReason(settings: AppSettings): string

  /** Produce one image at `options.outputPath` and return that path. */
  generate(options: GenerateImageOptions, settings: AppSettings): Promise<string>
}
