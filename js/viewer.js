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
   */
  show (url, policy) {
    const sandbox = [...BASE_SANDBOX]
    if (policy.scripts) sandbox.push('allow-scripts')

    // Set sandbox before src: the attribute is read when the load starts.
    this.frame.setAttribute('sandbox', sandbox.join(' '))
    this.frame.src = url
    this.frame.hidden = false
  }

  clear () {
    this.frame.hidden = true
    // about:blank rather than dropping src, so the previous document is
    // discarded now instead of lingering behind a hidden frame.
    this.frame.src = 'about:blank'
  }
}
