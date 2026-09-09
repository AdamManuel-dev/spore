/**
 * Keeping a site offline.
 *
 * By default Spore writes nothing to disk: a site you read lives in memory and
 * is gone when the tab closes. "Keep offline" is the reader deliberately
 * changing that for one site, so it opens instantly next time and is seeded
 * from the moment Spore starts, without needing a peer to be alive first.
 *
 * It is opt-in, per infohash, and it is not free — see `KEEP_WARNING` below and
 * the section in SECURITY.md. The two costs are real and worth stating plainly
 * rather than burying: the site's contents are written to this device, and you
 * announce that you hold it every time you open Spore, not only while reading.
 *
 * What is *not* claimed: that a kept site is there forever. Browsers evict
 * storage under pressure. `requestPersistence()` asks them not to; they may
 * refuse, and they may change their mind.
 */

import { IdbChunkStore, deleteSite, getSite, listSites, putChunks, putSite, requestPersistence } from './idb.js'

/** Pieces per IndexedDB transaction: enough to be quick, small enough to not stall. */
const BATCH = 32

export const KEEP_WARNING = `Keep this site on this device?

Spore normally writes nothing to disk. Keeping a site changes that for this one
site, and there are two things to know:

  • Its contents are stored on this device. Anyone who can use this browser
    profile can see what you have kept.

  • You will seed it every time you open Spore, not only while you are reading
    it. That announces to trackers and to other peers that this device holds
    this site — repeatedly, over time, not just once.

You are also then hosting whatever is in it. Keep only what you would be
comfortable serving to strangers.

You can undo this at any time with "Forget", which deletes every byte.`

/**
 * @returns {Promise<boolean>}
 *
 * Never throws. This is on the path that renders a site, and a browser with
 * storage switched off must still be able to read one — "not kept" is both the
 * safe answer and the true one when nothing can be stored.
 */
export async function isKept (infoHash) {
  try {
    return !!(await getSite(infoHash))
  } catch {
    return false
  }
}

/** @returns {Promise<import('./idb.js').SiteRecord[]>} newest first */
export function keptSites () {
  return listSites()
}

/**
 * Copy a torrent that is already loaded into IndexedDB, and record enough
 * metadata to bring it back with no peer to ask.
 *
 * @param {import('webtorrent').Torrent} torrent  must be complete
 * @param {(done: number, total: number) => void} [onProgress]
 */
export async function keep (torrent, onProgress = () => {}) {
  if (!torrent.done) {
    throw new Error('This site is still downloading. Wait until it has finished, then keep it.')
  }
  await requestPersistence()

  const total = torrent.pieces.length
  for (let start = 0; start < total; start += BATCH) {
    const indexes = []
    for (let i = start; i < Math.min(start + BATCH, total); i++) indexes.push(i)

    const batch = await Promise.all(indexes.map(async index => ({
      index,
      data: await readPiece(torrent, index)
    })))
    await putChunks(torrent.infoHash, batch)
    onProgress(Math.min(start + BATCH, total), total)
  }

  // Written last, so a record only ever exists for a site whose bytes are all
  // there: an interrupted keep leaves orphan chunks, not a broken site.
  await putSite({
    infoHash: torrent.infoHash,
    name: torrent.name,
    length: torrent.length,
    torrentFile: new Uint8Array(torrent.torrentFile),
    savedAt: Date.now()
  })
}

/** Delete a kept site and every byte of it. */
export function forget (infoHash) {
  return deleteSite(infoHash)
}

/**
 * Re-add every kept site to the swarm client, reading from IndexedDB.
 *
 * This is what makes keeping worth anything: the sites are complete and
 * seedable straight away, without waiting to meet a peer who has them.
 *
 * @param {import('webtorrent').Instance} client
 * @returns {Promise<{ restored: number, failed: string[] }>}
 */
export async function restoreAll (client) {
  const sites = await listSites()
  const failed = []
  let restored = 0

  for (const site of sites) {
    try {
      await restore(client, site)
      restored++
    } catch {
      // A site whose stored pieces no longer verify is not fatal: the gate
      // still works, and the site can be re-fetched from the swarm.
      failed.push(site.infoHash)
    }
  }
  return { restored, failed }
}

async function restore (client, site) {
  if (await client.get(site.infoHash)) return // already open in this tab

  await new Promise((resolve, reject) => {
    const torrent = client.add(site.torrentFile, { store: IdbChunkStore }, () => resolve())
    torrent.once('error', reject)
  })
}

/** WebTorrent's store is callback-based; the pieces are already in memory. */
function readPiece (torrent, index) {
  return new Promise((resolve, reject) => {
    torrent.store.get(index, (err, buf) => err ? reject(err) : resolve(buf))
  })
}
