/**
 * Browser image provider check (development only).
 *
 *     npm run build
 *     ZBOT_IMAGE=metaai npx electron .
 *     ZBOT_IMAGE=gemini npx electron .
 *
 * This exercises everything about the browser providers that does **not** need a signed-in
 * account: the persistent partition, the off-screen worker window, loading the real page,
 * the sign-in probe, and teardown. That matters because those are the parts a login cannot
 * fix — if the page never loads or the window never tears down, no amount of signing in
 * helps, and it is much easier to tell the two apart here than inside a render run.
 *
 * It deliberately stops short of generating: without a session there is no image to wait
 * for, and pretending otherwise would only produce a confusing timeout.
 *
 * Never runs unless `ZBOT_IMAGE` is set.
 */
import { app, BrowserWindow } from 'electron'
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import {
  HOME_URL,
  PARTITION_BY_PROVIDER,
  SIGN_IN_COOKIES,
  CHROME_DEBUG_PORT,
  type BrowserProviderId
} from '../images/browser/config'
import { probeProvider, signOut } from '../images/browser/browserProvider'
import {
  acquireTab,
  chromeProfileDir,
  chromeRunningReason,
  ensureChrome,
  findBrowserExecutable,
  openTab,
  releaseTab,
  chromeCookies
} from '../images/browser/chrome'
import { ChromePage } from '../images/browser/chromePage'
import { chromeGeminiProvider, probe as probeChrome } from '../images/browser/chromeProvider'
import { dumpProviderPage } from '../images/browser/debug'
import { acquireWorker, destroyAllWorkers, isSignedIn, releaseWorker, sessionFor } from '../images/browser/session'
import { findComposer, waitForReady } from '../images/browser/page'
import { getImageProvider } from '../images/registry'
import { loadSettings } from '../store/settings'

