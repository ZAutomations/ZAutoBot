/**
 * Shared facts about the two browser-driven image providers.
 *
 * Kept in one file because both the session layer and the providers need them, and because
 * everything here is the sort of thing that has to be corrected when the web apps change.
 */
export type BrowserProviderId = 'metaai' | 'gemini'

/** Persistent, so signing in once survives every later run. */
export const PARTITION_BY_PROVIDER: Record<BrowserProviderId, string> = {
  metaai: 'persist:metaai',
  gemini: 'persist:gemini'
}

export const HOME_URL: Record<BrowserProviderId, string> = {
  metaai: 'https://www.meta.ai/',
  gemini: 'https://gemini.google.com/app'
}

/**
 * Where Connect… opens, when that differs from where generation goes.
 *
 * Gemini's app page shows a composer to signed-out visitors, so landing there leaves the user
 * hunting for the sign-in link. This goes straight to Google's sign-in for Gemini — the exact
 * URL verified to be served normally rather than refused as an embedded browser.
 */
export const SIGN_IN_URL: Record<BrowserProviderId, string> = {
  metaai: 'https://www.meta.ai/',
  gemini:
    'https://accounts.google.com/ServiceLogin?continue=https%3A%2F%2Fgemini.google.com%2Fapp'
}

/**
 * Providers whose sign-in is only provable by cookies.
 *
 * Gemini shows its composer to signed-out visitors, so "the prompt box is reachable" is true
 * whether or not anyone has signed in — the composer alone reported a healthy-looking
 * connection for a partition holding no Google account at all. Its auth cookies
 * (`SID`, `HSID`, …) are the honest signal. Meta AI is the opposite case: it keeps its session
 * outside the cookie jar, so there the composer probe really is the best evidence available.
 */
export const REQUIRES_AUTH_COOKIES: Record<BrowserProviderId, boolean> = {
  metaai: false,
  gemini: true
}

export const DISPLAY_NAME: Record<BrowserProviderId, string> = {
  metaai: 'Meta AI',
  gemini: 'Google Gemini'
}

/**
 * Cookies that only a signed-in session has.
 *
 * Google's are well known and stable.
 *
 * Meta's are the part to be suspicious of. `datr`, `sb` and `fr` are deliberately **not**
 * listed: Meta sets them for logged-out visitors too, so treating them as proof of a
 * session makes a signed-out account look ready — which is exactly the false positive this
 * list produced on its first run. Only `c_user` and `xs` are signed-in markers.
 *
 * A wrong list here is a nuisance, not a hazard. Settings runs a real page-load probe
 * beside it, and the provider itself fails with a clear message rather than quietly
 * producing nothing.
 */
export const SIGN_IN_COOKIES: Record<BrowserProviderId, string[]> = {
  metaai: ['c_user', 'xs'],
  gemini: ['SID', 'HSID', 'SSID', 'SAPISID', '__Secure-1PSID', '__Secure-3PSID']
}

/**
 * Only look for sign-in cookies on the domains that would carry them.
 *
 * `cookies.get({})` walks the entire jar, which for a partition that has browsed Meta and
 * Google properties is a long list of advertising and analytics cookies examined for
 * nothing.
 */
export const SIGN_IN_COOKIE_DOMAINS: Record<BrowserProviderId, string[]> = {
  metaai: ['.meta.ai', '.facebook.com'],
  gemini: ['.google.com']
}

/**
 * The profile the app's own Chrome runs under, relative to the Electron user-data folder.
 *
 * A profile of its own, never the user's real one. Two reasons, and the second is the one
 * that matters: the user's browsing profile must not be touched, and Chrome refuses to open
 * its debugging port at all when it is started on the default profile — a deliberate
 * security measure, since an open port on the real profile is remote control of everything
 * the user is signed into.
 */
export const CHROME_PROFILE_DIRNAME = 'chrome-profile'

/**
 * Port the app's Chrome listens on for DevTools connections.
 *
 * Fixed rather than random so a browser left running from a previous launch can be found
 * again and reused — which is what lets "sign in once" mean once. Deliberately an
 * uncommon port: Chrome's own default (9222) is often already taken by whatever else on the
 * machine is doing browser automation.
 */
export const CHROME_DEBUG_PORT = 9333

/** How long a page gets to reach a usable state before the attempt is abandoned. */
export const PAGE_TIMEOUT_MS = 60_000

/** How long one image gets to appear after the prompt is sent. Generators are slow. */
export const IMAGE_TIMEOUT_MS = 180_000

/** Polling interval for "has the image appeared yet". */
export const POLL_INTERVAL_MS = 750

/**
 * A generated image is large; an avatar, an icon or a logo is not. Anything under this is
 * page furniture that happened to be the newest <img> on screen.
 */
export const MIN_IMAGE_EDGE_PX = 320
