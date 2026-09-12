/**
 * Real Chrome, launched and driven by this app.
 *
 * Everything else in this folder drives a Chromium that Electron owns. That works right up
 * until a site decides embedded browsers are not welcome — Google's sign-in refuses them
 * outright, and no amount of user-agent shaping changes its mind (measured: a clean profile
 * with a Chrome user agent is still rejected at the identifier step). The only thing Google
 * accepts is Chrome itself.
 *
 * So for Gemini the app launches the user's installed Chrome against a profile of its own —
 * their normal browsing profile is never touched — and drives it over the DevTools Protocol.
 * To Google it is an ordinary Chrome; to the app it is a page it can type into and read.
 *
 * The browser is deliberately left running between runs. Signing in once is the whole point,
 * and a profile that outlives the app is what makes that true.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { app } from 'electron'
import { join } from 'node:path'
import { CHROME_DEBUG_PORT, CHROME_PROFILE_DIRNAME } from './config'
import { CdpConnection } from './cdp'

/** Chrome first, Edge second: both are Chromium and both speak the same protocol. */
const BROWSER_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  '%LOCALAPPDATA%\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
]

function expand(candidate: string): string {
  return candidate.replace(/%([^%]+)%/g, (_match, name: string) => process.env[name] ?? '')
}

export function findBrowserExecutable(): string | null {
  for (const candidate of BROWSER_CANDIDATES) {
    const path = expand(candidate)
    if (existsSync(path)) return path
  }
  return null
}

export function chromeProfileDir(): string {
  return join(app.getPath('userData'), CHROME_PROFILE_DIRNAME)
}

export function chromeRunningReason(): string {
  return findBrowserExecutable()
    ? ''
    : 'Chrome or Edge is not installed — install one, or use Meta AI for images.'
}

let connection: CdpConnection | null = null
let launcher: ChildProcess | null = null

interface VersionInfo {
  webSocketDebuggerUrl?: string
  Browser?: string
}

