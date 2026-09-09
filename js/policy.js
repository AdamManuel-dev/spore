/**
 * Per-site script permission.
 *
 * Sites run with `script-src 'none'` until the reader says otherwise, one
 * infohash at a time. The decision is taken here, in the gate, and enforced in
 * `sw.js`, which is the only code that can set response headers. This module is
 * the bridge between the two: it owns the stored answer and replies when the
 * worker asks.
 *
 * Keying by infohash — not by name or by tracker — means a permission follows
 * exactly the bytes it was granted to. There is no way to swap the content
 * under a permission that has already been given.
 */

const STORAGE_KEY = 'spore.scripts-allowed'

/** @returns {Set<string>} infohashes the user has enabled scripts for */
function load () {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]')
    return new Set(Array.isArray(stored) ? stored : [])
  } catch {
    return new Set() // unreadable storage must not mean "allow"
  }
}

function save (allowed) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...allowed]))
  } catch {
    // Private mode, quota, whatever: the in-memory decision still stands for
    // this session and the safe default returns on reload.
  }
}

export function scriptsAllowed (infoHash) {
  return load().has(infoHash)
}

/**
 * Persist the decision. Nothing has to be pushed to the worker: it asks on
 * every request, so the next fetch of the site already sees this.
 */
export function setScriptsAllowed (infoHash, allowed) {
  const set = load()
  if (allowed) set.add(infoHash)
  else set.delete(infoHash)
  save(set)
}

/** Answer the worker's policy questions. */
export function servePolicyQueries () {
  if (!navigator.serviceWorker) return

  navigator.serviceWorker.addEventListener('message', event => {
    if (event.data?.type !== 'spore/policy-query') return
    event.ports[0]?.postMessage({ scripts: scriptsAllowed(event.data.infoHash) })
  })

  // A container that only ever gets `addEventListener` keeps its message queue
  // dormant. Without this the worker's questions are delivered to nobody, it
  // times out, and a site the reader enabled quietly loses its scripts.
  navigator.serviceWorker.startMessages()
}
