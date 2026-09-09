/**
 * Everything that is a policy decision rather than logic.
 * Nothing here may name a specific host for the gate itself: the bundle must
 * behave identically from any mirror.
 */

/**
 * Browsers can only reach WebRTC peers, which means `wss://` trackers. These
 * are the WebTorrent defaults; they are the one unavoidable piece of shared
 * infrastructure in the MVP, so keep them visible rather than buried.
 */
export const DEFAULT_TRACKERS = [
  'wss://tracker.openwebtorrent.com',
  'wss://tracker.webtorrent.dev'
]

// Dropped: wss://tracker.btorrent.xyz. It is in WebTorrent's default list but
// refuses connections (ECONNREFUSED), so every publish shipped a tracker that
// could only produce a console error and a slower start.

/** Path prefix the service worker answers on, relative to the gate's scope. */
export const TORRENT_PATH = 'webtorrent'

/** Give up waiting for a torrent's metadata after this long. */
export const METADATA_TIMEOUT_MS = 60_000

/**
 * The version of `sw.js` this bundle expects to be talking to. Bump both
 * together. A worker from an older release keeps serving after the page has
 * been updated, and the symptom is that everything reports healthy while
 * nothing renders — so Diagnostics compares them and flags a mismatch.
 */
export const EXPECTED_WORKER_VERSION = '2026-09-10.4'