const PROBE_TIMEOUT_MS = 45_000

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Where exactly does Google refuse?
 *
 *     ZBOT_GOOGLE_GATE=provider npx electron . --user-data-dir=<throwaway>
 *     ZBOT_GOOGLE_GATE=plain    npx electron . --user-data-dir=<throwaway>
 *     ZBOT_GOOGLE_GATE=form     npx electron . --user-data-dir=<throwaway>
 *
 * Google refuses to sign in clients it decides are embedded ("This browser or app may not be
 * secure"). The verdict is reached from the fingerprint, so it can be probed with no account
 * at all — which is the only way to tell "this client is refused" apart from "this session or
 * account is refused".
 *
 * `provider` uses the real provider partition (Chrome user agent, client hints stripped),
 * `plain` is an untouched Electron window. `form` goes one step further and submits a
 * deliberately non-existent address, which is what separates the two possible refusals:
 *   - "Couldn't find your Google Account"  → the client is fine, the refusal is account-side
 *   - "This browser or app may not be secure" → the client itself is refused
 * No real credentials are involved; the address is random and belongs to nobody.
 */
export async function runGoogleGateTest(): Promise<void> {
  const mode = (process.env['ZBOT_GOOGLE_GATE'] ?? 'provider').trim()
  console.log(`[gate] userData: ${app.getPath('userData')}`)
  console.log(`[gate] mode: ${mode}`)

  // Gemini no longer has an Electron partition (it runs in real Chrome — see
  // `chromeProvider.ts`), so every mode here is a plain window on the old provider
  // partition. The question this test answered is settled; it stays as a record.
  const window = new BrowserWindow({
    width: 1200,
    height: 900,
    show: false,
    webPreferences: {
      partition: PARTITION_BY_PROVIDER.gemini,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  const close = (): void => {
    if (!window.isDestroyed()) window.destroy()
    destroyAllWorkers()
  }

  const snapshot = async (): Promise<{ url: string; title: string; text: string }> => {
    return (await window.webContents.executeJavaScript(
      `(() => ({
        url: location.href,
        title: document.title,
        text: (document.body ? document.body.innerText : '').trim()
      }))()`,
      true
    )) as { url: string; title: string; text: string }
  }

  /** Poll until the page has actually painted something, rather than trusting one snapshot. */
  const waitForText = async (timeoutMs: number): Promise<string> => {
    const deadline = Date.now() + timeoutMs
    let text = ''
    while (Date.now() < deadline) {
      text = (await snapshot()).text
      if (text.length > 20) return text
      await new Promise((resolve) => setTimeout(resolve, 1_000))
    }
    return text
  }

  const verdict = (text: string): string => {
    if (/may not be secure|couldn.t sign you in|unsupported browser/i.test(text)) {
      return 'BLOCKED — Google refused this client'
    }
    if (/couldn.t find your google account|find your google account/i.test(text)) {
      return 'FORM OK — Google looked the address up, so the client is accepted'
    }
    if (/forgot email|email or phone|use your google account|sign in/i.test(text)) {
      return 'FORM SHOWN — sign-in page rendered normally'
    }
    return `INCONCLUSIVE — page text was ${text.length} chars, no known marker`
  }

  try {
    console.log('[gate] loading the Google sign-in gate…')
    await window.loadURL(
      'https://accounts.google.com/ServiceLogin?continue=https%3A%2F%2Fgemini.google.com%2Fapp'
    )
    await waitForReady(window.webContents)

    const first = await snapshot()
    const firstText = await waitForText(20_000)
    console.log(`[gate] url: ${first.url}`)
    console.log(`[gate] title: ${first.title}`)
    console.log(`[gate] agent: ${await window.webContents.executeJavaScript('navigator.userAgent', true)}`)
    console.log(`[gate] initial page (${firstText.length} chars):\n${firstText.slice(0, 500)}`)
    console.log(`[gate] initial → ${verdict(firstText)}`)

    if (mode === 'form') {
      const typed = await window.webContents.executeJavaScript(
        `(() => {
          const input = document.querySelector('input[type="email"], input[name="identifier"]');
          if (!input) return 'no email field';
          input.focus();
          input.value = 'zbot.gate.probe.9f3a1c@gmail.com';
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
          const next = document.querySelector('#identifierNext button, #identifierNext')
            || [...document.querySelectorAll('button')].find((b) => /next/i.test(b.textContent || ''));
          if (!next) return 'no next button';
          next.click();
          return 'submitted';
        })()`,
        true
      )
      console.log(`[gate] submit: ${typed}`)

      await new Promise((resolve) => setTimeout(resolve, 8_000))
      const after = await snapshot()
      const afterText = await waitForText(10_000)
      console.log(`[gate] after-submit url: ${after.url}`)
      console.log(`[gate] after-submit page (${afterText.length} chars):\n${afterText.slice(0, 500)}`)
      console.log(`[gate] after-submit → ${verdict(afterText)}`)
    }
  } catch (err) {
    console.log(`[gate] ${mode.toUpperCase()} → ERROR — ${(err as Error).message}`)
  } finally {
    close()
  }

  app.exit(0)
}

/**
 * Report what a provider's session actually contains.
 *
 *     ZBOT_IMAGE_SESSION=metaai npx electron .
 *
 * Prints cookie names and browser-storage key names only — never a value. Session tokens
 * are the one thing that must not end up in a log, and a name is all this needs to answer
 * the question it exists for: when the app says "not signed in" for an account that is
 * plainly signed in, is the proof in a cookie, in localStorage, or somewhere else entirely?
 */
export async function runSessionDump(id: BrowserProviderId): Promise<void> {
  console.log(`[session] partition: ${PARTITION_BY_PROVIDER[id]}`)
  console.log(`[session] userData: ${app.getPath('userData')}`)

  const report = async (when: string): Promise<void> => {
    const cookies = await sessionFor(id).cookies.get({})
    console.log(`[session] cookies ${when}: ${cookies.length}`)
    for (const cookie of cookies) {
      console.log(`[session]   ${cookie.domain}  ${cookie.name}  (${cookie.value.length} chars)`)
    }
  }

  await report('at rest')

  const view = acquireWorker(id)
  try {
    await view.webContents.loadURL(HOME_URL[id])
    await waitForReady(view.webContents)
    await report('after load')

    const storage = await view.webContents.executeJavaScript(
      `(() => {
        const keys = (store) => {
          try { return Object.keys(store); } catch { return ['<blocked>']; }
        };
        return { local: keys(localStorage), session: keys(sessionStorage) };
      })()`,
      true
    )

    console.log(`[session] localStorage keys (${storage.local.length}): ${storage.local.join(', ')}`)
    console.log(
      `[session] sessionStorage keys (${storage.session.length}): ${storage.session.join(', ')}`
    )
  } finally {
    releaseWorker(view)
    destroyAllWorkers()
  }

  app.exit(0)
}

/**
 * The Chrome driver, exercised end to end.
 *
 *     ZBOT_CHROME=1 npx electron .
 *
 * Gemini is no longer driven by a browser this app owns, so `ZBOT_IMAGE=gemini` no longer
 * describes it — this does. Everything here runs without an account: launch Chrome on the
 * app's own profile, connect over the DevTools protocol, read the cookie store, open a tab,
 * load Gemini, find the composer, close the tab.
 *
 * The one thing it cannot prove is sign-in, which needs a human. It prints exactly what it
 * found so that "no account yet" and "Chrome never started" are never confused.
 *
 * Chrome is deliberately left running, because that is what the app does and because closing
 * it here would delete nothing but would cost the next launch ten seconds.
 */
export async function runChromeTest(): Promise<void> {
  const fail = (message: string): void => {
    console.error(`\n[chrome] FAIL — ${message}\n`)
    app.exit(1)
  }

  const executable = findBrowserExecutable()
  console.log(`[chrome] executable: ${executable ?? '(none found)'}`)
  if (!executable) {
    fail(chromeRunningReason())
    return
  }
  console.log(`[chrome] profile: ${chromeProfileDir()}`)
  console.log(`[chrome] port: ${CHROME_DEBUG_PORT}`)

  // 1. Connect — launching Chrome the first time, reusing it afterwards.
  const started = Date.now()
  try {
    await ensureChrome()
  } catch (err) {
    fail(`could not start Chrome — ${(err as Error).message}`)
    return
  }
  console.log(`[chrome] connected in ${((Date.now() - started) / 1000).toFixed(1)}s`)

  // 2. The cookie store, read through Chrome because the file on disk is sealed to it.
  try {
    const cookies = await chromeCookies()
    const google = cookies.filter((cookie) => cookie.domain.endsWith('google.com'))
    const wanted = new Set(SIGN_IN_COOKIES.gemini)
    const signIn = google.filter((cookie) => wanted.has(cookie.name))
    console.log(`[chrome] cookies: ${cookies.length} total, ${google.length} on google.com`)
    console.log(
      `[chrome] sign-in cookies: ${signIn.length ? signIn.map((c) => c.name).sort().join(', ') : '(none — no Google account signed in)'}`
    )
  } catch (err) {
    fail(`cookie read failed — ${(err as Error).message}`)
    return
  }

  // 3. A real tab on the real page. This is what a generation does, minus the account.
  const tabStarted = Date.now()
  let tab: Awaited<ReturnType<typeof openTab>> | null = null
  try {
    tab = await openTab(undefined, { background: true })
    await tab.navigate(HOME_URL.gemini)
    console.log(`[chrome] loaded Gemini in ${((Date.now() - tabStarted) / 1000).toFixed(1)}s`)

    const url = await tab.evaluate<string>('location.href')
    const title = await tab.evaluate<string>('document.title')
    const agent = await tab.evaluate<string>('navigator.userAgent')
    console.log(`[chrome] url: ${url}`)
    console.log(`[chrome] title: ${JSON.stringify(title)}`)
    console.log(`[chrome] agent: ${agent}`)
    console.log(`[chrome] detached: ${/HeadlessChrome/.test(agent ?? '') ? 'YES — headless, Google may refuse' : 'no'}`)

    if (!url || url === 'about:blank') {
      fail('the tab never navigated')
      return
    }

    // 4. The shared composer heuristic, running against a real Chrome tab for the first time.
    const page = new ChromePage(tab)
    try {
      const found = (await page.findComposer(undefined, 20_000)) as { tag: string }
      console.log(`[chrome] prompt box: found (${found.tag})`)
    } catch (err) {
      console.log(`[chrome] prompt box: not found — ${(err as Error).message}`)
      fail('the composer heuristic did not find Gemini\'s prompt box')
      return
    }
  } catch (err) {
    fail(`tab work failed — ${(err as Error).message}`)
    return
  } finally {
    await tab?.close()
  }

  // 5. The pool: with one tab allowed, a second acquire must wait for the first to be
  //    released and then receive *the same tab* — warm, no reload. This is the single-chat
  //    guarantee generation now rests on, so it is proved here, not assumed.
  try {
    const first = await acquireTab(HOME_URL.gemini, { background: true })
    const secondPromise = acquireTab(HOME_URL.gemini, { background: true })
    await sleep(300) // give the second acquire every chance to wrongly open a tab of its own
    await releaseTab(first, HOME_URL.gemini, true)
    const second = await secondPromise
    const reused = second.targetId === first.targetId
    console.log(`[chrome] pool: second acquire ${reused ? 'reused the same tab' : 'GOT A DIFFERENT TAB — the pool is broken'}`)
    await releaseTab(second, HOME_URL.gemini, true)
    if (!reused) {
      fail('the tab pool did not reuse the warm tab')
      return
    }
  } catch (err) {
    fail(`pool work failed — ${(err as Error).message}`)
    return
  }

  // 6. The provider and probe must answer rather than throw, account or no account.
  const settings = await loadSettings()
  console.log(`[chrome] isReady: ${await chromeGeminiProvider.isReady(settings)}`)
  console.log(`[chrome] readyReason: ${chromeGeminiProvider.readyReason(settings)}`)

  const probe = await probeChrome()
  console.log(`[chrome] probe: ${probe.ok ? 'ok' : 'not ready'} — ${probe.message}`)

  console.log(
    `\n[chrome] PASS — the Chrome driver works. Sign in from Settings (Connect… on the Gemini row) to finish the job.\n`
  )
  app.exit(0)
}

/**
 * Generate one real image and report exactly what happened.
 *
 *     ZBOT_IMAGE_GEN=metaai npx electron .
 *     ZBOT_IMAGE_GEN=gemini npx electron .
 *
 * `ZBOT_IMAGE` proves the plumbing up to the login wall; this goes through it. It is the
 * only check that exercises the part of a provider most likely to break — waiting for the
 * picture and pulling its bytes out of the page — and the only one whose failures are worth
 * reading in full. So it prints the complete error and the stack, not a summary.
 */
export async function runImageGenTest(): Promise<void> {
  const id = (process.env['ZBOT_IMAGE_GEN'] ?? '').trim()
  const provider = getImageProvider(id)
  if (!provider) {
    console.error(`\n[gen] FAIL — "${id}" is not a registered image provider\n`)
    app.exit(1)
    return
  }

  const outputPath = join(app.getPath('userData'), 'preview', `gen-${id}.png`)
  console.log(`[gen] provider: ${id}`)
  console.log(`[gen] output: ${outputPath}`)

  // Every page call is bounded, so in theory this test cannot hang. The two 88-minute runs
  // that inspired this timer were also "impossible" — an unbounded call was missed each
  // time. The watchdog is the proof that cannot happen again: if it fires, the run was
  // stuck somewhere no deadline covers, and it says so instead of sitting silent.
  const WATCHDOG_MS = 8 * 60_000
  const watchdog = setTimeout(() => {
    console.error(`\n[gen] WATCHDOG — no result within ${WATCHDOG_MS / 60_000} minutes. A page call is stuck with no deadline.`)
    destroyAllWorkers()
    app.exit(2)
  }, WATCHDOG_MS)
  watchdog.unref?.()

  const started = Date.now()
  try {
    await provider.generate(
      {
        prompt: 'A calm ocean at sunrise, wide open water, soft light',
        outputPath,
        index: 0,
        mood: 'calm'
      },
      await loadSettings()
    )
  } catch (err) {
    console.error(`\n[gen] FAILED after ${((Date.now() - started) / 1000).toFixed(1)}s`)
    console.error(`[gen] ${(err as Error).message}`)

    // A timeout says the page never reached a usable state, and the dump says *what state it
    // did reach*. Without this the same failure is indistinguishable from a changed layout,
    // a login wall, or a page that never loaded at all.
    if (id === 'metaai') {
      console.error('[gen] --- page as it actually was ---')
      try {
        console.error(await dumpProviderPage('metaai'))
      } catch (dumpErr) {
        console.error(`[gen] (dump failed: ${(dumpErr as Error).message})`)
      }
    }

    destroyAllWorkers()
    clearTimeout(watchdog)
    app.exit(1)
    return
  }

  const { size } = await stat(outputPath).catch(() => ({ size: 0 }))
  console.log(`[gen] wrote ${size} bytes in ${((Date.now() - started) / 1000).toFixed(1)}s`)
  destroyAllWorkers()
  clearTimeout(watchdog)
  console.log(size >= 8_000 ? '\n[gen] PASS — a real image came out\n' : '\n[gen] SUSPECT — file is too small to be an image\n')
  app.exit(size >= 8_000 ? 0 : 1)
}

export async function runImageTest(): Promise<void> {
  const id = (process.env['ZBOT_IMAGE'] ?? '').trim() as BrowserProviderId

  const fail = (message: string): void => {
    console.error(`\n[image] FAIL — ${message}\n`)
    app.exit(1)
  }

  if (id !== 'metaai' && id !== 'gemini') {
    fail(`ZBOT_IMAGE must be "metaai" or "gemini", got "${id}".`)
    return
  }

  console.log(`[image] provider: ${id}`)
  console.log(`[image] partition: ${PARTITION_BY_PROVIDER[id]}`)
  console.log(`[image] url: ${HOME_URL[id]}`)

  // The partition persists by design, so a check of the signed-out path needs a clean slate
  // or it inherits whatever the last run left behind. Opt-in, because this is also how a
  // real user's sign-in would be destroyed.
  if (process.env['ZBOT_IMAGE_RESET']) {
    await signOut(id)
    console.log('[image] session cleared (ZBOT_IMAGE_RESET)')
  }

  // 1. The registry must hand back a real provider, not a placeholder.
  const provider = getImageProvider(id)
  if (!provider) {
    fail(`${id} is not registered — the registry is missing it.`)
    return
  }
  console.log('[image] registered: yes')

  // 2. A session must exist for the partition, even before anyone signs in.
  const ses = sessionFor(id)
  if (!ses) {
    fail(`no session for partition ${PARTITION_BY_PROVIDER[id]}`)
    return
  }
  console.log('[image] session: ok')

  // 3. Signed in or not, `isReady` must answer rather than throw.
  const settings = await loadSettings()
  const signedIn = await isSignedIn(id)
  const ready = await provider.isReady(settings)
  console.log(`[image] signed in: ${signedIn} (isReady: ${ready})`)

  // 4. The real work: attach a worker view and load the actual page.
  const view = acquireWorker(id)
  try {
    console.log('[image] loading the real page…')
    const started = Date.now()
    await view.webContents.loadURL(HOME_URL[id])
    await waitForReady(view.webContents)
    const title = await view.webContents.executeJavaScript('document.title', true)
    const url = view.webContents.getURL()
    console.log(`[image] loaded in ${((Date.now() - started) / 1000).toFixed(1)}s`)
    console.log(`[image] title: ${JSON.stringify(title)}`)
    console.log(`[image] url: ${url}`)

    if (!url || url === 'about:blank') {
      fail('the page did not navigate — the window never really loaded anything')
      return
    }

    // 5. Whether a composer is reachable is the thing a sign-in changes, so both outcomes
    //    are informative here — but a *crash* is not, and that is what this proves.
    let composer: string
    try {
      const found = await findComposer(view.webContents, undefined)
      composer = `found (${found.tag})`
    } catch (err) {
      composer = `not found — ${(err as Error).message}`
    }
    console.log(`[image] prompt box: ${composer}`)

    if (signedIn && composer.startsWith('not found')) {
      fail('signed in, yet no prompt box — the page layout has probably changed')
      return
    }

    // 5b. Workers stack at the same bounds inside the host window. If a covered sibling
    //     were marked hidden, parallel scenes would render nothing exactly like the
    //     off-bounds workers did — the whole `imageConcurrency` design rests on this.
    const second = acquireWorker(id)
    try {
      await second.webContents.loadURL(HOME_URL[id])
      await waitForReady(second.webContents)
      const visibilities = await Promise.all([
        view.webContents.executeJavaScript('document.visibilityState', true),
        second.webContents.executeJavaScript('document.visibilityState', true)
      ])
      console.log(
        `[image] stacked workers visibility: ${visibilities.join(', ')}${visibilities.every((v) => v === 'visible') ? ' — ok' : ' — COVERED WORKERS GO HIDDEN, concurrency is broken'}`
      )
      if (!visibilities.every((v) => v === 'visible')) {
        fail('covered stacked workers are marked hidden — parallel image generation would stall')
        return
      }
    } finally {
      releaseWorker(second)
    }
  } finally {
    releaseWorker(view)
  }

  // 6. The probe path must answer cleanly rather than hang, signed in or not. A signed-out
  //    session has nothing to wait for, so a slow answer here is itself the bug.
  const cookieStarted = Date.now()
  await isSignedIn(id)
  console.log(`[image] isSignedIn took ${Date.now() - cookieStarted}ms`)

  const probeStarted = Date.now()
  const probe = await Promise.race([
    probeProvider(id),
    new Promise<{ ok: boolean; message: string }>((resolve) =>
      setTimeout(
        () => resolve({ ok: false, message: `probe did not finish within ${PROBE_TIMEOUT_MS}ms` }),
        PROBE_TIMEOUT_MS
      )
    )
  ])
  console.log(`[image] probe took ${Date.now() - probeStarted}ms`)
  console.log(`[image] probe: ${probe.ok ? 'ok' : 'not ready'} — ${probe.message}`)

  // 7. Nothing may survive teardown, or the app never exits.
  destroyAllWorkers()
  console.log('[image] teardown: ok')

  console.log(
    `\n[image] PASS — ${id} plumbing works${signedIn ? ' and the session is signed in' : ' (no session yet — sign in from Settings, then re-run)'}\n`
  )
  app.exit(0)
}
