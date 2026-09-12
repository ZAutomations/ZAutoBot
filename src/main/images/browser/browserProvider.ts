/**
 * The browser-driven image providers.
 *
 * Meta AI and Gemini are the same job against different pages: open a fresh chat, type the
 * scene prompt, send it, wait for the picture, take the bytes. So they share one
 * implementation parameterised by provider rather than two files that drift apart — the
 * only per-provider facts (URL, partition, cookie names, label) live in `config.ts`.
 *
 * These WILL break when either company redesigns its UI. That is why the registry keeps
 * both registered and the pipeline can fall back from one to the other.
 */
import type { GenerateImageOptions } from '@shared/types'
import type { ImageProvider } from '../types'
import { DISPLAY_NAME, HOME_URL, REQUIRES_AUTH_COOKIES, type BrowserProviderId } from './config'
import {
  acquireWorker,
  destroyWorkersFor,
  forgetProbe,
  hasSessionCookies,
  isKnownSignedOut,
  isSignedIn,
  persistSessionCookies,
  releaseWorker,
  rememberProbe,
  sessionFor
} from './session'
import {
  ElectronPage,
  countImages,
  enableImageCapture,
  findComposer,
  grabImageBytes,
  loadPage,
  throwIfCancelled,
  typePrompt,
  waitForNewImage,
  waitForReady
} from './page'
import { buildPrompt, submitPrompt, writeAsPng } from './prompt'

/** How long the probe waits for the prompt box once the page itself has loaded. */
const PROBE_COMPOSER_MS = 15_000

export function createBrowserProvider(id: BrowserProviderId): ImageProvider {
  return {
    id,

    async isReady() {
      return isSignedIn(id)
    },

    readyReason() {
      return `Not signed in — use Connect on the ${DISPLAY_NAME[id]} row in Settings.`
    },

    async generate(options: GenerateImageOptions): Promise<string> {
      const view = acquireWorker(id)
      const page = view.webContents

      try {
        // Before the first navigation: the image CDNs these sites use are outside their own
        // `connect-src`, so the bytes have to be taken from the browser, not fetched in the
        // page. See `enableImageCapture`.
        await enableImageCapture(page)

        // A fresh chat every time. Reusing the previous conversation lets the model carry
        // the last scene's subject into this one, which shows up as scenes that all look
        // like variations of the first.
        await loadPage(page, HOME_URL[id])
        await waitForReady(page, options.isCancelled)
        await findComposer(page, options.isCancelled)

        throwIfCancelled(options.isCancelled, 'before sending')

        const before = await countImages(page)
        await typePrompt(page, buildPrompt(options))
        await submitPrompt(new ElectronPage(page), options.isCancelled)

        const src = await waitForNewImage(page, before, options.isCancelled)
        const bytes = await grabImageBytes(page, src)

        throwIfCancelled(options.isCancelled, 'after downloading')
        await writeAsPng(bytes, options.outputPath, options.isCancelled)

        return options.outputPath
      } catch (err) {
        const message = (err as Error).message
        if (message === 'Cancelled' || message.startsWith('Cancelled (')) throw err

        // Only a probe that actually found nobody signed in gets to say so — see
        // `isKnownSignedOut`. The original message is kept either way, because it is the only
        // thing that names what really went wrong.
        if (isKnownSignedOut(id)) {
          throw new Error(
            `${DISPLAY_NAME[id]} is not signed in — connect it in Settings, then retry. (${message})`
          )
        }
        throw new Error(`${DISPLAY_NAME[id]} could not produce the image: ${message}`)
      } finally {
        releaseWorker(view)
      }
    }
  }
}

/**
 * Wipe a provider's saved session, so a wrong or expired login can be replaced.
 *
 * Order matters: the worker windows are closed first, so nothing is left holding the
 * partition open, then the stored data goes, then the remembered probe verdict — which
 * otherwise outlives the session and reports a cleared partition as still signed in.
 */
export async function signOut(id: BrowserProviderId): Promise<void> {
  destroyWorkersFor(id)
  await sessionFor(id).clearStorageData()
  forgetProbe(id)
}

/**
 * Check a provider for real: load the page and look for the prompt box.
 *
 * This is the authoritative answer, and it deliberately does not consult the cookie check
 * first. A provider whose session lives outside the cookie jar — Meta AI does exactly that
 * — is signed in and working while its cookie jar looks empty, so gating on cookies would
 * report a perfectly good session as disconnected.
 *
 * The verdict is remembered, because `isReady` has no other way to learn it without
 * loading a page on every Settings render.
 */
export async function probeProvider(id: BrowserProviderId): Promise<{ ok: boolean; message: string }> {
  const view = acquireWorker(id)
  const page = view.webContents

  try {
    // For Gemini the composer proves nothing — it is shown to signed-out visitors too — so
    // the cookies are checked first and the page probe only confirms the box is reachable.
    if (REQUIRES_AUTH_COOKIES[id] && !(await hasSessionCookies(id))) {
      rememberProbe(id, false)
      return {
        ok: false,
        message: `${DISPLAY_NAME[id]} has no signed-in account stored — use Connect to sign in.`
      }
    }

    await loadPage(page, HOME_URL[id])
    await waitForReady(page)

    // Shorter than the page-load budget on purpose: by here the page has finished loading,
    // so the prompt box is either there or it is not. Waiting a full minute to say so just
    // makes the Test button feel broken.
    await findComposer(page, undefined, PROBE_COMPOSER_MS)

    // Signed in, for real. Nail the session to disk now so it is still here tomorrow —
    // the auth cookies Meta and Google hand out here are session-scoped and would otherwise
    // be dropped the moment the app quits.
    await persistSessionCookies(id)

    rememberProbe(id, true)
    return { ok: true, message: `Connected — ${DISPLAY_NAME[id]} is signed in and ready.` }
  } catch (err) {
    rememberProbe(id, false)
    return {
      ok: false,
      message:
        `Could not find the ${DISPLAY_NAME[id]} prompt box. If you are signed in, the page ` +
        `layout has probably changed — otherwise use Connect to sign in. (${(err as Error).message})`
    }
  } finally {
    releaseWorker(view)
  }
}
