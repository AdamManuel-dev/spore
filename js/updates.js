/**
 * `sp_update` — telling a peer that the site it is reading has a newer version.
 *
 * A BEP 10 extension, which is the mechanism BitTorrent provides for exactly
 * this and which every client already implements. A peer that does not know
 * `sp_update` simply omits it from its extended handshake, we never send it
 * one, and it downloads the site as if none of this existed. WebTorrent itself
 * runs three of these already (`ut_metadata`, `ut_pex`, `lt_donthave`).
 *
 * The message body is a BEP 44 mutable item, unaltered — see js/record.js and
 * spec/mutable-sites.md. Nothing about the record is ours, so a seeder with
 * UDP can put the identical bytes in the DHT and a BEP 46 client will resolve
 * it without knowing Spore exists. Only the delivery is new, because a browser
 * cannot speak UDP and therefore cannot reach the DHT at all.
 *
 * This module is deliberately ignorant of what a site *is*. It moves records
 * between peers and verifies them; deciding what to do about one is the gate's
 * business, and knowing which key to trust is the caller's.
 */

import { decodeRecord, encodeRecord, verifyUpdate } from './record.js'

export const EXTENSION_NAME = 'sp_update'

/** Records above this are not ours; refuse rather than parse. */
const MAX_RECORD_BYTES = 2048

/**
 * Build the extension class for one torrent.
 *
 * @param {object} options
 * @param {() => (Uint8Array|null|Promise<Uint8Array|null>)} options.publicKey
 *   The key this torrent declared in `spore.pub`, or null if it declared none.
 *   May return a promise, and usually has to. The extension must be attached
 *   before the handshake, which is before there is any metadata, let alone a
 *   fetched file — so at attach time the caller genuinely does not yet know
 *   which key this site trusts. Awaiting here holds an early record until the
 *   answer exists, rather than dropping it or, far worse, trusting it.
 * @param {() => (object|null)} options.offer
 *   The record to hand to peers, if we are holding one.
 * @param {(update: { infoHash: string, seq: number }) => void} options.onUpdate
 *   Called once per verified, accepted record.
 * @param {() => (Uint8Array|null|Promise<Uint8Array|null>)} [options.salt]
 *   The series this site belongs to, from its `spore.pub`. Resolved the same
 *   way and for the same reason as the key: it is unknown until the file can
 *   be read. Without it an author's second site would be accepted as the
 *   successor to their first.
 * @param {() => (number|undefined)} [options.knownSeq]
 *   Highest sequence already accepted for this key, so replays are refused.
 * @param {() => (string|undefined)} [options.currentInfoHash]
 * @param {(reason: string) => void} [options.onRejected]
 */
export function updateExtension (options) {
  const {
    publicKey, offer, onUpdate,
    salt = () => null,
    knownSeq = () => undefined,
    currentInfoHash = () => undefined,
    onRejected = () => {}
  } = options

  class SporeUpdate {
    constructor (wire) {
      this.wire = wire
    }

    /**
     * Announce ourselves only when we have something to say. A peer with no
     * successor to offer still advertises the extension, because it wants to
     * *receive* one — the handshake is symmetric and cheap.
     */
    onExtendedHandshake () {
      if (!this.wire.peerExtendedMapping[EXTENSION_NAME]) return

      const record = offer()
      if (!record) return

      try {
        this.wire.extended(EXTENSION_NAME, encodeRecord(record))
      } catch (err) {
        onRejected(`could not send an update: ${err.message}`)
      }
    }

    async onMessage (buffer) {
      const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer)
      if (bytes.length > MAX_RECORD_BYTES) {
        return onRejected(`record of ${bytes.length} bytes is implausibly large`)
      }

      const expected = await publicKey()
      if (!expected) {
        // A site that declares no key cannot be updated by anyone, and a peer
        // offering to update one is either confused or trying it on.
        return onRejected('this site declares no spore.pub, so it has no successor')
      }

      let record
      try {
        record = decodeRecord(bytes)
      } catch (err) {
        return onRejected(`unreadable record: ${err.message}`)
      }

      const result = await verifyUpdate(record, expected, {
        salt: await salt(),
        knownSeq: knownSeq(),
        currentInfoHash: currentInfoHash()
      })

      if (!result.ok) return onRejected(result.reason)
      onUpdate({ infoHash: result.infoHash, seq: result.seq })
    }
  }

  // bittorrent-protocol reads the name off the prototype, not the class.
  SporeUpdate.prototype.name = EXTENSION_NAME
  return SporeUpdate
}

/**
 * Attach the extension to every peer of a torrent, present and future.
 *
 * @returns {() => void} stop listening (existing wires keep the extension;
 *   there is no way to remove one, and no reason to want to)
 */
export function watchForUpdates (torrent, options) {
  const Extension = updateExtension(options)

  const attach = (wire, late) => {
    try {
      wire.use(Extension)
    } catch (err) {
      return options.onRejected?.(`could not attach ${EXTENSION_NAME}: ${err.message}`)
    }

    // A wire that already exists has already exchanged handshakes, so
    // `onExtendedHandshake` will never fire for it and our offer would never
    // be sent. If the peer advertised the extension before we attached, run
    // that step by hand.
    if (late && wire.peerExtendedMapping?.[EXTENSION_NAME]) {
      wire[EXTENSION_NAME].onExtendedHandshake()
    }
  }

  // WebTorrent emits 'wire' before the handshake goes out — that is the
  // documented hook for exactly this — so attaching here puts `sp_update` in
  // our own advertisement. Attach as soon as the torrent is added: waiting for
  // metadata means every early peer has already handshaked without us, and the
  // extension is symmetric, so a peer that never saw us advertise will never
  // send us anything either.
  torrent.wires.forEach(wire => attach(wire, true))
  const onWire = wire => attach(wire, false)
  torrent.on('wire', onWire)
  return () => torrent.removeListener('wire', onWire)
}
