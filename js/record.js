/**
 * The signed record that says "this site has a newer version".
 *
 * A BEP 44 mutable item carrying BEP 46's value — not a format of our own. The
 * point of matching it byte for byte is that the same record is valid in the
 * BitTorrent DHT and on our wire extension, so a seeder with UDP can publish
 * one place and a browser read it from the other. See spec/mutable-sites.md.
 *
 *   { k: <32-byte public key>, seq: <integer>, v: { ih: <20-byte infohash> },
 *     sig: <64-byte signature>, salt?: <bytes> }
 *
 * What gets signed is defined by BEP 44 and is easy to get subtly wrong: it is
 * *not* the bencoded record. It is the bencoded `salt`, `seq` and `v` fields
 * concatenated as they would appear inside a dictionary, with no enclosing
 * `d…e`:
 *
 *   4:salt<salt>3:seqi<seq>e1:v<bencoded v>
 *
 * with the salt portion omitted entirely when there is none.
 */

import { decode, encode, fromHex, toHex } from './bencode.js'

/** BEP 44 caps the value at 1000 bytes. Ours is ~30; the check is for sanity. */
const MAX_VALUE_BYTES = 1000

/**
 * The exact bytes a signature covers.
 *
 * Built by hand rather than by bencoding a dictionary, because a dictionary
 * would sort its keys — giving `salt`, `seq`, `v`, which happens to be the
 * required order here, but only by luck. Relying on that coincidence would
 * break the moment BEP 44 gained a field sorting before `salt`.
 *
 * @param {{ seq: number, v: object, salt?: Uint8Array }} item
 * @returns {Uint8Array}
 */
export function signableBytes ({ seq, v, salt }) {
  const parts = []
  if (salt && salt.length > 0) {
    parts.push(encode('salt'), encode(salt))
  }
  parts.push(encode('seq'), encode(seq))
  parts.push(encode('v'), encode(v))

  const total = parts.reduce((n, p) => n + p.length, 0)
  const out = new Uint8Array(total)
  let at = 0
  for (const part of parts) { out.set(part, at); at += part.length }
  return out
}

/**
 * Build and sign a record announcing `infoHash` as version `seq` of a site.
 *
 * @param {CryptoKey} privateKey  Ed25519 private key
 * @param {Uint8Array} publicKey  its 32-byte public half
 * @param {string} infoHash       40 hex characters
 * @param {number} seq            strictly greater than the previous one
 * @param {Uint8Array} [salt]
 *   The series this version belongs to. BEP 44 addresses a mutable item by
 *   `(public key, salt)`, which is how one identity runs several independent
 *   sites; omitted means the author's default series.
 */
export async function signUpdate (privateKey, publicKey, infoHash, seq, salt) {
  if (!Number.isInteger(seq) || seq < 1) throw new TypeError('seq must be a positive integer')

  const ih = fromHex(infoHash)
  if (ih.length !== 20) throw new TypeError('infohash must be 20 bytes (40 hex characters)')

  const v = { ih }
  const encoded = encode(v)
  if (encoded.length > MAX_VALUE_BYTES) throw new RangeError('value exceeds BEP 44 limit')

  const signature = await crypto.subtle.sign(
    { name: 'Ed25519' }, privateKey, signableBytes({ seq, v, salt }))

  const record = { k: publicKey, seq, v, sig: new Uint8Array(signature) }
  if (salt && salt.length > 0) record.salt = salt
  return record
}

/** The record as bytes, for putting on the wire or into the DHT. */
export function encodeRecord (record) {
  return encode(record)
}

/** @returns {object} the record, with byte fields still as bytes */
export function decodeRecord (bytes) {
  const record = decode(bytes)
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw new SyntaxError('record is not a dictionary')
  }
  return record
}

/**
 * Check a record against the key a site declared, and against what we already
 * know about that key.
 *
 * The rules are spec/mutable-sites.md §Verification, in order, and the order
 * matters: rule 2 exists so that a peer cannot announce a successor signed by
 * a key of its own choosing, which would otherwise verify perfectly.
 *
 * @param {object} record            as decoded from the wire
 * @param {Uint8Array} expectedKey   the key from the site's own spore.pub
 * @param {object} context
 * @param {number} [context.knownSeq]      highest seq previously accepted
 * @param {string} [context.currentInfoHash] what is being read right now
 * @returns {Promise<{ ok: boolean, reason?: string, infoHash?: string, seq?: number }>}
 */
export async function verifyUpdate (record, expectedKey, context = {}) {
  const { knownSeq, currentInfoHash, salt } = context

  const k = record.k
  if (!(k instanceof Uint8Array) || k.length !== 32) {
    return { ok: false, reason: 'no usable public key in the record' }
  }
  if (!sameBytes(k, expectedKey)) {
    return { ok: false, reason: 'signed by a different key than the site declares' }
  }

  // The salt is what makes `(key, salt)` an address rather than the key alone.
  // Without this check an author with two sites would find each one announcing
  // itself as the successor to the other — the record is authentic, correctly
  // signed, and about a different site entirely.
  const expectedSalt = salt ?? new Uint8Array(0)
  const recordSalt = record.salt ?? new Uint8Array(0)
  if (!sameBytes(recordSalt, expectedSalt)) {
    return { ok: false, reason: 'signed for a different site of the same author' }
  }

  if (!Number.isInteger(record.seq) || record.seq < 1) {
    return { ok: false, reason: 'seq is not a positive integer' }
  }
  const ih = record.v?.ih
  if (!(ih instanceof Uint8Array) || ih.length !== 20) {
    return { ok: false, reason: 'value carries no 20-byte infohash' }
  }
  if (!(record.sig instanceof Uint8Array) || record.sig.length !== 64) {
    return { ok: false, reason: 'signature is not 64 bytes' }
  }

  let key
  try {
    key = await crypto.subtle.importKey('raw', k, { name: 'Ed25519' }, false, ['verify'])
  } catch {
    return { ok: false, reason: 'public key could not be imported' }
  }

  const signed = signableBytes({ seq: record.seq, v: record.v, salt: record.salt })
  const valid = await crypto.subtle.verify({ name: 'Ed25519' }, key, record.sig, signed)
  if (!valid) return { ok: false, reason: 'signature does not verify' }

  // Replay: a record older than the newest one already seen would pin a reader
  // to a version the author has superseded, so it is refused.
  //
  // Strictly older, not "not newer". The two are different and treating them
  // the same broke a real case: a reader who takes an update, then later opens
  // an older copy they had kept, is reading something stale and was never told
  // again — the record for the version they already knew about was refused for
  // being equal to what they knew. Equality cannot pin anyone backwards,
  // because such a record names the same version they already accepted, and
  // rule 5 below already refuses anything pointing at what is on screen.
  if (Number.isInteger(knownSeq) && record.seq < knownSeq) {
    return { ok: false, reason: `seq ${record.seq} is older than ${knownSeq}` }
  }

  const infoHash = toHex(ih)
  if (currentInfoHash && infoHash === currentInfoHash.toLowerCase()) {
    return { ok: false, reason: 'points at the version already being read' }
  }

  return { ok: true, infoHash, seq: record.seq }
}

function sameBytes (a, b) {
  if (!(a instanceof Uint8Array) || !(b instanceof Uint8Array) || a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i]
  return diff === 0
}
