/**
 * The window a site is shown through.
 *
 * Two layers hold a hostile site away from the gate:
 *
 *  - `sandbox` on the iframe, deliberately without `allow-same-origin`. The
 *    site therefore runs in an opaque origin: it cannot read the gate's DOM,
 *    storage or service worker registration, and — because each load gets its
 *    own opaque origin — one site cannot reach another through the DOM either.
 *    `allow-scripts` is added only for a site the reader has opted in, and
 *    never together with `allow-same-origin`, which would hand the site the
 *    gate's own origin and undo all of this.
 *  - the Content-Security-Policy the worker attaches to every response, which
 *    is what stops network egress. See `sw.js`.
 *
 * The address bar and controls live outside the iframe, in the gate's own
 * document, so a site cannot paint over them or fake them.
 */

const BASE_SANDBOX = [
  'allow-forms',    // forms still cannot go anywhere: CSP sets form-action 'none'
  'allow-popups',
  // A popup must not inherit the opener's sandbox-with-scripts; keeping it
  // sandboxed means an opened tab cannot script its way back here.
  'allow-popups-to-escape-sandbox'
]

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
    // about:blank rather than removing src, so the previous document is
    // discarded immediately instead of lingering behind a hidden frame.
    this.frame.src = 'about:blank'
  }
}
