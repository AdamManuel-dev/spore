/**
 * Spore service worker — the single chokepoint for everything a hosted site loads.
 *
 * WebTorrent's `client.createServer({ controller })` expects a worker that
 * proxies fetches to the page over a MessagePort. Rather than shipping
 * WebTorrent's stock `dist/sw.min.js`, we re-implement that protocol here
 * (derived from `lib/worker-server.js` + `lib/worker.js`, MIT) for two reasons:
 *
 *  1. SECURITY. The response headers are built here, so this file — not the
 *     torrent, not the page — decides the Content-Security-Policy every site
 *     runs under. Stock WebTorrent sends `frame-ancestors 'none'` (which would
 *     forbid our viewer iframe) and no egress restrictions at all.
 *  2. RENDERING. Stock WebTorrent turns any `destination: 'document'` request
 *     into a `Content-Disposition: attachment` download. We serve sites, so we
 *     ask for those files inline instead.
 *
 * Because every subresource of a site (CSS, images, fonts, XHR, nested frames)
 * is a fetch from this origin, this worker sees all of them. That is why the
 * gate does not rewrite HTML or invent custom tags: there is nothing to miss.
 */

const WEBTORRENT_PREFIX = 'webtorrent/'
const PORT_TIMEOUT_MS = 5000
const POLICY_TIMEOUT_MS = 1000

/** Set once WebTorrent confirms the browser can cancel worker ReadableStreams. */
let streamCancelSupported = false

self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()))

self.addEventListener('fetch', event => {
  const response = route(event)
  if (response) event.respondWith(response)
})

function route (event) {
  const base = self.registration.scope + WEBTORRENT_PREFIX
  const { url } = event.request

  if (!url.startsWith(base)) return null // not ours: let the network handle it
  if (url.startsWith(base + 'keepalive/')) return new Response()
  if (url.startsWith(base + 'cancel/')) {
    // WebTorrent probes this to learn whether stream cancellation works here.
    return new Response(new ReadableStream({ cancel () { streamCancelSupported = true } }))
  }
  return serve(event.request, url.slice(base.length))
}

/* -------------------------------------------------------------------------- */
/* Per-site policy                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Scripts are opt-in per site and the toggle lives in the page, so the worker
 * has to ask — on every request, deliberately. Caching the answer here would
 * mean inventing an invalidation protocol and getting it wrong in exactly the
 * situation that matters: the reader flips the switch, the page reloads the
 * frame, and the worker serves it under the policy from a moment ago. The page
 * answers out of `localStorage`, so a round-trip costs a pair of postMessages.
 *
 * If nobody answers, we fail closed.
 */
async function policyFor (infoHash) {
  const denied = { scripts: false }
  const windows = await self.clients.matchAll({ type: 'window' })
  if (windows.length === 0) return denied

  return new Promise(resolve => {
    const timer = setTimeout(() => resolve(denied), POLICY_TIMEOUT_MS)
    for (const client of windows) {
      const { port1, port2 } = new MessageChannel()
      port1.onmessage = ({ data }) => {
        clearTimeout(timer)
        resolve({ scripts: !!data?.scripts })
      }
      // No `url` field: WebTorrent's own message handler ignores this message.
      client.postMessage({ type: 'spore/policy-query', infoHash }, [port2])
    }
  })
}

/**
 * The policy that a site runs under.
 *
 * `origin` here is the gate's own origin, and `base` is an absolute,
 * path-scoped URL prefix. CSP source expressions match on path prefix, so
 * naming `<origin>/webtorrent/<infoHash>/` — rather than `'self'` — is what
 * keeps one torrent from reaching into another one's files. Everything not
 * listed falls through to `default-src 'none'`, which is the whole point: a
 * site cannot make the browser touch the network outside its own torrent, so
 * an `<img>` or a webfont cannot be used to report the reader's IP address.
 */
