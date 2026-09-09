/**
 * The WebTorrent client and the service worker that fronts it.
 *
 * The client must live in the page: a service worker cannot open WebRTC
 * connections, so the worker only proxies HTTP-shaped requests back here.
 * Consequence, and it is a real one: seeding stops when the tab closes.
 */

// The vendored bundle is an ES module, so it is imported like our own code
// rather than dropped on `window` by a classic <script>.
import WebTorrent from '../vendor/webtorrent.min.js'
import { METADATA_TIMEOUT_MS } from './config.js'

/** @type {import('webtorrent').Instance|null} */
let client = null

/**
 * Register the worker and wait until it actually controls this page. Until a
 * controller exists, fetches from the viewer iframe would go to the network and
 * 404 — so this has to complete before any site is loaded.
 *
 * @returns {Promise<ServiceWorkerRegistration>}
 */
export async function startWorker () {
  if (!('serviceWorker' in navigator)) {
    throw new Error('This browser has no service workers, so Spore cannot render sites. (HTTPS is required, except on localhost.)')
  }

  let registration
  try {
    registration = await navigator.serviceWorker.register(
      new URL('./sw.js', document.baseURI),
      { scope: './' }
    )
  } catch (err) {
    // Overwhelmingly this is a browser set to block site data, which disables
    // service workers outright. The message the browser gives is not useful.
    throw new Error(
      `Spore could not start its service worker, so it cannot display sites: ${err.message}. ` +
      'This usually means this browser is blocking cookies and site data for ' +
      'localhost, or the page is not on HTTPS.')
  }

  // A stale worker is a classic way to spend an afternoon on a bug that is
  // already fixed: a static host may hand back a cached sw.js for a long time.
  registration.update().catch(() => {})

  if (!navigator.serviceWorker.controller) {
    await new Promise(resolve => {
      navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true })
    })
  }
  return registration
}

/** Create the singleton client and point the worker at it. */
export function startClient (registration) {
  if (client) return client
  client = new WebTorrent()
  // The worker derives its own path prefix from the registration scope, which
  // is why the gate works unchanged whether it is hosted at / or at /spore/.
  client.createServer({ controller: registration })
  return client
}

export function getClient () {
  if (!client) throw new Error('The swarm client has not been started.')
  return client
}

/**
 * Join a swarm and wait for the file list.
 *
 * Idempotent: re-opening a site that is already in the client (a published one,
 * say) returns the existing torrent instead of joining twice.
 */
export async function openTorrent (magnetURI, onJoin = () => {}) {
  const wt = getClient()

  const existing = await wt.get(magnetURI)
  const torrent = existing ?? wt.add(magnetURI)

  // Handed over before the wait, so the caller can show what is happening
  // instead of a spinner that means nothing.
  onJoin(torrent)
  return await withMetadata(torrent)
}

/** Seed files as a new torrent and wait until it is announceable. */
export function seedTorrent (files, opts) {
  return new Promise((resolve, reject) => {
    try {
      getClient().seed(files, opts, resolve)
    } catch (err) {
      reject(err)
    }
  })
}

function withMetadata (torrent) {
  if (torrent.ready) return Promise.resolve(torrent)

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error(
        'No peer answered in a minute. Nobody is seeding this site right now — ' +
        'the tab that published it has to stay open, and so does at least one ' +
        'tab that has it open.'))
    }, METADATA_TIMEOUT_MS)

    const onMetadata = () => { cleanup(); resolve(torrent) }
    const onError = err => { cleanup(); reject(err) }
    const cleanup = () => {
      clearTimeout(timer)
      torrent.removeListener('metadata', onMetadata)
      torrent.removeListener('error', onError)
    }

    torrent.once('metadata', onMetadata)
    torrent.once('error', onError)
  })
}
