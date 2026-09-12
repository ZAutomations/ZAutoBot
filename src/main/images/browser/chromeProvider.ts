/**
 * Gemini, driven through the user's own Chrome.
 *
 * Everywhere else in this folder the app owns the browser. Here it does not, and that is the
 * entire point: Google's sign-in refuses embedded browsers, so the only way to reach Gemini
 * with a real account is through Chrome itself. The app launches Chrome against a profile of
 * its own (never the user's), the user signs in once in a window they can see, and from then
 * on this module drives that browser over the DevTools Protocol.
 *
 * The consequence worth stating plainly, because it is visible: Gemini work happens in a real
 * Chrome window. Tabs open there while a video renders. They are opened in the background so
 * they do not steal focus, and after a run the tab is parked warm in Chrome for the next one,
 * holding the conversation it was generating into.
 *
 * Sign-in is proved by cookies, not by the page. Gemini shows its composer to signed-out
 * visitors, so a reachable prompt box means nothing — a partition with no Google account at
 * all once reported a healthy connection on exactly that evidence. Chrome's cookie jar is
 * asked directly over the protocol, which is also the only way to read it: Chrome seals the
 * database on disk to `chrome.exe`, so no other process can open it.
 */
import type { AppSettings, GenerateImageOptions } from '@shared/types'
import type { ImageProvider } from '../types'
import {
  SIGN_IN_COOKIES,
  SIGN_IN_URL,
  HOME_URL,
  PAGE_TIMEOUT_MS,
  type BrowserProviderId
} from './config'
import { ChromePage } from './chromePage'
import {
  chromeRunningReason,
  closeChrome,
  ensureChrome,
  findBrowserExecutable,
  isChromeRunning,
  openTab,
  acquireTab,
  releaseTab,
  chromeCookies
} from './chrome'
import { buildPrompt, submitPrompt, throwIfCancelled, writeAsPng } from './prompt'

const ID: BrowserProviderId = 'gemini'

const DISPLAY = 'Google Gemini'

/** The Chrome-backed Gemini, as the pipeline sees it. */
export const chromeGeminiProvider: ImageProvider = {
  id: ID,

  async isReady(_settings: AppSettings) {
    return isSignedIn()
  },

  readyReason(_settings: AppSettings) {
    if (!findBrowserExecutable()) return chromeRunningReason()
    return `${DISPLAY} signs in through Chrome — use Connect… on this row to sign in, or Test to check.`
  },

  async generate(options: GenerateImageOptions) {
    return generateViaChrome(options)
  }
}

/**
 * Is a Google account signed in to the app's Chrome?
 *
 * The verdict for a browser that is *not* running is remembered from this session rather
 * than re-derived, because the alternative is launching a visible Chrome window every time
 * the Settings page renders. That is a real limit and not a hidden one: right after a
 * restart, and before anything has been checked, this says no — `Test` is what makes it say
 * yes, and the pipeline never consults this at all (it calls `generate`, which launches
 * Chrome itself).
 */
let rememberedSignedIn = false

export async function isSignedIn(): Promise<boolean> {
  if (!findBrowserExecutable()) return false
  if (!(await isChromeRunning())) return rememberedSignedIn
  return hasGoogleAccount()
}

/** Ask the running Chrome for its cookies and look for Google's sign-in set. */
async function hasGoogleAccount(): Promise<boolean> {
  const wanted = new Set(SIGN_IN_COOKIES[ID])
  try {
    const cookies = await chromeCookies()
    return cookies.some((cookie) => wanted.has(cookie.name) && cookie.domain.endsWith('google.com'))
  } catch {
    return false
  }
}

/** Open Chrome, on a page where signing in is possible. */
export async function connect(): Promise<void> {
  if (!findBrowserExecutable()) throw new Error(chromeRunningReason())

  // The sign-in page becomes the first tab only when Chrome is being launched. If it is
  // already up, this is a new tab in a window the user can already see.
  const wasRunning = await isChromeRunning()
  await ensureChrome(SIGN_IN_URL[ID])
  if (wasRunning) await openTab(SIGN_IN_URL[ID], { background: false })
}