function contentSecurityPolicy (origin, base, allowScripts) {
  return [
    "default-src 'none'",
    "base-uri 'none'",
    "object-src 'none'",
    // No form can post the reader anywhere, including back into the torrent.
    "form-action 'none'",
    // Only the gate may frame a site; a site may not be framed by the outside.
    `frame-ancestors ${origin}`,
    `img-src ${base} data: blob:`,
    `media-src ${base} blob:`,
    `font-src ${base} data:`,
    // Inline styles are unavoidable in real static sites and cannot exfiltrate
    // on their own: what a stylesheet may *load* is still pinned to `base`.
    `style-src ${base} 'unsafe-inline'`,
    `frame-src ${base}`,
    `child-src ${base}`,
    allowScripts ? `script-src ${base} 'unsafe-inline'` : "script-src 'none'",
    // Even with scripts on, egress stays inside the torrent.
    allowScripts ? `connect-src ${base}` : "connect-src 'none'",
    allowScripts ? `worker-src ${base}` : "worker-src 'none'"
  ].join('; ')
}

/**
 * WebTorrent answers with `Access-Control-Allow-Origin: *`. We narrow it to the
 * gate itself and to opaque origins (`null`), which is what our sandboxed
 * viewer iframes send, so an unrelated website cannot quietly read torrents out
 * of this browser. Torrent payloads are public by nature, so this is hygiene
 * rather than a hard boundary.
 */
function corsHeader (requestOrigin, gateOrigin) {
  if (requestOrigin === 'null' || requestOrigin === gateOrigin) return requestOrigin
  return null
}

/* -------------------------------------------------------------------------- */
/* Serving                                                                    */
/* -------------------------------------------------------------------------- */

async function serve (request, torrentPath) {
  const infoHash = torrentPath.split('/')[0]
  const gateOrigin = new URL(self.registration.scope).origin
  const base = `${self.registration.scope}${WEBTORRENT_PREFIX}${infoHash}/`

  const [policy, upstream] = await Promise.all([
    policyFor(infoHash),
    requestFromPage(request)
  ])
  if (!upstream) return new Response('No Spore tab is serving this torrent.', { status: 503 })

  const { data, port } = upstream
  const headers = new Headers(data.headers)
  headers.set('Content-Security-Policy', contentSecurityPolicy(gateOrigin, base, policy.scripts))
  headers.set('X-Content-Type-Options', 'nosniff')
  headers.set('Referrer-Policy', 'no-referrer')

  headers.delete('Access-Control-Allow-Origin')
  const allowedOrigin = corsHeader(request.headers.get('Origin'), gateOrigin)
  if (allowedOrigin) headers.set('Access-Control-Allow-Origin', allowedOrigin)

  const init = { status: data.status, headers }

  if (data.body !== 'STREAM') {
    closePort(port)
    return new Response(data.body, init)
  }
  return new Response(streamFromPort(port, request.destination), init)
}

/**
 * Hand the request to whichever tab answers first; that tab owns the WebTorrent
 * client and streams the bytes back over the returned port.
 */
async function requestFromPage (request) {
  const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
  if (windows.length === 0) return null

  return new Promise(resolve => {
    for (const client of windows) {
      const { port1, port2 } = new MessageChannel()
      port1.onmessage = ({ data }) => resolve({ data, port: port1 })
      client.postMessage({
        url: request.url,
        method: request.method,
        headers: Object.fromEntries(request.headers.entries()),
        scope: self.registration.scope,
        // Lie about `document` so WebTorrent serves the file inline instead of
        // turning a page navigation into a file download.
        destination: request.destination === 'document' ? 'iframe' : request.destination,
        type: 'webtorrent'
      }, [port2])
    }
  })
}

function closePort (port) {
  port.postMessage(false) // tells the page to tear down its side
  port.onmessage = null
}

function streamFromPort (port, destination) {
  let idleTimer = null

  const cleanup = () => {
    clearTimeout(idleTimer)
    closePort(port)
  }

  return new ReadableStream({
    pull (controller) {
      return new Promise(resolve => {
        port.onmessage = ({ data }) => {
          if (data) controller.enqueue(data)
          else { cleanup(); controller.close() }
          resolve()
        }
        // Firefox cannot cancel a worker ReadableStream, so an abandoned
        // subresource stream would leak a port forever: drop it after a idle
        // spell. Never for a document, which the browser reads to completion.
        if (!streamCancelSupported && destination !== 'document') {
          clearTimeout(idleTimer)
          idleTimer = setTimeout(() => { cleanup(); resolve() }, PORT_TIMEOUT_MS)
        }
        port.postMessage(true) // ask for the next chunk
      })
    },
    cancel: cleanup
  })
}
