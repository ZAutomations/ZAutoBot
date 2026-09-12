/**
 * Makes `window.api` visible to the renderer's TypeScript.
 *
 * The implementation lives in `index.ts`; this only declares the shape the renderer sees.
 */
import type { ZBotApi } from '@shared/api'

declare global {
  interface Window {
    api: ZBotApi
  }
}

export {}