/**
 * Forget the account: close Chrome and delete its profile.
 *
 * The profile *is* the login — Chrome's cookie encryption is bound to the browser binary, so
 * there is no way to remove one account from it — and deleting the whole profile is both the
 * simplest and the most complete way to sign out.
 */
export async function signOut(): Promise<void> {
  rememberedSignedIn = false
  await closeChrome()
}

/** How long the probe waits for the composer once the page itself has loaded. */
const PROBE_COMPOSER_MS = 15_000

/**
 * Check for real: is Chrome signed in, and does Gemini actually come up?
 *
 * Both halves matter and neither is sufficient. Cookies answer "is there an account"; the
 * page load answers "does the app still work". A signed-in account with a redesigned UI
 * would pass the first and fail at generation, which is the failure worth catching here.
 */
export async function probe(): Promise<{ ok: boolean; message: string }> {
  if (!findBrowserExecutable()) return { ok: false, message: chromeRunningReason() }

  try {
    // Deliberately does not reuse `isSignedIn`: that one says "no" without launching Chrome,
    // which is right for a settings list and wrong for a button the user just pressed.
    await ensureChrome()

    if (!(await hasGoogleAccount())) {
      rememberedSignedIn = false
      return {
        ok: false,
        message: `Chrome is running but no Google account is signed in — use Connect… to sign in.`
      }
    }

    const tab = await openTab(undefined, { background: true })
    const page = new ChromePage(tab)
    try {
      await page.goto(HOME_URL[ID])
      await page.findComposer(undefined, PROBE_COMPOSER_MS)
    } finally {
      await tab.close()
    }

    rememberedSignedIn = true
    return { ok: true, message: `Connected — ${DISPLAY} is signed in to Chrome and ready.` }
  } catch (err) {
    rememberedSignedIn = false
    return {
      ok: false,
      message:
        `${DISPLAY} could not be reached in Chrome. If you are signed in, the page layout has ` +
        `probably changed. (${(err as Error).message})`
    }
  }
}

/**
 * One scene, in a tab the pool hands back when it is done.
 *
 * The scenes of a video share a single conversation: the pool parks the tab instead of
 * closing it, so the next scene types into the same chat — one cold load per run, not one
 * per scene, and a character that stays the same from the first frame to the last. (The old
 * fresh-tab-per-scene plan traded exactly that away for a parallelism this machine's
 * connection to Google could not feed anyway.)
 */
async function generateViaChrome(options: GenerateImageOptions): Promise<string> {
  if (!findBrowserExecutable()) throw new Error(chromeRunningReason())

  const tab = await acquireTab(HOME_URL[ID], { background: true })
  const page = new ChromePage(tab)
  let healthy = false

  try {
    // No `goto` on a warm tab: the page is already up, and navigating away would throw the
    // conversation away. On a cold tab `acquireTab` navigated before handing it over, so in
    // both cases the composer is the thing to wait for.
    await page.findComposer(options.isCancelled, PAGE_TIMEOUT_MS)

    throwIfCancelled(options.isCancelled, 'before sending')

    const before = await page.countImages()
    await page.typePrompt(buildPrompt(options))
    await submitPrompt(page, options.isCancelled)

    const src = await page.waitForNewImage(before, options.isCancelled)
    const bytes = await page.grabImageBytes(src)

    throwIfCancelled(options.isCancelled, 'after downloading')
    await writeAsPng(bytes, options.outputPath, options.isCancelled)

    healthy = true
    return options.outputPath
  } catch (err) {
    const message = (err as Error).message
    if (message.startsWith('Cancelled (')) throw err

    // Same reasoning as the Electron driver: a signed-out session and a changed UI produce
    // an identical timeout, and only one of them is something the user can act on. Cookies
    // are real evidence here, so this one may state it — but the underlying message is kept
    // either way, because it is what actually names the failure.
    if (!(await hasGoogleAccount())) {
      throw new Error(
        `${DISPLAY} is not signed in to Chrome — connect it in Settings, then retry. (${message})`
      )
    }
    throw new Error(`${DISPLAY} could not produce the image: ${message}`)
  } finally {
    await releaseTab(tab, HOME_URL[ID], healthy)
  }
}
