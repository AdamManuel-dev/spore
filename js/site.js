/**
 * Locating the page to render inside a torrent.
 *
 * A torrent may or may not wrap its files in a root directory, depending on how
 * it was made, and we do not control the ones we merely open. So instead of
 * assuming a layout we look for the shallowest `index.html` and treat its
 * directory as the site root. Relative links inside the page then resolve the
 * same way they would under any static web server, which is the whole contract
 * a published site is held to.
 */

import { TORRENT_PATH } from './config.js'

const INDEX = /(^|\/)index\.html?$/i
const HTML = /\.html?$/i

/**
 * @param {import('webtorrent').Torrent} torrent
 * @returns {string|null} the entry file's path within the torrent
 */
export function findEntry (torrent) {
  const paths = torrent.files.map(file => normalize(file.path))

  const indexes = paths.filter(path => INDEX.test(path))
  if (indexes.length > 0) return shallowest(indexes)

  // A torrent of a single page, however it was named, is still a site.
  const pages = paths.filter(path => HTML.test(path))
  if (pages.length === 1) return pages[0]

  return null
}

/** URL the viewer iframe points at, served by the worker from the swarm. */
export function entryURL (infoHash, entryPath) {
  const encoded = entryPath.split('/').map(encodeURIComponent).join('/')
  return new URL(`./${TORRENT_PATH}/${infoHash}/${encoded}`, document.baseURI).href
}

/** Torrents made on Windows can carry backslashes; the worker matches on `/`. */
function normalize (path) {
  return path.replace(/\\/g, '/')
}

function shallowest (paths) {
  return paths.reduce((best, path) => {
    const byDepth = depth(path) - depth(best)
    if (byDepth !== 0) return byDepth < 0 ? path : best
    return path.length < best.length ? path : best
  })
}

function depth (path) {
  return path.split('/').length
}

/**
 * The key a site declares for itself, if it declares one.
 *
 * `spore.pub` sits beside the entry page, so it is scoped to the site rather
 * than to the torrent: a torrent that happens to contain several directories
 * does not let one of them speak for another. Only the file next to the page
 * actually being rendered counts.
 *
 * A site with no `spore.pub` has no author and can never be updated, which is
 * the correct reading of "this publisher never claimed a key" — not an
 * invitation for the first peer along to claim one on their behalf.
 *
 * @returns {Promise<{publicKey: Uint8Array, hex: string, claimedName: string|null}|null>}
 */
export async function readSporePub (torrent, entryPath) {
  const root = entryPath.includes('/') ? entryPath.slice(0, entryPath.lastIndexOf('/') + 1) : ''
  const file = torrent.files.find(f => normalize(f.path) === `${root}spore.pub`)
  if (!file) return null

  try {
    const bytes = new Uint8Array(await file.arrayBuffer())
    // A key file is a couple of lines. Anything larger is not one, and is not
    // worth decoding to find that out.
    if (bytes.length > 4096) return null
    const { parseSporePub } = await import('./identity.js')
    return parseSporePub(new TextDecoder().decode(bytes))
  } catch {
    // Unreadable or malformed: the site declares no usable key. Treated
    // exactly like declaring none, because a broken claim is not a claim.
    return null
  }
}
