/**
 * Page-driving primitives for an Electron-hosted page.
 *
 * The scripts themselves live in `pageScripts.ts`, because the same choreography also runs
 * against real Chrome over the DevTools Protocol. This file is the part that is specific to
 * a `WebContents`: polling, cancellation, and turning page results into real errors.
 *
 * Everything is deliberately heuristic rather than a pile of CSS selectors. Meta and Google
 * both ship obfuscated, frequently-rotating class names, so a selector list would be stale
 * within weeks; "the biggest editable box on the page" and "the newest large image" survive
 * redesigns far better. When a heuristic does fail, the error names what it was looking for,
 * so tuning is a matter of reading one line rather than re-deriving the page.
 */
import type { WebContents } from 'electron'
import { IMAGE_TIMEOUT_MS, PAGE_TIMEOUT_MS, POLL_INTERVAL_MS, MIN_IMAGE_EDGE_PX } from './config'
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

/** Re-exported so callers of this driver do not have to reach into `prompt.ts` for it. */
export { throwIfCancelled }

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * How long a single page call may take before it is abandoned.
 *
 * Every wait in this file polls, and a polling loop is only bounded if each individual call
 * returns. `executeJavaScript` does not guarantee that — it can stay pending forever on a
 * page that is mid-navigation, blocked, or wedged — and a single call that never comes back
 * stops the deadline check above it from ever running again. That is not a slow run, it is a
 * run that never ends and never reports why.
 */
const EVAL_TIMEOUT_MS = 20_000

/** Resolve with `fallback` if `promise` has not settled within `ms`. */
export function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms)
    const settle = (value: T): void => {
      clearTimeout(timer)
      resolve(value)
    }
    promise.then(settle, () => settle(fallback))
  })
}

/**
 * Load a URL, giving up rather than hanging.
 *
 * `loadURL` resolves on `did-finish-load`, which some pages simply never reach — a chat app
 * holding an open stream is a normal example. Without a deadline the whole run waits on it
 * silently, which from the outside is indistinguishable from the app freezing.
 */
export async function loadPage(
  page: WebContents,
  url: string,
  timeoutMs = PAGE_TIMEOUT_MS
): Promise<void> {
  const outcome = await withTimeout(
    page.loadURL(url).then(() => 'ok' as const),
    timeoutMs,
    'timeout' as const
  )

  if (outcome === 'timeout') {
    throw new Error(
      `The page did not finish loading ${url} within ${Math.round(timeoutMs / 1000)}s.`
    )
  }
}

/**
 * Run JS in the page and get the value back.
 *
 * `executeJavaScript` rejects when the page navigates mid-call, which is normal during a
 * load — that is a "not yet" and not an error worth surfacing to the user. It is also raced
 * against a deadline so a call that never settles cannot stall the loop that made it.
 */
async function evalInPage<T>(page: WebContents, script: string): Promise<T | null> {
  if (page.isDestroyed()) return null
  try {
    return await withTimeout(
      page.executeJavaScript(script, true) as Promise<T>,
      EVAL_TIMEOUT_MS,
      null
    )
  } catch {
    return null
  }
}

/** Poll `script` until it returns something truthy, or give up. */
export async function waitFor<T>(
  page: WebContents,
  script: string,
  options: { timeoutMs?: number; label: string; isCancelled?: () => boolean }
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? PAGE_TIMEOUT_MS
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    throwIfCancelled(options.isCancelled, `waiting for ${options.label}`)
    const value = await evalInPage<T>(page, script)
    if (value) return value
    await sleep(POLL_INTERVAL_MS)
  }

  throw new Error(`Timed out after ${Math.round(timeoutMs / 1000)}s waiting for ${options.label}.`)
}

export function waitForReady(page: WebContents, isCancelled?: () => boolean): Promise<unknown> {
  return waitFor(page, PAGE_READY, { label: 'the page to finish loading', isCancelled })
}

export async function findComposer(
  page: WebContents,
  isCancelled?: () => boolean,
  timeoutMs?: number
): Promise<{ tag: string; placeholder: string }> {
  return waitFor(page, FIND_COMPOSER, {
    timeoutMs,
    label: 'the prompt box (is the account signed in?)',
    isCancelled
  })
}

export async function typePrompt(page: WebContents, text: string): Promise<void> {
  const ok = await evalInPage<boolean>(page, typePromptScript(text))
  if (!ok) throw new Error('Could not type into the prompt box.')
}

export async function pressEnter(page: WebContents): Promise<void> {
  const ok = await evalInPage<boolean>(page, PRESS_ENTER)
  if (!ok) throw new Error('Could not reach the prompt box to send.')
}

export async function clickSend(page: WebContents): Promise<boolean> {
  return (await evalInPage<boolean>(page, CLICK_SEND)) ?? false
}

export async function countImages(page: WebContents): Promise<number> {
  return (await evalInPage<number>(page, countImagesScript(MIN_IMAGE_EDGE_PX))) ?? 0
}