/** Ask the debugging port who it is. `null` means nothing is listening. */
async function probePort(): Promise<VersionInfo | null> {
  try {
    const response = await fetch(`http://127.0.0.1:${CHROME_DEBUG_PORT}/json/version`, {
      signal: AbortSignal.timeout(1_500)
    })
    if (!response.ok) return null
    return (await response.json()) as VersionInfo
  } catch {
    return null
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Connect to the app's Chrome, launching it first if it is not already up.
 *
 * `initialUrl` is only consulted on a cold start, where it becomes the page Chrome opens
 * with. A browser that is already running is left exactly as it is — the caller opens a tab
 * if it wants one — because this app reuses a browser from an earlier launch rather than
 * starting a second one on the same profile, which would only fight over the profile lock.
 */
export async function ensureChrome(initialUrl?: string): Promise<CdpConnection> {
  if (connection && !connection.isClosed) return connection

  let info = await probePort()

  if (!info) {
    const executable = findBrowserExecutable()
    if (!executable) throw new Error(chromeRunningReason())

    launcher = spawn(
      executable,
      [
        `--remote-debugging-port=${CHROME_DEBUG_PORT}`,
        `--user-data-dir=${chromeProfileDir()}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-features=Translate',
        initialUrl ?? 'about:blank'
      ],
      { detached: true, stdio: 'ignore' }
    )
    launcher.unref()

    // Chrome takes a few seconds to come up; the port answering is the ready signal.
    const deadline = Date.now() + 30_000
    while (!info && Date.now() < deadline) {
      await sleep(500)
      info = await probePort()
    }
  }

  if (!info?.webSocketDebuggerUrl) {
    throw new Error(
      'Chrome started but never opened its debugging port. Close the zBot Chrome window and try again.'
    )
  }

  connection = await CdpConnection.open(info.webSocketDebuggerUrl)
  return connection
}

export function chromeConnection(): CdpConnection | null {
  return connection
}

/** Drop the DevTools connection. Deliberately leaves the browser itself running. */
export function disconnectChrome(): void {
  connection?.close()
  connection = null
  launcher = null
  // A pooled tab's session id died with the connection, so none of them can be driven
  // again. The tabs stay open in Chrome; the next acquire opens its own.
  pooledTabs.length = 0
  activeTabs = 0
}

/**
 * Quit the app's Chrome and erase its profile.
 *
 * This is sign-out. The profile directory *is* the login — Chrome seals the cookie database
 * to itself, so there is no way to pluck one account out of it — and deleting the whole
 * profile is both the simplest and the most complete way to say "forget this account".
 *
 * Closing is asked for politely over the protocol first; the profile is only deleted once
 * the browser has actually gone, since a running Chrome rewrites its files on the way out
 * and would undo the deletion.
 */
export async function closeChrome(): Promise<void> {
  const cdp = connection
  connection = null
  launcher = null
  pooledTabs.length = 0
  activeTabs = 0

  if (cdp && !cdp.isClosed) {
    try {
      await cdp.call('Browser.close')
    } catch {
      // Closing the browser can kill the socket before the reply arrives. That is still a
      // successful close.
    }
    cdp.close()
  }

  // Wait for the port to stop answering, then for the process to release its files. Chrome
  // holds the profile open while it shuts down, and a delete that races it leaves a
  // half-removed directory that confuses the next launch.
  const deadline = Date.now() + 10_000
  while ((await probePort()) && Date.now() < deadline) await sleep(250)

  await removeProfileDir()
}

async function removeProfileDir(): Promise<void> {
  const dir = chromeProfileDir()
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await rm(dir, { recursive: true, force: true })
      return
    } catch {
      await sleep(500)
    }
  }
}

/**
 * Every cookie Chrome holds, straight from the browser.
 *
 * Read over the protocol rather than from the profile on disk, because Chrome seals its
 * cookie database with a key bound to `chrome.exe` — the file is unreadable to anyone else.
 * Asking Chrome itself sidesteps that entirely, and it is the honest way to ask "is an
 * account signed in here?".
 */
export async function chromeCookies(): Promise<Array<{ name: string; domain: string }>> {
  const cdp = await ensureChrome()
  const result = await cdp.call<{ cookies?: Array<{ name: string; domain: string }> }>(
    'Storage.getCookies'
  )
  return result.cookies ?? []
}

/** One browser tab, attached and ready to have scripts run in it. */
export class ChromeTab {
  /**
   * Image responses seen on this tab, by URL.
   *
   * Kept so the bytes can be asked for from the browser rather than re-fetched inside the
   * page. A page-side `fetch` of a generated image is blocked by the site's own
   * `Content-Security-Policy` — Gemini's `connect-src` does not list its image CDN, so the
   * `<img>` renders perfectly while `fetch()` of that exact same URL fails with
   * "Failed to fetch". The browser already has the bytes; this is how to get them.
   */
  private readonly imageRequests = new Map<string, string>()

  /** Set by `close()` — a closed tab must never be handed back out by the pool. */
  closed = false

  constructor(
    private readonly cdp: CdpConnection,
    readonly targetId: string,
    readonly sessionId: string
  ) {}

  /** Start recording image responses. Must be called before the page loads. */
  async enableImageCapture(): Promise<void> {
    await this.cdp.call('Network.enable', {}, this.sessionId)

    this.cdp.on(
      'Network.responseReceived',
      (params) => {
        if (params.type !== 'Image') return
        const response = params.response as { url?: string } | undefined
        const requestId = params.requestId as string | undefined
        if (response?.url && requestId) this.imageRequests.set(response.url, requestId)
      },
      this.sessionId
    )
  }

  /**
   * The bytes of an image the page has already loaded, straight from the browser.
   *
   * `null` means the response is no longer held (Chrome evicts bodies for resources it has
   * finished with), which is not an error — the caller falls back to fetching it in the page.
   */
  async imageBytesFromNetwork(src: string): Promise<Buffer | null> {
    const requestId = this.imageRequests.get(src)
    if (!requestId) return null

    try {
      const { body, base64Encoded } = await this.cdp.call<{ body: string; base64Encoded: boolean }>(
        'Network.getResponseBody',
        { requestId },
        this.sessionId
      )
      const bytes = Buffer.from(body, base64Encoded ? 'base64' : 'binary')
      return bytes.length ? bytes : null
    } catch {
      return null
    }
  }

  /**
   * Run a script and get its value, or `null` if there was nothing to get.
   *
   * Used by the polling in `chromePage.ts`, where "no value yet" and "it broke" both mean
   * "keep waiting". Anything that needs to tell those apart — downloading an image, say —
   * must use `evaluateRaw` instead, or the reason for a failure is thrown away here.
   */
  async evaluate<T>(expression: string): Promise<T | null> {
    return (await this.evaluateRaw<T>(expression)).value
  }

  /** Run a script, keeping the reason when it does not produce a value. */
  async evaluateRaw<T>(expression: string): Promise<{ value: T | null; error: string | null }> {
    try {
      const result = await this.cdp.call<{
        result?: { value?: T }
        exceptionDetails?: { text?: string; exception?: { description?: string } }
      }>('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, this.sessionId)

      if (result.exceptionDetails) {
        const detail =
          result.exceptionDetails.exception?.description ??
          result.exceptionDetails.text ??
          'the page threw while running the script'
        return { value: null, error: detail }
      }

      // A script that legitimately resolves to `undefined` or `null` is not an error — the
      // caller distinguishes that case by its own contract, not by this one.
      return { value: result.result?.value ?? null, error: null }
    } catch (err) {
      return { value: null, error: (err as Error).message }
    }
  }

  /**
   * Navigate and resolve once the load event has fired for *this* tab.
   *
   * Measured on this machine's connection, `gemini.google.com/app` can need well over a
   * minute for a cold load while the same network serves the API endpoints in seconds —
   * so the web-app timeout is generous on purpose, because a timeout here is not just an
   * error: the user sees the whole app die (see the catch below).
   */
  async navigate(url: string, timeoutMs = 180_000): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined
    let off: () => void = () => undefined

    const loaded = new Promise<void>((resolve, reject) => {
      timer = setTimeout(() => {
        off()
        reject(new Error(`Timed out loading ${url}.`))
      }, timeoutMs)

      off = this.cdp.on(
        'Page.loadEventFired',
        () => {
          clearTimeout(timer)
          off()
          resolve()
        },
        this.sessionId
      )
    })

    // If the navigate *call* below fails first, this timer is still armed — and when it
    // later rejects a promise nobody is awaiting anymore, Node exits the whole app on the
    // unhandled rejection. A derived catch marks it handled; the real `await` below still
    // sees the rejection and surfaces it as a normal error.
    loaded.catch(() => undefined)

    try {
      await this.cdp.call('Page.navigate', { url }, this.sessionId)
      await loaded
    } finally {
      clearTimeout(timer)
      off()
    }
  }

  async close(): Promise<void> {
    this.closed = true
    try {
      await this.cdp.call('Target.closeTarget', { targetId: this.targetId })
    } catch {
      // A tab that has already gone is not a problem worth reporting.
    }
  }
}

/**
 * Open a fresh tab.
 *
 * Created empty, attached, and only then pointed at the URL — attaching after a real
 * navigation races the load event, and a missed event would look exactly like a page that
 * never loaded.
 *
 * `background` keeps the tab from stealing focus and pulling Chrome to the front. Generation
 * normally works through `acquireTab`, so this direct route is for sign-in pages, probes and
 * tests — places where a one-off tab that closes afterwards is exactly what is wanted; a
 * browser that jumps in front of whatever the user is doing is unusable either way.
 */
export async function openTab(
  url?: string,
  options: { background?: boolean } = {}
): Promise<ChromeTab> {
  const cdp = await ensureChrome()

  const { targetId } = await cdp.call<{ targetId: string }>('Target.createTarget', {
    url: 'about:blank',
    background: options.background ?? false
  })

  const { sessionId } = await cdp.call<{ sessionId: string }>('Target.attachToTarget', {
    targetId,
    flatten: true
  })

  await cdp.call('Page.enable', {}, sessionId)
  await cdp.call('Runtime.enable', {}, sessionId)

  const tab = new ChromeTab(cdp, targetId, sessionId)
  // Before the navigation, or the image responses are missed and the bytes have to be
  // re-fetched inside the page — which is exactly what the site's CSP blocks.
  await tab.enableImageCapture()

  if (url) await tab.navigate(url)
  return tab
}

/** Is the browser currently listening on the debugging port? */
export async function isChromeRunning(): Promise<boolean> {
  return (await probePort()) !== null
}

// ---------------------------------------------------------------------------
// warm-tab pool
// ---------------------------------------------------------------------------

/** Tabs parked between scenes, with the site each was opened for. */
const pooledTabs: Array<{ tab: ChromeTab; url: string }> = []

/** Scenes waiting for a tab of their own. */
const tabWaiters: Array<() => void> = []

let activeTabs = 0

/**
 * How many tabs may be generating at once. One is deliberate: the scenes of a video then
 * share a single Gemini conversation — same chat, consistent characters, no reload between
 * images — and on this machine one warm tab working through the queue beats several cold
 * loads of a web app this heavy. `ZBOT_CHROME_TABS` raises it for experiments.
 */
function maxTabs(): number {
  const parsed = Number(process.env.ZBOT_CHROME_TABS)
  return Number.isFinite(parsed) && parsed >= 1 ? Math.floor(parsed) : 1
}

/**
 * Take a tab that is on `url`, creating one only when no parked tab can serve.
 *
 * A returned tab is always on the site already — either it was parked there by an earlier
 * scene, or it was just opened and navigated there. What the caller gets back is a page
 * with its conversation intact, which is the point: the next scene continues the same chat
 * instead of paying a cold load for a fresh one.
 */
export async function acquireTab(
  url: string,
  options: { background?: boolean } = {}
): Promise<ChromeTab> {
  const cdp = await ensureChrome()

  for (;;) {
    // A parked tab whose target has since gone — the user closed it, the browser was
    // restarted — must not be handed out: its session id fails every call made on it.
    const parkedAt = pooledTabs.findIndex((entry) => entry.url === url && !entry.tab.closed)
    if (parkedAt >= 0) {
      const { tab } = pooledTabs.splice(parkedAt, 1)[0]
      try {
        await cdp.call('Target.getTargetInfo', { targetId: tab.targetId })
        return tab
      } catch {
        await tab.close()
      }
    }

    if (activeTabs < maxTabs()) {
      activeTabs++
      try {
        return await openTab(url, options)
      } catch (err) {
        activeTabs--
        throw err
      }
    }

    await new Promise<void>((resolve) => tabWaiters.push(resolve))
  }
}

/**
 * Hand a tab back. A healthy tab is parked for the next scene; anything else is closed.
 *
 * A tab that failed mid-generation may still have a prompt in flight, and handing it to the
 * next scene would let that scene's "wait for a new image" snap up the previous scene's
 * image. Warm reuse is for the success path only.
 */
export async function releaseTab(tab: ChromeTab, url: string, healthy: boolean): Promise<void> {
  activeTabs = Math.max(0, activeTabs - 1)

  if (healthy && !tab.closed && pooledTabs.length < maxTabs()) {
    pooledTabs.push({ tab, url })
  } else {
    await tab.close()
  }

  // Wake the next scene in line — it will find the tab just parked, or open one of its own.
  tabWaiters.shift()?.()
}
