/**
 * The window a site is shown through.
 *
 * ## Why `allow-same-origin` is here
 *
 * The obvious design is a fully sandboxed iframe with an opaque origin. It does
 * not work, and the reason is worth recording so that nobody "fixes" it back:
 *
 *   Service worker is disabled because the context is sandboxed and lacks the
 *   'allow-same-origin' flag.
 *
 * A sandboxed document without `allow-same-origin` gets an opaque origin, and a
 * client with an opaque origin is never controlled by a service worker — the
 * navigation is not intercepted and neither is a single subresource. Since the
 * worker is how sites are served at all, sites have to share the gate's origin.
 * (`Content-Security-Policy: sandbox` on the response fails the same way one
 * step later: the document loads, then everything inside it 404s.)
 *
 * So isolation rests on two layers instead:
 *
 *  - This sandbox, which withholds everything not explicitly granted: no
 *    scripts, no top-level navigation (a site cannot replace the gate), no
 *    popups (a `target=_blank` to a third party would leak the reader's IP),
 *    no forms, no downloads, no plugins.
 *  - The Content-Security-Policy the worker attaches to every response, which
 *    pins every load to the site's own torrent and blocks network egress.
 *
 * With scripts off — the default — there is no code inside the site that could
 * make use of the shared origin, so the two layers hold.
 *
 * ## The honest limit
 *
 * A site the reader opts in to scripts *does* run on the gate's origin and can
 * therefore reach `window.parent` and tamper with the gate's own chrome. CSP
 * still confines what it can load, and it cannot install a service worker of
 * its own (a registration's script fetch bypasses our worker, and scope is
 * path-limited because we never send `Service-Worker-Allowed`), but the address
 * bar above it stops being trustworthy. Fixing that properly needs a second
 * origin for content, which is a Phase 2 change. Until then the opt-in asks.
 */

/** How long a site's entry page gets to load before we call it stuck. */
const LOAD_TIMEOUT_MS = 15_000

/** Nothing is granted that the site has not been given a reason to have. */
const BASE_SANDBOX = ['allow-same-origin']

export class Viewer {
  /** @param {HTMLIFrameElement} frame */
  constructor (frame) {
    this.frame = frame
  }

  /**
   * @param {string} url  worker-served URL of the site's entry page
   * @param {{ scripts: boolean }} policy
   * @returns {Promise<boolean>} whether the frame actually navigated
   */
  async show (url, policy) {
    const sandbox = [...BASE_SANDBOX]
    if (policy.scripts) sandbox.push('allow-scripts')

    // Drop the old document first, and wait for that to actually happen. The
    // sandbox flags are read when a load *starts*, so assigning `sandbox` and
    // `src` back-to-back against a frame that is still busy can leave the site
    // rendered under the previous policy — which is how "enable scripts" used
    // to silently do nothing until the reader navigated away and back.
    await this.clear()

    this.frame.setAttribute('sandbox', sandbox.join(' '))

    // Watch the navigation rather than assume it. A viewer stuck on
    // `about:blank` is the worst failure this app has: the reader sees an empty
    // page, the console says nothing, and every other indicator reads healthy.
    const settled = new Promise(resolve => {
      let timer
      const finish = () => { clearTimeout(timer); resolve() }
      timer = setTimeout(finish, LOAD_TIMEOUT_MS)
      this.frame.addEventListener('load', finish, { once: true })
    })

    this.frame.src = url
    this.frame.hidden = false

    await settled
    return this.landedOn(url)
  }

  /**
   * Did the frame really end up showing that page?
   *
   * The `load` event is not the answer on its own: a navigation the browser
   * refuses still fires it, having put an error page — or nothing — in the
   * frame. The document's own URL is the honest signal. Sites are served from
   * this origin (see above), so the frame is readable from here.
   */
  landedOn (url) {
    let document
    try {
      document = this.frame.contentDocument
    } catch {
      return true // cross-origin somehow: no view, so no accusation
    }
    if (!document) return false
    if (document.URL !== url) return false
    return (document.body?.childElementCount ?? 0) > 0 ||
      (document.body?.textContent ?? '').trim().length > 0
  }

  /** @returns {Promise<void>} resolves when the frame holds nothing */
  clear () {
    this.frame.hidden = true
    if (this.frame.src === 'about:blank' || !this.frame.src) return Promise.resolve()

    return new Promise(resolve => {
      // Never hang on this: a frame that will not unload should not wedge the
      // gate, and the navigation below replaces it either way.
      let timer
      const finish = () => { clearTimeout(timer); resolve() }
      timer = setTimeout(finish, 1000)
      this.frame.addEventListener('load', finish, { once: true })
      this.frame.src = 'about:blank'
    })
  }
}