export async function composerHasText(page: WebContents): Promise<boolean> {
  return (await evalInPage<boolean>(page, COMPOSER_HAS_TEXT)) ?? false
}

export async function waitForNewImage(
  page: WebContents,
  before: number,
  isCancelled?: () => boolean
): Promise<string> {
  return waitFor<string>(page, newImageScript(MIN_IMAGE_EDGE_PX, before), {
    timeoutMs: IMAGE_TIMEOUT_MS,
    label: 'the generated image to appear',
    isCancelled
  })
}

/**
 * Image responses seen per page, by URL.
 *
 * Same purpose as the equivalent map on `ChromeTab`, and needed for the same reason: a
 * generated image sits behind the site's `Content-Security-Policy`, whose `connect-src` does
 * not list the image CDN. The `<img>` renders and `fetch()` of that exact URL is refused, so
 * the bytes have to come from the browser rather than from a script in the page.
 *
 * Electron exposes the same protocol Chrome does, through `webContents.debugger`, so the
 * mechanism is identical — only the handle differs.
 */
const imageRequestsByPage = new WeakMap<WebContents, Map<string, string>>()
const capturingPages = new WeakSet<WebContents>()

/**
 * Begin recording image responses on a page. Call before the page loads.
 *
 * Bounded, because `debugger.sendCommand` has no deadline of its own and the debugger can
 * simply never answer — leaving the caller waiting before a single page has even loaded,
 * with nothing printed and nothing to time out. Losing the capture is survivable: the
 * in-page fetch is still there as a fallback.
 */
export async function enableImageCapture(page: WebContents): Promise<void> {
  if (page.isDestroyed() || capturingPages.has(page)) return
  capturingPages.add(page)

  const seen = new Map<string, string>()
  imageRequestsByPage.set(page, seen)

  await withTimeout(attachImageCapture(page, seen), 10_000, undefined).catch(() => undefined)
}

async function attachImageCapture(
  page: WebContents,
  seen: Map<string, string>
): Promise<void> {
  const debugger_ = page.debugger
  if (!debugger_.isAttached()) debugger_.attach('1.3')

  debugger_.on('message', (_event, method, params) => {
    if (method !== 'Network.responseReceived') return
    const { type, requestId, response } = params as {
      type?: string
      requestId?: string
      response?: { url?: string }
    }
    if (type !== 'Image' || !requestId || !response?.url) return
    seen.set(response.url, requestId)
  })

  await debugger_.sendCommand('Network.enable')
}

/**
 * The bytes of an image the page has already loaded, from the browser's own copy.
 *
 * `null` means the body is no longer held — Chrome evicts bodies for resources it has
 * finished with — which is not an error, just a reason to fall back.
 */
async function imageBytesFromNetwork(page: WebContents, src: string): Promise<Buffer | null> {
  const requestId = imageRequestsByPage.get(page)?.get(src)
  if (!requestId) return null

  // Bounded like every other debugger call: this promise has no deadline of its own, and a
  // wedged page can leave it pending forever — which is exactly how a run hangs with its
  // last line already printed and nothing more ever said.
  const response = await withTimeout(
    page.debugger.sendCommand('Network.getResponseBody', {
      requestId
    }) as Promise<{ body: string; base64Encoded: boolean }>,
    15_000,
    null
  ).catch(() => null)

  if (!response) return null

  const bytes = Buffer.from(response.body, response.base64Encoded ? 'base64' : 'binary')
  return bytes.length ? bytes : null
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

export async function grabImageBytes(page: WebContents, src: string): Promise<Buffer> {
  const fromBrowser = await imageBytesFromNetwork(page, src)
  if (fromBrowser) return fromBrowser

  const result = await evalInPage<GrabResult>(page, grabImageScript(src))

  if (!result) throw new Error(`The page did not answer when asked for ${shortSrc(src)}.`)
  if (!result.ok || !result.base64) {
    throw new Error(`Could not download ${shortSrc(src)} — ${result.reason ?? 'no reason given'}`)
  }

  const bytes = Buffer.from(result.base64, 'base64')
  if (!bytes.length) throw new Error('The page returned an empty image.')
  return bytes
}

/**
 * The functions above, bound to one page.
 *
 * Exists so this driver and the Chrome one present the same shape to the transport-free
 * half of the code (`prompt.ts`) — those functions take a page, and a page that needs its
 * `WebContents` passed in on every call would not fit. Nothing here is more than an
 * argument binding; all the behaviour still lives above.
 */
export class ElectronPage implements PromptPage {
  constructor(private readonly page: WebContents) {}

  pressEnter(): Promise<void> {
    return pressEnter(this.page)
  }

  composerHasText(): Promise<boolean> {
    return composerHasText(this.page)
  }

  clickSend(): Promise<boolean> {
    return clickSend(this.page)
  }
}
