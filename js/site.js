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
