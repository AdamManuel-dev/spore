/**
 * Turning whatever the user pasted into a magnet URI.
 *
 * Accepts a magnet URI, a bare infohash (40 hex or 32 base32 chars), or a full
 * gate URL whose fragment holds either of those — so a link copied out of
 * another mirror can be pasted straight into the address bar.
 */

import { DEFAULT_TRACKERS } from './config.js'

const HEX_INFOHASH = /^[0-9a-f]{40}$/i
const BASE32_INFOHASH = /^[a-z2-7]{32}$/i

export class InvalidSiteRef extends Error {}

/**
 * @param {string} input
 * @returns {{ magnetURI: string, infoHash: string|null, source: string }}
 *   `infoHash` is null when the reference is a magnet we cannot read a v1
 *   infohash out of; the real one is known once metadata arrives.
 */
export function parseSiteRef (input) {
  const raw = String(input ?? '').trim()
  if (!raw) throw new InvalidSiteRef('Paste a magnet link or an infohash.')

  const ref = raw.startsWith('http://') || raw.startsWith('https://')
    ? fragmentOf(raw)
    : raw

  if (ref.startsWith('magnet:')) {
    return { magnetURI: ref, infoHash: infoHashFromMagnet(ref), source: ref }
  }
  if (HEX_INFOHASH.test(ref)) {
    const infoHash = ref.toLowerCase()
    return { magnetURI: magnetFor(infoHash), infoHash, source: ref }
  }
  if (BASE32_INFOHASH.test(ref)) {
    // WebTorrent decodes base32 itself; we just cannot name the hash yet.
    return { magnetURI: magnetFor(ref.toUpperCase()), infoHash: null, source: ref }
  }
  throw new InvalidSiteRef('That is not a magnet link or an infohash.')
}

/** Build a magnet URI for an infohash, with the default web trackers attached. */
export function magnetFor (infoHash, name) {
  const params = DEFAULT_TRACKERS.map(tr => `tr=${encodeURIComponent(tr)}`)
  if (name) params.unshift(`dn=${encodeURIComponent(name)}`)
  return `magnet:?xt=urn:btih:${infoHash}&${params.join('&')}`
}

/**
 * The infohash a magnet addresses, validated.
 *
 * Validated here rather than left to WebTorrent, which accepts a malformed
 * infohash without complaint and then waits for peers that can never exist —
 * so a typo in a pasted link looked exactly like a site nobody is seeding, for
 * as long as the reader was willing to watch a spinner.
 *
 * @returns {string|null} the v1 infohash in hex, or null for a base32 one,
 *   which WebTorrent decodes itself and which we cannot name until metadata.
 * @throws {InvalidSiteRef} if there is no readable infohash in there
 */
function infoHashFromMagnet (magnetURI) {
  const match = /xt=urn:btih:([^&]+)/i.exec(magnetURI)
  if (!match) {
    throw new InvalidSiteRef('That magnet link has no infohash in it (no “xt=urn:btih:”).')
  }

  const value = decodeURIComponent(match[1])
  if (HEX_INFOHASH.test(value)) return value.toLowerCase()
  if (BASE32_INFOHASH.test(value)) return null

  throw new InvalidSiteRef(
    `“${value}” is not a valid infohash: it should be 40 characters of 0-9 and ` +
    'a-f, or 32 of base32. Check the link for a typo or a missing character.')
}

/**
 * The site reference lives in the URL fragment on purpose: fragments are never
 * sent to the server, so the gate's host never learns which site is being read.
 */
function fragmentOf (url) {
  try {
    return decodeURIComponent(new URL(url).hash.replace(/^#/, ''))
  } catch {
    throw new InvalidSiteRef('That URL could not be read.')
  }
}
