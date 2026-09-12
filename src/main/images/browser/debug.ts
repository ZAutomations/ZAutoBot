/**
 * Page ground-truth dump for diagnosing a broken probe.
 *
 * When a heuristic like "find the biggest editable box" fails, guessing at a new selector
 * is a coin flip. This loads the page the same way the provider does and writes down what
 * is *actually there* — the final URL (catches redirects to a login wall), every editable
 * element with its size, whether the page looks signed in from its own text, and which
 * cookies exist. That report is enough to tell "signed out" from "the composer moved"
 * apart without a second guess.
 */
import type { WebContents } from 'electron'
import { chromeCookies, findBrowserExecutable, isChromeRunning, openTab } from './chrome'
import { HOME_URL, MIN_IMAGE_EDGE_PX, SIGN_IN_COOKIES, type BrowserProviderId } from './config'
import { acquireWorker, releaseWorker, sessionFor } from './session'
import { loadPage, withTimeout } from './page'

/**
 * Exported because real Chrome is dumped with the same script.
 *
 * The whole value of a dump is that it reports what the *provider* would have seen. Two
 * scripts would eventually describe two different pages and the report would stop meaning
 * anything.
 */
export const PAGE_DUMP_SCRIPT = `(() => {
  const out = [];
  out.push('URL: ' + location.href);
  out.push('Title: ' + document.title);
  out.push('ReadyState: ' + document.readyState);
  out.push('Visibility: ' + document.visibilityState);
  out.push('UserAgent: ' + navigator.userAgent);
  out.push('Body chars: ' + (document.body ? document.body.innerText.length : -1));

  const frames = [...document.querySelectorAll('iframe')];
  out.push('Iframes: ' + frames.length);
  for (const frame of frames) {
    out.push('  iframe -> ' + (frame.src || frame.srcdoc ? '[srcdoc]' : '(no src)'));
  }

  const shadowHosts = [...document.querySelectorAll('*')].filter(
    (el) => el.shadowRoot && el.shadowRoot.querySelector('textarea, [contenteditable]')
  );
  out.push('Shadow hosts containing an editor: ' + shadowHosts.length);

  const editable = [...document.querySelectorAll(
    'textarea, [contenteditable="true"], [contenteditable=""]'
  )];
  out.push('Editable elements: ' + editable.length);
  for (const el of editable.slice(0, 20)) {
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    out.push(
      '  ' + el.tagName.toLowerCase() +
      ' rect=' + Math.round(rect.width) + 'x' + Math.round(rect.height) +
      ' vis=' + style.visibility + ' disp=' + style.display +
      ' ph=' + (el.getAttribute('placeholder') || '') +
      ' aria=' + (el.getAttribute('aria-label') || '')
    );
  }

  const text = (document.body ? document.body.innerText : '').toLowerCase();
  const markers = ['sign in', 'log in', 'continue', 'password', 'email or phone', 'welcome back'];
  const found = markers.filter((marker) => text.includes(marker));
  out.push('Login-wall markers: ' + (found.length ? found.join(', ') : '(none)'));
  out.push('Headline: ' + (document.title.length ? document.title.slice(0, 120) : ''));

  return out.join('\\n');
})()`

async function dumpFrom(page: WebContents, id: BrowserProviderId): Promise<string> {
  const lines: string[] = []
  lines.push(`--- ${id} page dump ---`)

  try {
    // Raced against a deadline for the same reason every other page call is: a dump that
    // hangs is worse than no dump, because it is the thing being relied on to explain a hang.
    const script = (await withTimeout(
      page.executeJavaScript(PAGE_DUMP_SCRIPT, true) as Promise<string>,
      15_000,
      '(page did not answer within 15s — it is wedged, not merely slow)'
    )) as string
    lines.push(script)
  } catch {
    lines.push('(page script failed to run — page may still be loading or crashed)')
  }

  lines.push('--- cookies (names, P=persistent / S=session-only) ---')
  try {
    const cookies = await sessionFor(id).cookies.get({})
    const seen = new Map<string, string>()
    for (const cookie of cookies) {
      // A cookie is persistent only when it carries an expiry date; session cookies are
      // kept in memory alone and vanish with the app.
      const tag = cookie.expirationDate ? 'P' : 'S'
      const prev = seen.get(cookie.name)
      seen.set(cookie.name, prev === 'P' || tag === 'P' ? 'P' : 'S')
    }
    const names = [...seen.entries()].sort((a, b) => a[0].localeCompare(b[0]))
    lines.push(
      names.length ? names.map(([name, tag]) => `${name}=${tag}`).join(', ') : '(none)'
    )
  } catch {
    lines.push('(cookie read failed)')
  }

  return lines.join('\n')
}

/**
 * Load the provider's page in a worker view and capture what is actually there.
 *
 * Unlike the probe, this never throws on a missing composer — a partial or signed-out page
 * is exactly the interesting case, and the report describes it either way.
 */
export async function dumpProviderPage(id: BrowserProviderId): Promise<string> {
  const view = acquireWorker(id)
  try {
    await loadPage(view.webContents, HOME_URL[id])
    // Give the page a beat to settle, but never long enough to look like the probe hanging.
    await new Promise((resolve) => setTimeout(resolve, 8_000))
    return await dumpFrom(view.webContents, id)
  } catch (err) {
    return `--- ${id} page dump ---\nLoad failed: ${(err as Error).message}`
  } finally {
    releaseWorker(view)
  }
}

/**
 * The same report, from real Chrome.
 *
 * Gemini no longer runs in an Electron window, so `dumpProviderPage` would describe a
 * partition nothing uses — a report about the wrong browser is worse than no report. This
 * opens a background tab in the app's Chrome and reads the same facts, plus the Chrome-only
 * ones (which executable, whether it is running at all), because those are the failure modes
 * this driver actually has.
 */
export async function dumpChromePage(id: BrowserProviderId): Promise<string> {
  const lines: string[] = [`--- ${id} dump (real Chrome) ---`]
  lines.push(`Chrome executable: ${findBrowserExecutable() ?? '(not found)'}`)
  lines.push(`Chrome running: ${(await isChromeRunning()) ? 'yes' : 'no'}`)

  let tab: Awaited<ReturnType<typeof openTab>> | null = null
  try {
    tab = await openTab(undefined, { background: true })
    await tab.navigate(HOME_URL[id])

    // Same settle time as the Electron dump, for the same reason.
    await new Promise((resolve) => setTimeout(resolve, 8_000))
    lines.push((await tab.evaluate<string>(PAGE_DUMP_SCRIPT)) ?? '(page script returned nothing)')
  } catch (err) {
    lines.push(`Load failed: ${(err as Error).message}`)
  } finally {
    await tab?.close()
  }

  lines.push(`--- cookies (Chrome's own store) ---`)
  try {
    const wanted = new Set(SIGN_IN_COOKIES[id])
    const cookies = await chromeCookies()
    const google = cookies.filter((cookie) => cookie.domain.endsWith('google.com'))
    const signIn = google.filter((cookie) => wanted.has(cookie.name))
    lines.push(`google.com cookies: ${google.length}`)
    lines.push(
      signIn.length
        ? `sign-in cookies: ${signIn.map((cookie) => cookie.name).sort().join(', ')}`
        : 'sign-in cookies: (none — no Google account in this profile)'
    )
  } catch (err) {
    lines.push(`(cookie read failed: ${(err as Error).message})`)
  }

  lines.push(`--- reference ---`)
  lines.push(`An image counts as generated at >= ${MIN_IMAGE_EDGE_PX}px on its longest edge.`)

  return lines.join('\n')
}
