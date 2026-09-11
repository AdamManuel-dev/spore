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
import { deleteKey, getKey, putKey } from './idb.js'

const PUBLISHED_KEY = 'spore.published'
const MY_KEYS_KEY = 'spore.my-keys'

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
  return await identityFromPassphrase(passphrase)
}

/**
 * Commit to an identity, optionally naming it for next time.
 *
 * Split from deriving it on purpose: the caller shows the key to the person
 * first and only gets here if they recognised it. Deriving is not a decision;
 * this is.
 */
export function useIdentity (derived, label) {
  identity = derived
  rememberMyKey(derived.hex, label)
  return { label: labelFor(derived.hex) }
}

export async function signOut () {
  identity = null
  try {
    await deleteKey()
  } catch {
    // Never stored, or storage is unavailable. Either way there is nothing
    // held after this call, which is what the caller asked for.
  }
}

/* -------------------------------------------------------------------------- */
/* Remembering a key on this device                                           */
/* -------------------------------------------------------------------------- */

export const REMEMBER_WARNING = `Keep this key on this device?

Every site you publish from this browser will be signed, with no passphrase to
retype. What is stored is the key itself, not your passphrase — the browser
will sign with it and will not hand it back, so it cannot be copied out, even
by us.

It can still be USED by anything that gets to run on Spore's origin. That is
not hypothetical here: Spore has to serve sites from its own origin, so a site
you grant scripts to could sign as you for as long as this key is stored. There
is no revocation — anything signed while it was used stays validly signed.

Do not keep a key in a browser where you enable scripts for sites you do not
trust. "Forget this key" deletes it.`

/**
 * Store the identity so publishing needs no passphrase.
 *
 * The `CryptoKey` goes into IndexedDB by structured clone. It was imported
 * non-extractable, so the private bytes cannot be read back — the browser will
 * sign with it and refuse to export it. That is the whole security argument for
 * doing this at all: a stored passphrase or a stored seed could be exfiltrated
 * once and used forever, on any machine. This cannot leave the browser it is
 * in, so forgetting it actually ends the exposure.
 *
 * What it does not do is stop the key being *used* while it is there. See
 * REMEMBER_WARNING, which says so in the words the publisher reads.
 */
export async function rememberKeyOnDevice (derived) {
  await putKey({
    privateKey: derived.privateKey,
    publicKey: derived.publicKey,
    hex: derived.hex,
    savedAt: Date.now()
  })
}

/** @returns {Promise<object|null>} the remembered identity, if there is one */
export async function restoreRememberedKey () {
  let stored
  try {
    stored = await getKey()
  } catch {
    return null // storage unavailable: publishing simply asks for a passphrase
  }
  if (!stored?.privateKey) return null

  identity = { privateKey: stored.privateKey, publicKey: stored.publicKey, hex: stored.hex }
  return identity
}

export async function isRemembered () {
  try {
    return Boolean(await getKey())
  } catch {
    return false
  }
}

/* -------------------------------------------------------------------------- */
/* Keys this browser has signed in as                                         */
/* -------------------------------------------------------------------------- */

/**
 * A name the reader gave one of their own keys, private to this browser.
 *
 * This is the only workable answer to "did I type my passphrase correctly".
 * There is no account to check against, so every phrase yields a valid key and
 * a typo yields a different valid key. Warning about that on every sign-in
 * fires on the ordinary case — a new browser — as loudly as on the bad one,
 * which makes it noise. Remembering the key instead turns the second sign-in
 * into recognition: the name comes back, or it does not.
 *
 * @returns {Record<string, {label: string|null, firstSeen: number}>}
 */
function myKeys () {
  try {
    const stored = JSON.parse(localStorage.getItem(MY_KEYS_KEY) ?? '{}')
    return stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {}
  } catch {
    return {}
  }
}

/** @returns {{label: string|null, firstSeen: number}|null} */
export function knownKey (keyHex) {
  return myKeys()[keyHex] ?? null
}

export function labelFor (keyHex) {
  return myKeys()[keyHex]?.label ?? null
}

/** Blank clears the label; the key itself stays remembered either way. */
export function rememberMyKey (keyHex, label) {
  const keys = myKeys()
  const trimmed = typeof label === 'string' ? label.trim() : ''

  keys[keyHex] = {
    label: trimmed || keys[keyHex]?.label || null,
    firstSeen: keys[keyHex]?.firstSeen ?? Date.now()
  }
  try {
    localStorage.setItem(MY_KEYS_KEY, JSON.stringify(keys))
  } catch {
    // Nothing remembered means the next sign-in cannot greet them by name.
    // Unpleasant, not dangerous, and no reason to refuse to sign in.
  }
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

/**
 * A series is `(key, site)`, so history is keyed that way too.
 *
 * Keying by the key alone was a bug with teeth: publishing a second site under
 * one identity signed it as the *successor* to the first, and readers of a blog
 * were offered an unrelated page as its next version. A key is an author; an
 * author has many sites.
 */
function seriesKey (keyHex, site) {
  return site ? `${keyHex}/${site}` : keyHex
}

/** What was last published in one series from this browser, if anything. */
export function lastPublished (keyHex, site) {
  return published()[seriesKey(keyHex, site)] ?? null
}

/** Series this browser has published under a key, newest first. */
export function publishedSeries (keyHex) {
  const all = published()
  return Object.entries(all)
    .filter(([id]) => id === keyHex || id.startsWith(`${keyHex}/`))
    .map(([id, record]) => ({
      site: id.includes('/') ? id.slice(keyHex.length + 1) : null,
      ...record
    }))
    .sort((a, b) => (b.publishedAt ?? 0) - (a.publishedAt ?? 0))
}

/**
 * The sequence number for the next version of a series: the clock, in millis.
 *
 * BEP 44 only requires that a successor's seq be strictly greater than the one
 * before it, and a counter is the wrong way to get that here. A count has to be
 * remembered, and this browser's storage is the only place it could live — so
 * publishing the same site from a second machine restarted at 1 and every
 * reader correctly refused it as stale. A clock needs nothing remembered and
 * agrees with itself across machines.

 * A machine whose clock is wrong publishes a wrong number, and a clock far in
 * the future burns the series until real time catches up. That is a broken
 * clock's problem to fix.
 */
export function nextSeq () {
  return Date.now()
}

/**
 * Record a version as published.
 *
 * Sequence numbers only ever climb: BEP 44 rejects a record whose seq is not
 * above the one a peer already holds, so re-using one would produce a signed
 * update that every reader correctly ignores. See `nextSeq`.
 */
export function recordPublished (keyHex, { site, seq, infoHash, name }) {
  const all = published()
  const id = seriesKey(keyHex, site)
  const known = all[id]
  if (known && known.seq >= seq) return

  all[id] = { seq, infoHash, publishedAt: Date.now(), ...(name ? { name } : {}) }
  try {
    localStorage.setItem(PUBLISHED_KEY, JSON.stringify(all))
  } catch {
    // Nothing persisted means the next version published from this browser
    // starts numbering again, and readers refuse it as stale. Worth knowing;
    // not worth refusing to publish over.
  }
}
