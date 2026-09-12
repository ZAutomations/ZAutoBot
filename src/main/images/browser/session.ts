/**
 * Browser sessions for the automation image providers.
 *
 * Meta AI runs in Electron `WebContentsView`s attached to the app's own window — the
 * spec's design (§6), proven over years in the original build. Gemini runs in the user's
 * real Chrome instead (see `chromeProvider.ts`), so despite the file's history only Meta
 * uses the worker pool now.
 *
 * The window lifecycle, the login state and the tab pool are what live here; the page
 * choreography is in `page.ts`. The partitions are persistent, so signing in once
 * survives every later run.
 */
import { BrowserWindow, WebContentsView, session, type Cookie, type Session } from 'electron'
import {
  PARTITION_BY_PROVIDER,
  SIGN_IN_COOKIE_DOMAINS,
  SIGN_IN_COOKIES,
  type BrowserProviderId
} from './config'

/**
 * A normal Chrome-on-Windows user agent.
 *
 * The default Electron agent carries an `Electron/…` suffix, and the login-gated apps this
 * project drives treat that suffix as a bot fingerprint — which is a live reason a session
 * gets challenged (`rd_challenge`) and then dropped on the next launch. Presenting as the
 * browser every site already expects keeps the login in the same class as a normal browser.
 */
export const UA_CHROME_WIN =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

/**
 * Client-hint headers stripped from provider requests.
 *
 * Chromium derives `Sec-CH-UA-*` from its *real* version, so a request claiming
 * "User-Agent: Chrome/131" while advertising "Sec-CH-UA: Chromium; v=136" is internally
 * inconsistent. Removing them leaves the user agent string as the single, coherent story.
 *
 * Measured honestly: this is **not** what Google's sign-in gate keys on. It was tested by
 * disabling it against a clean profile and Google refused the sign-in identically either way.
 * It is kept as one less inconsistency on the wire, not as a fix for anything.
 */
const CLIENT_HINT_HEADERS = [
  'sec-ch-ua',
  'sec-ch-ua-full-version',
  'sec-ch-ua-full-version-list',
  'sec-ch-ua-arch',
  'sec-ch-ua-bitness',
  'sec-ch-ua-mobile',
  'sec-ch-ua-model',
  'sec-ch-ua-platform',
  'sec-ch-ua-platform-version',
  'sec-ch-ua-wow64'
]

/** How long persisted copies of session cookies should live. */
const SESSION_COOKIE_LIFETIME_DAYS = 90

const configuredSessions = new Set<BrowserProviderId>()

/**
 * The size a worker page renders at.
 *
 * Full size on purpose: the composer heuristic matches on element dimensions, so a
 * cramped viewport could shrink the prompt box below what counts as "the composer".
 */
const WORKER_SIZE = { width: 1280, height: 900 }

/**
 * The window the worker views live in.
 *
 * A `WebContentsView` is a child of a window, and — measured twice now — a child whose
 * bounds sit *outside* its parent is treated as hidden, exactly like the invisible
 * `BrowserWindow` workers of the first attempt: `document.visibilityState` comes back
 * `hidden` and Meta AI's app renders nothing at all in that state. So every worker sits
 * fully inside this window, and the window itself stays on screen.
 *
 * It is a window of its own rather than the app's main window because a view composites
 * **above all HTML** (spec §6): workers in the main window would sit on top of the UI
 * during a render. Being *behind* other windows is fine — native occlusion tracking is
 * switched off at startup (see `index.ts`), so a covered window is still a visible page.
 */
let workerHost: BrowserWindow | null = null

function hostWindow(): BrowserWindow {
  if (workerHost && !workerHost.isDestroyed()) return workerHost

  workerHost = new BrowserWindow({
    width: WORKER_SIZE.width,
    height: WORKER_SIZE.height,
    title: 'zBot workers',
    backgroundColor: '#1a1917',
    autoHideMenuBar: true
  })

  // Closing this window would kill every worker mid-render, and minimising it hides every
  // page in it — the exact state Meta AI's app refuses to render in. The user almost
  // certainly means to tidy the desktop, not cancel the run; quitting the app or moving
  // the window behind others is fine, and quitting tears it down anyway.
  workerHost.setMinimizable(false)
  workerHost.on('close', (event) => {
    if (allViews.size > 0) event.preventDefault()
  })

  return workerHost
}

const pool = new Map<BrowserProviderId, WebContentsView[]>()
const busy = new WeakSet<WebContentsView>()
const allViews = new Set<WebContentsView>()
const hostByView = new WeakMap<WebContentsView, BrowserWindow>()

function partitionFor(id: BrowserProviderId): string {
  return PARTITION_BY_PROVIDER[id]
}

