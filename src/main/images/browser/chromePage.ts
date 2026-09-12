/**
 * The Electron page primitives, over a Chrome tab instead of a BrowserWindow.
 *
 * `page.ts` and this file are the same program twice: both run the scripts in
 * `pageScripts.ts` and turn "not there yet" into a real error after a deadline. The only
 * thing that differs is how a script gets to the page — `executeJavaScript` on a WebContents
 * versus `Runtime.evaluate` on a DevTools session. Keeping them apart is what lets the
 * browser-driven providers and the Chrome-driven one share one set of heuristics; keeping
 * them *separate* rather than forcing one abstraction over both keeps each driver honest
 * about its own transport, which is the half that actually breaks.
 *
 * The polling here is the same shape as `page.ts`: ask, wait, ask again. Chrome's own
 * `Runtime.evaluate` with `awaitPromise` would allow a page-side wait loop, but a loop that
 * lives in the page cannot be cancelled from here — and cancellation is not optional when
 * the user can hit Stop mid-run.
 */
import { IMAGE_TIMEOUT_MS, MIN_IMAGE_EDGE_PX, PAGE_TIMEOUT_MS, POLL_INTERVAL_MS } from './config'
import type { ChromeTab } from './chrome'
import { throwIfCancelled, type PromptPage } from './prompt'
import {
  CLICK_SEND,
  COMPOSER_HAS_TEXT,
  FIND_COMPOSER,
  PAGE_READY,
  PRESS_ENTER,
  countImagesScript,
  grabImageScript,
  newImageScript,
  typePromptScript,
  type GrabResult
} from './pageScripts'

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * A shortened URL for error messages.
 *
 * Generated image URLs are long signed CDN links whose query strings carry a signature and
 * an expiry. Truncating keeps the host and path — the part that says *which* CDN and *what*
 * kind of resource — without pushing a wall of token into a message the user has to read.
 * It is deliberately not truncated to nothing: "blob:" and "lh3.googleusercontent.com" lead
 * to completely different diagnoses.
 */
function shortSrc(src: string): string {
  if (src.startsWith('blob:')) return 'the generated blob image'
  const withoutQuery = src.split('?')[0]
  return withoutQuery.length > 80 ? `${withoutQuery.slice(0, 80)}…` : withoutQuery
}

/**
 * A tab being driven as a page.
 *
 * Holds nothing but the tab: every method is a script plus a deadline. State would be a lie
 * here — the page can navigate itself at any moment, so anything cached from a previous call
 * is a guess about a document that may no longer exist.
 */
export class ChromePage implements PromptPage {
  constructor(private readonly tab: ChromeTab) {}

  private async waitFor<T>(
    script: string,
    options: { timeoutMs?: number; label: string; isCancelled?: () => boolean }
  ): Promise<T> {
    const timeoutMs = options.timeoutMs ?? PAGE_TIMEOUT_MS
    const deadline = Date.now() + timeoutMs

    while (Date.now() < deadline) {
      throwIfCancelled(options.isCancelled, `waiting for ${options.label}`)
      const value = await this.tab.evaluate<T>(script)
      if (value) return value
      await sleep(POLL_INTERVAL_MS)
    }

    throw new Error(`Timed out after ${Math.round(timeoutMs / 1000)}s waiting for ${options.label}.`)
  }

  async goto(url: string, isCancelled?: () => boolean): Promise<void> {
    await this.tab.navigate(url)
    throwIfCancelled(isCancelled, 'after the page loaded')
    await this.waitFor(PAGE_READY, { label: 'the page to finish loading', isCancelled })
  }

  findComposer(isCancelled?: () => boolean, timeoutMs?: number): Promise<unknown> {
    return this.waitFor(FIND_COMPOSER, {
      timeoutMs,
      label: 'the prompt box (is the account signed in?)',
      isCancelled
    })
  }

  async typePrompt(text: string): Promise<void> {
    const ok = await this.tab.evaluate<boolean>(typePromptScript(text))
    if (!ok) throw new Error('Could not type into the prompt box.')
  }

  async pressEnter(): Promise<void> {
    const ok = await this.tab.evaluate<boolean>(PRESS_ENTER)
    if (!ok) throw new Error('Could not reach the prompt box to send.')
  }

  async clickSend(): Promise<boolean> {
    return (await this.tab.evaluate<boolean>(CLICK_SEND)) ?? false
  }

  async countImages(): Promise<number> {
    return (await this.tab.evaluate<number>(countImagesScript(MIN_IMAGE_EDGE_PX))) ?? 0
  }

  async composerHasText(): Promise<boolean> {
    return (await this.tab.evaluate<boolean>(COMPOSER_HAS_TEXT)) ?? false
  }

  waitForNewImage(before: number, isCancelled?: () => boolean): Promise<string> {
    return this.waitFor<string>(newImageScript(MIN_IMAGE_EDGE_PX, before), {
      timeoutMs: IMAGE_TIMEOUT_MS,
      label: 'the generated image to appear',
      isCancelled
    })
  }

  /**
   * The image's bytes — from the browser first, the page second.
   *
   * Order matters. Asking Chrome for the response body cannot fail on the site's CSP or on
   * CORS, because the browser is the one that fetched it in the first place. The in-page
   * fetch is only a fallback for the case where Chrome has already evicted the body, and it
   * reports *why* it failed rather than a bare "no data".
   */
  async grabImageBytes(src: string): Promise<Buffer> {
    const fromBrowser = await this.tab.imageBytesFromNetwork(src)
    if (fromBrowser) return fromBrowser

    const { value, error } = await this.tab.evaluateRaw<GrabResult>(grabImageScript(src))

    if (error) throw new Error(`Could not download ${shortSrc(src)} — ${error}`)
    if (!value) throw new Error(`The page did not answer when asked for ${shortSrc(src)}.`)
    if (!value.ok || !value.base64) {
      throw new Error(
        `Could not download ${shortSrc(src)} — ${value.reason ?? 'no reason given'}`
      )
    }

    const bytes = Buffer.from(value.base64, 'base64')
    if (!bytes.length) throw new Error('The page returned an empty image.')
    return bytes
  }
}
