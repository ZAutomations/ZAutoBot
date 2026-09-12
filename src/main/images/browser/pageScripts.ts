/**
 * The page scripts that drive a chat app, kept transport-free.
 *
 * These started life inline in `page.ts`, back when an Electron `BrowserWindow` was the only
 * way to reach a page. Now that the same choreography also runs against real Chrome over the
 * DevTools Protocol, the scripts live here as plain strings so both drivers run the *same*
 * heuristics — a redesign that breaks one breaks the other, which is the point: two copies
 * of "find the composer" would drift and one of them would rot unnoticed.
 *
 * Everything is deliberately heuristic rather than a pile of CSS selectors — see the note in
 * `page.ts` for why.
 */

/** The composer element, however it was found. Shared by every script that touches it. */
export const COMPOSER_EL = `(
  document.querySelector('[data-zbot-composer="1"]')
  || [...document.querySelectorAll('textarea, [contenteditable="true"]')].pop()
)`

/** Resolves `true` once the document has finished loading. */
export const PAGE_READY = 'document.readyState === "complete" ? true : null'

/**
 * The composer: the largest editable element on the page.
 *
 * Both apps have exactly one, and it is always the biggest by area — which is a property
 * that does not change when either company renames its classes. Visibility is checked
 * because both keep hidden off-screen textareas around for IME and clipboard work.
 */
export const FIND_COMPOSER = `(() => {
  const editable = [...document.querySelectorAll('textarea, [contenteditable="true"], [contenteditable=""]')];
  const visible = editable.filter((el) => {
    const rect = el.getBoundingClientRect();
    return rect.width > 120 && rect.height > 16 && getComputedStyle(el).visibility !== 'hidden';
  });
  if (!visible.length) return null;
  visible.sort((a, b) => {
    const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
    return rb.width * rb.height - ra.width * ra.height;
  });
  const el = visible[0];
  el.setAttribute('data-zbot-composer', '1');
  return { tag: el.tagName.toLowerCase(), placeholder: el.getAttribute('placeholder') || '' };
})()`

/**
 * Type into the composer.
 *
 * `insertText` is used rather than assigning `.value`, because both apps are React and only
 * react to real input events — a programmatic value assignment leaves the send button
 * disabled and the message unsent.
 */
export function typePromptScript(text: string): string {
  return `(() => {
    const el = ${COMPOSER_EL};
    if (!el) return false;
    el.focus();
    if (el.tagName === 'TEXTAREA') {
      el.value = ${JSON.stringify(text)};
      el.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
      document.execCommand('insertText', false, ${JSON.stringify(text)});
    }
    return true;
  })()`
}

/**
 * Send by pressing Enter.
 *
 * Chosen over clicking a button on purpose. The spec records that a loose send-button match
 * once clicked "Sign up" instead of send — and both apps submit on Enter anyway, so the
 * fragile half of the interaction is simply skipped. `CLICK_SEND` exists only for the case
 * where a composer turns out to insert a newline instead.
 */
export const PRESS_ENTER = `(() => {
  const el = ${COMPOSER_EL};
  if (!el) return false;
  for (const type of ['keydown', 'keypress', 'keyup']) {
    el.dispatchEvent(new KeyboardEvent(type, {
      key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true
    }));
  }
  return true;
})()`

/**
 * Fallback send: the last enabled button whose accessible name says "send".
 *
 * Matching is exact-ish on purpose — `includes('send')` also matches "Send feedback" and
 * "Sign up", which is precisely the bug the spec warns about.
 */
export const CLICK_SEND = `(() => {
  const named = (el) => [
    el.getAttribute('aria-label'), el.getAttribute('title'), el.textContent
  ].filter(Boolean).join(' ').trim().toLowerCase();
  const buttons = [...document.querySelectorAll('button, [role="button"]')];
  const send = buttons.find((el) =>
    !el.disabled && /^(send|send message|submit|send prompt)\\b/.test(named(el))
  );
  if (!send) return false;
  send.click();
  return true;
})()`

/**
 * Snapshot how many large images exist right now.
 *
 * Taken *before* sending, so the wait below can tell a freshly generated image apart from
 * one that was already on screen — otherwise a second scene happily returns the first
 * scene's picture.
 */
export function countImagesScript(minEdgePx: number): string {
  return `[...document.images].filter((img) => img.naturalWidth >= ${minEdgePx}).length`
}

/**
 * Is there still unsent text in the composer?
 *
 * This is how the send is confirmed: a composer that emptied itself accepted the prompt,
 * and one still holding the text means Enter inserted a newline instead of submitting.
 */
export const COMPOSER_HAS_TEXT = `(() => {
  const el = ${COMPOSER_EL};
  if (!el) return false;
  const text = el.tagName === 'TEXTAREA' ? el.value : el.innerText;
  return Boolean(text && text.trim().length);
})()`

/**
 * Wait for a *new* large, fully-loaded image and return its source.
 *
 * Both size gates matter: `naturalWidth` filters out avatars and icons, and waiting for
 * `complete` avoids handing back the placeholder that a generator shows while it streams.
 */
export function newImageScript(minEdgePx: number, before: number): string {
  return `(() => {
    const big = [...document.images].filter(
      (img) => img.naturalWidth >= ${minEdgePx} && img.complete && img.naturalWidth > 0
    );
    if (big.length <= ${before}) return null;
    const newest = big[big.length - 1];
    return newest.currentSrc || newest.src || null;
  })()`
}

/**
 * Pull the image's bytes out of the page.
 *
 * Fetching inside the page is what makes this work at all: the source is often a `blob:`
 * or a signed CDN URL tied to the session, neither of which we can retrieve on our own.
 *
 * Returns `{ ok: true, base64 }` or `{ ok: false, reason }` — never a bare null. A failure
 * here has several distinct causes (a fetch blocked by CORS, an expired signed URL, a
 * source that is not really an image at all) and they call for different fixes, so the
 * reason travels back with the failure instead of being flattened into "no data".
 */
export function grabImageScript(src: string): string {
  return `(async () => {
    try {
      const response = await fetch(${JSON.stringify(src)}, { credentials: 'include' });
      if (!response.ok) return { ok: false, reason: 'the image URL answered HTTP ' + response.status };
      const blob = await response.blob();
      if (!blob.size) return { ok: false, reason: 'the image URL returned zero bytes' };
      const buffer = await blob.arrayBuffer();
      let binary = '';
      const bytes = new Uint8Array(buffer);
      const CHUNK = 0x8000;
      for (let i = 0; i < bytes.length; i += CHUNK) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
      }
      return { ok: true, base64: btoa(binary), type: blob.type };
    } catch (err) {
      return { ok: false, reason: 'fetch threw: ' + (err && err.message ? err.message : String(err)) };
    }
  })()`
}

/** What `grabImageScript` resolves to. */
export interface GrabResult {
  ok: boolean
  base64?: string
  type?: string
  reason?: string
}

/**
 * Does the page look signed in?
 *
 * Only meaningful for apps that show their composer to signed-out visitors — Gemini does,
 * which is why its composer is not evidence of anything. A visible "Sign in" affordance is
 * the signal that nobody is signed in.
 */
export const LOOKS_SIGNED_OUT = `(() => {
  const text = (document.body ? document.body.innerText : '').toLowerCase();
  if (/sign in to continue|you.re not signed in|sign in to use/.test(text)) return true;
  const named = [...document.querySelectorAll('a, button, [role="button"]')].some((el) =>
    /^(sign in|log in|sign in to gemini)\\b/.test((el.textContent || '').trim().toLowerCase())
  );
  return named;
})()`