export function sessionFor(id: BrowserProviderId): Session {
  // Configure once per provider: the fingerprint must be set before the first page load so
  // the login is negotiated under the Chrome agent, not switched mid-session.
  if (!configuredSessions.has(id)) {
    configuredSessions.add(id)
    const s = session.fromPartition(partitionFor(id))
    s.setUserAgent(UA_CHROME_WIN)

    // Keep the version-mismatch tell off the wire — see CLIENT_HINT_HEADERS.
    s.webRequest.onBeforeSendHeaders((details, callback) => {
      if (!details.requestHeaders) {
        callback({ cancel: false })
        return
      }
      for (const header of CLIENT_HINT_HEADERS) delete details.requestHeaders[header]
      callback({ cancel: false, requestHeaders: details.requestHeaders })
    })
  }
  return session.fromPartition(partitionFor(id))
}

/**
 * What the last page probe found, per provider.
 *
 * Cookies are only a hint. Meta AI in particular keeps its session somewhere other than
 * the cookie jar — a partition that is plainly signed in shows zero sign-in cookies — so
 * the authoritative answer comes from loading the page and looking for the prompt box.
 * That answer is expensive, so it is remembered here for the rest of the session rather
 * than being re-derived every time the Settings page renders.
 */
const probeResults = new Map<BrowserProviderId, boolean>()

export function rememberProbe(id: BrowserProviderId, signedIn: boolean): void {
  probeResults.set(id, signedIn)
}

/**
 * Drop a remembered verdict.
 *
 * Signing out must do this. The verdict outlives the session it described, so without it a
 * cleared partition keeps reporting "Signed in" from memory — which looks exactly like the
 * Sign out button doing nothing at all.
 */
export function forgetProbe(id: BrowserProviderId): void {
  probeResults.delete(id)
}

/**
 * Detach and close one provider's worker views, and any open sign-in window — so its
 * partition is not left held open by a page that is still loaded.
 */
export function destroyWorkersFor(id: BrowserProviderId): void {
  for (const view of pool.get(id) ?? []) destroyView(view)
  pool.delete(id)

  const signIn = signInWindows.get(id)
  if (signIn && !signIn.isDestroyed()) signIn.destroy()
}

function destroyView(view: WebContentsView): void {
  allViews.delete(view)

  const host = hostByView.get(view)
  if (host && !host.isDestroyed()) {
    try {
      host.contentView.removeChildView(view)
    } catch {
      // The host closing takes its children with it; that is not a failure.
    }
  }

  if (!view.webContents.isDestroyed()) view.webContents.close()
}

/**
 * A signed-in session leaves cookies that a signed-out one never has.
 *
 * This is a fast hint, not the verdict — see `probeResults` above and `isSignedIn` below.
 * It is a verdict on its own for providers whose sign-in cannot be seen on the page; see
 * `REQUIRES_AUTH_COOKIES`.
 */
export async function hasSessionCookies(id: BrowserProviderId): Promise<boolean> {
  const wanted = new Set(SIGN_IN_COOKIES[id])
  const store = sessionFor(id).cookies

  for (const domain of SIGN_IN_COOKIE_DOMAINS[id]) {
    const found = await store.get({ domain })
    if (found.some((cookie) => wanted.has(cookie.name) && cookie.value.length > 0)) return true
  }

  return false
}

/**
 * Is this provider usable?
 *
 * Cookie hint first, because it is instant and settles the common case; the last probe
 * otherwise. Deliberately never *negative* on cookies alone: a provider whose session does
 * not live in cookies would be reported as disconnected for the rest of time, which is
 * precisely the bug this function exists to avoid.
 */
export async function isSignedIn(id: BrowserProviderId): Promise<boolean> {
  if (await hasSessionCookies(id)) return true
  return probeResults.get(id) ?? false
}

/**
 * Is this provider *known* to be signed out — as opposed to merely unproven?
 *
 * The difference matters when a generation fails. `isSignedIn` answers "can I see evidence
 * of a login", and for Meta AI the answer is always no, because it keeps its session outside
 * the cookie jar. Using that as the explanation for a failure means every Meta AI error —
 * a changed layout, a slow image, a cancelled prompt — gets reported as "not signed in",
 * which sends the user off to fix an account that was never broken.
 *
 * Only a probe that actually said "no" counts here. Anything else leaves the real error
 * standing on its own.
 */
export function isKnownSignedOut(id: BrowserProviderId): boolean {
  return probeResults.get(id) === false
}

/**
 * Make a signed-in session survive restarts.
 *
 * Auth sites can hand their login cookies out as *session* cookies — no expiry date — and
 * Chromium keeps those in memory only, discarding them when the app quits. That is exactly
 * the "works today, signed out tomorrow" loop. This rewrites those cookies with a long
 * expiry so the login survives, which is what a normal browser's "keep me signed in" does
 * anyway. Cookies the site already gave an expiry to are left alone.
 */
