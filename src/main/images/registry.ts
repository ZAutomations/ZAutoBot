/**
 * Image provider registry.
 *
 * The pipeline resolves by id and never imports a provider directly, so adding one is a
 * line here plus a metadata entry in `IMAGE_PROVIDERS`.
 *
 * Note which browser each id gets. Meta AI runs in an Electron window this app owns;
 * Gemini runs in the user's own Chrome, because Google's sign-in refuses embedded browsers
 * outright. Both are "browser automation" to the pipeline, and it neither knows nor cares
 * which kind it is talking to.
 */
import { IMAGE_PROVIDERS } from '@shared/constants'
import type { AppSettings, ImageProviderMeta, ProviderAvailability } from '@shared/types'
import { createBrowserProvider } from './browser/browserProvider'
import { chromeGeminiProvider } from './browser/chromeProvider'
import { localFolderProvider } from './providers/localFolder'
import type { ImageProvider } from './types'

const PROVIDERS: Record<string, ImageProvider> = {
  local: localFolderProvider,
  metaai: createBrowserProvider('metaai'),
  gemini: chromeGeminiProvider
}

export function getImageProvider(id: string): ImageProvider | null {
  return PROVIDERS[id] ?? null
}

export function listImageProviders(): ImageProviderMeta[] {
  return IMAGE_PROVIDERS
}

export type { ProviderAvailability }

export async function imageProviderAvailability(
  settings: AppSettings
): Promise<ProviderAvailability[]> {
  return Promise.all(
    IMAGE_PROVIDERS.map(async (meta) => {
      const provider = getImageProvider(meta.id)
      if (!provider) return { meta, ready: false, reason: 'Provider not registered' }

      const ready = await provider.isReady(settings)
      return {
        meta,
        ready,
        // Only meaningful for a provider that cannot run — see `ImageProvider.readyReason`.
        reason: ready ? '' : provider.readyReason(settings)
      }
    })
  )
}
