/**
 * IndexedDB: the only place Spore writes anything to disk.
 *
 * Two object stores:
 *
 *   sites   one record per site the reader chose to keep — the .torrent
 *           metadata, so it can be re-added with no peer to ask, plus enough
 *           to list it in the UI.
 *   chunks  the pieces themselves, keyed by [infoHash, index].
 *
 * Nothing lands here unless the reader asked for it. See `js/keep.js` for the
 * decision and SECURITY.md for what keeping a site costs.
 */

const DB_NAME = 'spore'
const DB_VERSION = 1
const SITES = 'sites'
const CHUNKS = 'chunks'

let dbPromise = null

export function openDatabase () {
  if (dbPromise) return dbPromise

  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(SITES)) db.createObjectStore(SITES, { keyPath: 'infoHash' })
      if (!db.objectStoreNames.contains(CHUNKS)) db.createObjectStore(CHUNKS, { keyPath: ['infoHash', 'index'] })
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  return dbPromise
}

/* -------------------------------------------------------------------------- */
/* Site records                                                               */
/* -------------------------------------------------------------------------- */

/**
 * @typedef {object} SiteRecord
 * @property {string} infoHash
 * @property {string} name
 * @property {number} length      total bytes of the torrent
 * @property {Uint8Array} torrentFile  the .torrent, so it needs no peer to load
 * @property {number} savedAt     epoch millis
 */

/** @param {SiteRecord} record */
export async function putSite (record) {
  const db = await openDatabase()
  await transact(db, [SITES], 'readwrite', tx => tx.objectStore(SITES).put(record))
}

/** @returns {Promise<SiteRecord[]>} newest first */
export async function listSites () {
  const db = await openDatabase()
  const sites = await request(db.transaction(SITES).objectStore(SITES).getAll())
  return sites.sort((a, b) => b.savedAt - a.savedAt)
}

export async function getSite (infoHash) {
  const db = await openDatabase()
  return await request(db.transaction(SITES).objectStore(SITES).get(infoHash))
}

/** Drop a site and every byte of it. */
export async function deleteSite (infoHash) {
  const db = await openDatabase()
  await transact(db, [SITES, CHUNKS], 'readwrite', tx => {
    tx.objectStore(SITES).delete(infoHash)
    // A key range over the compound key covers exactly this site's chunks.
    tx.objectStore(CHUNKS).delete(IDBKeyRange.bound([infoHash, -Infinity], [infoHash, Infinity]))
  })
}

/* -------------------------------------------------------------------------- */
/* Chunks                                                                     */
/* -------------------------------------------------------------------------- */

export async function putChunks (infoHash, chunks) {
  const db = await openDatabase()
  await transact(db, [CHUNKS], 'readwrite', tx => {
    const store = tx.objectStore(CHUNKS)
    for (const { index, data } of chunks) store.put({ infoHash, index, data })
  })
}

/**
 * A chunk store over IndexedDB, in the shape WebTorrent expects
 * (`abstract-chunk-store`). WebTorrent builds it itself, passing the torrent,
 * which is where the infohash comes from.
 */
export class IdbChunkStore {
  constructor (chunkLength, opts = {}) {
    this.chunkLength = chunkLength
    this.infoHash = opts.torrent?.infoHash ?? opts.infoHash
    this.length = opts.length ?? Infinity
    this.closed = false

    if (!this.infoHash) throw new Error('IdbChunkStore needs a torrent to key its chunks by.')
  }

  put (index, buf, cb = noop) {
    if (this.closed) return nextTick(cb, new Error('Store is closed'))
    putChunks(this.infoHash, [{ index, data: toBytes(buf) }]).then(() => cb(null), cb)
  }

  get (index, opts, cb = noop) {
    if (typeof opts === 'function') return this.get(index, null, opts)
    if (this.closed) return nextTick(cb, new Error('Store is closed'))

    openDatabase()
      .then(db => request(db.transaction(CHUNKS).objectStore(CHUNKS).get([this.infoHash, index])))
      .then(record => {
        if (!record) {
          // WebTorrent reads every piece to verify what it has; a gap is
          // normal and means "not downloaded", not "broken".
          const err = new Error(`Chunk ${index} not found`)
          err.notFound = true
          return cb(err)
        }
        const data = toBytes(record.data)
        if (!opts) return cb(null, data)
        const offset = opts.offset ?? 0
        const length = opts.length ?? data.length - offset
        cb(null, data.subarray(offset, offset + length))
      }, cb)
  }

  close (cb = noop) {
    this.closed = true
    nextTick(cb, null)
  }

  destroy (cb = noop) {
    this.closed = true
    deleteSite(this.infoHash).then(() => cb(null), cb)
  }
}

/* -------------------------------------------------------------------------- */

/** How much the browser has given us, and how much is in use. */
export async function usage () {
  const { usage = 0, quota = 0 } = (await navigator.storage?.estimate?.()) ?? {}
  return { usage, quota }
}

/**
 * Ask the browser not to evict this data under storage pressure. It may say no,
 * and it is allowed to change its mind — which is why `keep.js` never promises
 * that a kept site is there forever.
 */
export async function requestPersistence () {
  try {
    return (await navigator.storage?.persist?.()) ?? false
  } catch {
    return false
  }
}

function transact (db, stores, mode, run) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(stores, mode)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error ?? new Error('Transaction aborted'))
    run(tx)
  })
}

function request (req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

/** Store plain bytes: a Buffer-alike from WebTorrent is not structured-cloneable. */
function toBytes (buf) {
  if (buf instanceof Uint8Array) return new Uint8Array(buf)
  return new Uint8Array(buf.buffer ?? buf, buf.byteOffset ?? 0, buf.byteLength ?? buf.length)
}

function nextTick (cb, ...args) {
  queueMicrotask(() => cb(...args))
}

function noop () {}
