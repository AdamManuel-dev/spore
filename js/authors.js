/**
 * What this browser remembers about the keys it has met.
 *
 * Trust here is trust-on-first-use and nothing more. A key is not vouched for
 * by anyone; it is simply the key that signed the site you were reading, and
 * remembering it is what lets a later record be recognised as "the same author
 * as last time" rather than "somebody claiming to be them".
 *
 * The name inside a `spore.pub` is a claim the key makes about itself, so it is
 * stored as a claim — never as an identity. Two different keys may both call
 * themselves Lara, and one of them may be lying; the key is the only part that
 * cannot be. Petnames, the reader's own private label for a key, are the answer
 * to that, and belong here when they land.
 *
 * Sequence numbers are kept for a colder reason: BEP 44 replay. A record stays
 * valid forever, so a peer can keep handing you a real, correctly signed
 * update that happens to be three versions old. Refusing anything not newer
 * than the highest we have accepted is what closes that.
 */

const STORAGE_KEY = 'spore.authors'

/**
 * A reader tracks versions per series, not per key.
 *
 * `(key, site)` is what a BEP 44 record addresses, so it is also the unit a
 * replay check has to be about: refusing an update to someone's blog because
 * their unrelated notes site is on a higher version would be nonsense.
 */
function seriesKey (keyHex, site) {
  return site ? `${keyHex}/${site}` : keyHex
}

/** @returns {Record<string, {seq: number, infoHash: string, claimed?: string, seenAt: number}>} */
function load () {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}')
    return stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {}
  } catch {
    return {} // unreadable storage means we have met nobody, which is safe
  }
}

function save (authors) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(authors))
  } catch {
    // Private mode or quota. The session's own memory still holds; the only
    // cost is that an old record could be offered again after a reload, and
    // the reader is asked rather than obeyed anyway.
  }
}

/**
 * What is known about a key, ignoring which of its series was seen.
 *
 * Meeting an author is a fact about the person; which of their sites you were
 * reading at the time is not part of it.
 *
 * @returns {object|null} null if this key has never been met
 */
export function author (keyHex) {
  const authors = load()
  const met = Object.entries(authors)
    .filter(([id]) => id === keyHex || id.startsWith(`${keyHex}/`))
    .map(([, record]) => record)
  if (met.length === 0) return null

  return met.reduce((first, record) => record.seenAt < first.seenAt ? record : first)
}

/**
 * The highest sequence accepted for a key, so anything older is refused.
 * Undefined — not 0 — for an unmet key: seq 0 is a legitimate first version.
 */
export function knownSeq (keyHex, site) {
  return load()[seriesKey(keyHex, site)]?.seq
}

/** Record an accepted version. Never moves backwards, whatever it is told. */
export function rememberVersion (keyHex, { site, seq, infoHash, claimed }) {
  const authors = load()
  const id = seriesKey(keyHex, site)
  const known = authors[id]
  if (known && known.seq >= seq) return

  authors[id] = { seq, infoHash, seenAt: Date.now(), ...(claimed ? { claimed } : {}) }
  save(authors)
}

/**
 * Note that a key was met, without asserting a version.
 *
 * Opening a site is how a reader first meets its author; recording that is what
 * makes the *second* meeting recognisable. The version is left alone because
 * arriving at a site says nothing about whether it is the newest one.
 */
export function rememberAuthor (keyHex, { claimed, infoHash }) {
  const authors = load()
  if (authors[keyHex]) {
    if (claimed && !authors[keyHex].claimed) {
      authors[keyHex].claimed = claimed
      save(authors)
    }
    return
  }

  authors[keyHex] = { seq: undefined, infoHash, seenAt: Date.now(), ...(claimed ? { claimed } : {}) }
  save(authors)
}
