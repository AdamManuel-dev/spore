/**
 * The identity signed in to this tab.
 *
 * Held in memory and nowhere else. The private key is derived from a passphrase
 * on demand and never written to disk, which is the entire reason the scheme
 * uses a passphrase at all: there is no key file to steal from this browser, and
 * signing in on another machine needs nothing but the phrase itself. The cost is
 * that a reload signs you out, and that is the correct trade — a key that
 * survives a reload survives everything else too.
 *
 * What *is* stored is public: which keys this browser has published under, and
 * the highest version published under each. A publisher needs that to sign a
 * successor with a sequence number above the last one, and none of it is
 * secret — every reader of the site already has it.
 */

import { identityFromPassphrase } from './identity.js'

const PUBLISHED_KEY = 'spore.published'

/** @type {{publicKey: Uint8Array, privateKey: CryptoKey, hex: string}|null} */
let identity = null

export function me () {
  return identity
}

/**
 * Derive the identity for a passphrase.
 *
 * There is no account to check it against — any phrase produces a valid key, and
 * a typo produces a *different* valid key rather than an error. So the caller
 * gets told whether this browser has seen the resulting key before, which is the
 * only signal available that the phrase was typed the way it was last time.
 *
 * @returns {Promise<{identity: object, known: boolean, lastSeq: number|undefined}>}
 */
export async function signIn (passphrase) {
  identity = await identityFromPassphrase(passphrase)
  const history = published()[identity.hex]
  return { identity, known: Boolean(history), lastSeq: history?.seq }
}

export function signOut () {
  identity = null
}

/** @returns {Record<string, {seq: number, infoHash: string, name?: string}>} */
function published () {
  try {
    const stored = JSON.parse(localStorage.getItem(PUBLISHED_KEY) ?? '{}')
    return stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {}
  } catch {
    return {}
  }
}

/** What was last published under a key from this browser, if anything. */
export function lastPublished (keyHex) {
  return published()[keyHex] ?? null
}

/**
 * Record a version as published.
 *
 * Sequence numbers only ever climb: BEP 44 rejects a record whose seq is not
 * above the one a peer already holds, so re-using one would produce a signed
 * update that every reader correctly ignores.
 */
export function recordPublished (keyHex, { seq, infoHash, name }) {
  const all = published()
  const known = all[keyHex]
  if (known && known.seq >= seq) return

  all[keyHex] = { seq, infoHash, ...(name ? { name } : {}) }
  try {
    localStorage.setItem(PUBLISHED_KEY, JSON.stringify(all))
  } catch {
    // Nothing persisted means the next version published from this browser
    // starts numbering again, and readers refuse it as stale. Worth knowing;
    // not worth refusing to publish over.
  }
}
