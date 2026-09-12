/**
 * Retry + fallback for scene image generation.
 *
 * A browser-automation provider fails for reasons that are not the user's fault and are
 * often transient — a captcha, a mid-generation session blip, a page that never finished
 * loading. So the pipeline gives each provider a few attempts, and when one provider is
 * genuinely out (signed out, broken) it hands the scene to the next one in
 * `IMAGE_FALLBACK_ORDER`. Only when every provider has spent its attempts does the scene
 * count as failed — and even then the fill-in pass covers it with the nearest neighbor.
 */
import { IMAGE_FALLBACK_ORDER, IMAGE_RETRY_DEFAULT } from '@shared/constants'
import type { AppSettings, GenerateImageOptions } from '@shared/types'
import { getImageProvider } from './registry'

export interface SceneImageResult {
  providerId: string
  path: string
  attempts: number
}

/**
 * The order in which providers get to try one scene.
 *
 * `local` is excluded from fallback on purpose (see `IMAGE_FALLBACK_ORDER`): replacing a
 * failed generation with unrelated stock files would hide the failure instead of fixing it.
 */
export function resolveProviderOrder(configuredId: string): string[] {
  if (configuredId === 'local') return ['local']
  return [configuredId, ...IMAGE_FALLBACK_ORDER.filter((id) => id !== configuredId)]
}

/**
 * Try each provider in order, `retries` attempts each, returning the first success.
 *
 * The per-provider `generate` already throws on a hard failure (signed out, no composer),
 * so a retry is the whole attempt, not a resume. `isCancelled` is checked between attempts
 * so a cancel never waits for the full ladder.
 */
export async function generateSceneImage(
  options: GenerateImageOptions,
  settings: AppSettings,
  configuredId: string,
  log: (message: string) => void
): Promise<SceneImageResult> {
  const retries = Math.max(1, settings.imageRetries || IMAGE_RETRY_DEFAULT)
  const order = resolveProviderOrder(configuredId)
  const failures: string[] = []

  for (const providerId of order) {
    const provider = getImageProvider(providerId)
    if (!provider) {
      failures.push(`${providerId}: not registered`)
      continue
    }

    for (let attempt = 1; attempt <= retries; attempt++) {
      if (options.isCancelled?.()) throw new Error('cancelled')
      try {
        const path = await provider.generate(options, settings)
        const attempts = order.indexOf(providerId) * retries + attempt
        return { providerId, path, attempts }
      } catch (err) {
        if (options.isCancelled?.()) throw err
        const message = (err as Error).message
        const tried = attempt < retries ? 'retrying' : 'falling back'
        log(`[${providerId}] scene image attempt ${attempt}/${retries} failed (${tried}): ${message}`)
        failures.push(`${providerId} attempt ${attempt}: ${message}`)
      }
    }
  }

  throw new Error(failures[0] ?? 'No image provider could produce this scene.')
}