export async function persistSessionCookies(id: BrowserProviderId): Promise<void> {
  const domains = new Set(SIGN_IN_COOKIE_DOMAINS[id])
  const store = sessionFor(id).cookies
  const now = Math.floor(Date.now() / 1000)
  const expiry = now + SESSION_COOKIE_LIFETIME_DAYS * 24 * 60 * 60

  let cookies: Cookie[] = []
  try {
    cookies = await store.get({})
  } catch {
    return
  }

  for (const cookie of cookies) {
    if (!cookie.domain) continue
    if (!domains.has(cookie.domain)) continue
    if (cookie.expirationDate) continue // already persistent
    try {
      await store.set({
        url: `https://${cookie.domain.startsWith('.') ? cookie.domain.slice(1) : cookie.domain}`,
        name: cookie.name,
        value: cookie.value,
        domain: cookie.domain,
        path: cookie.path || '/',
        secure: cookie.secure,
        httpOnly: cookie.httpOnly,
        sameSite: cookie.sameSite,
        expirationDate: expiry
      })
    } catch {
      // One un-copyable cookie must not abort the rest of the set.
    }
  }
}

/**
 * Sign-in windows, keyed by provider.
 *
 * Tracked in a map rather than found by window title: the `title` option only holds until
 * the page loads, after which `getTitle()` reports the page's own title ("Meta AI"), so
 * matching on it silently fails and opens a second window on every click.
 */
const signInWindows = new Map<BrowserProviderId, BrowserWindow>()

/**
 * Open the provider in a normal, visible window so the user can sign in. The partition is
 * what makes this worth doing: once they sign in here, every later generation run reuses it.
 */
export function openSignInWindow(id: BrowserProviderId, url: string): BrowserWindow {
  const existing = signInWindows.get(id)
  if (existing && !existing.isDestroyed()) {
    existing.focus()
    return existing
  }

  // Configure the session (user agent, …) BEFORE any page loads. Google blocks sign-in from
  // anything that looks like an embedded browser, and it looks at the first request's agent.
  sessionFor(id)

  const window = new BrowserWindow({
    width: 1100,
    height: 860,
    title: titleFor(id),
    backgroundColor: '#1a1917',
    autoHideMenuBar: true,
    webPreferences: {
      partition: partitionFor(id),
      // The page is a real web app the user signs into; it gets no bridge into the app.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  void window.loadURL(url)
  window.on('closed', () => {
    signInWindows.delete(id)
  })

  signInWindows.set(id, window)
  return window
}

function titleFor(id: BrowserProviderId): string {
  return id === 'metaai' ? 'Sign in — Meta AI' : 'Sign in — Google Gemini'
}

/**
 * One worker: a view, attached to the host, wired to the provider's partition.
 *
 * Loading a page costs seconds, so the pool hands the same view back out rather than
 * building a new one per scene. `imageConcurrency` decides how many exist at once.
 */
function createWorker(id: BrowserProviderId): WebContentsView {
  // The fingerprint must be set before the first page load, so the login is negotiated
  // under the Chrome agent, not switched mid-session.
  sessionFor(id)

  const view = new WebContentsView({
    webPreferences: {
      partition: partitionFor(id),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false
    }
  })

  // Spec §6, rule 10: a view paints white until its page renders, and it composites above
  // all HTML — an unpainted worker would look like a hole in the UI.
  view.setBackgroundColor('#1a1917')

  const host = hostWindow()
  host.contentView.addChildView(view)
  hostByView.set(view, host)

  // Fully inside the host, filling it — a child view whose bounds leave its parent is
  // clipped away and marked hidden, and a hidden page is a page that renders nothing
  // (see `hostWindow`). Workers stack at the same bounds: Electron does not compute
  // occlusion between sibling views, so a covered worker stays a visible page.
  view.setBounds({ x: 0, y: 0, ...WORKER_SIZE })

  allViews.add(view)
  view.webContents.once('destroyed', () => {
    allViews.delete(view)
    pool.set(
      id,
      (pool.get(id) ?? []).filter((entry) => entry !== view)
    )
  })

  return view
}

export function acquireWorker(id: BrowserProviderId): WebContentsView {
  const idle = (pool.get(id) ?? []).find(
    (view) => !view.webContents.isDestroyed() && !busy.has(view)
  )
  const view = idle ?? createWorker(id)

  if (!idle) pool.set(id, [...(pool.get(id) ?? []), view])
  busy.add(view)

  return view
}

/** Hand a view back. The caller is responsible for having stopped its page work. */
export function releaseWorker(view: WebContentsView): void {
  if (!view.webContents.isDestroyed()) busy.delete(view)
}

/** Quit must not leave worker views attached to a closing window. */
export function destroyAllWorkers(): void {
  for (const view of allViews) destroyView(view)
  allViews.clear()
  pool.clear()
  signInWindows.clear()
}

export type { BrowserProviderId }
