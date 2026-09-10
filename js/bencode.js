/**
 * Bencode, the encoding BitTorrent uses for everything structured.
 *
 * Needed here because a BEP 44 signature covers *bencoded bytes*, not a
 * JavaScript object. Two implementations that disagree about a single byte
 * produce signatures that do not verify against each other, so this is one of
 * the few places in the project where being exactly right matters more than
 * being readable — and where "it works with my own output" proves nothing.
 *
 * WebTorrent bundles a bencode implementation internally but does not export
 * one, and the alternative is a dependency for about sixty lines of code.
 *
 * The grammar, in full:
 *
 *   integer      i<digits>e            i42e, i-1e, i0e
 *   byte string  <length>:<bytes>      4:spam
 *   list         l<item>…e             l4:spami42ee
 *   dictionary   d<key><value>…e       d3:foo3:bare
 *
 * Dictionary keys are byte strings and must be sorted by raw byte value, which
 * is what makes the encoding canonical: one value, one encoding, one signature.
 */

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()

/**
 * @param {number|string|Uint8Array|Array|object} value
 * @returns {Uint8Array}
 */
export function encode (value) {
  const parts = []
  write(value, parts)

  const length = parts.reduce((total, part) => total + part.length, 0)
  const out = new Uint8Array(length)
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return out
}

function write (value, parts) {
  if (typeof value === 'number') {
    if (!Number.isInteger(value)) throw new TypeError('bencode has no floats')
    parts.push(textEncoder.encode(`i${value}e`))
    return
  }

  if (typeof value === 'bigint') {
    parts.push(textEncoder.encode(`i${value}e`))
    return
  }

  if (typeof value === 'string') {
    return write(textEncoder.encode(value), parts)
  }

  if (value instanceof Uint8Array) {
    parts.push(textEncoder.encode(`${value.length}:`), value)
    return
  }

  if (Array.isArray(value)) {
    parts.push(textEncoder.encode('l'))
    for (const item of value) write(item, parts)
    parts.push(textEncoder.encode('e'))
    return
  }

  if (value && typeof value === 'object') {
    // Sorted by raw bytes, not by JavaScript's string ordering, which differs
    // once anything outside ASCII appears. Canonical form is the whole point.
    const keys = Object.keys(value).sort(compareByBytes)
    parts.push(textEncoder.encode('d'))
    for (const key of keys) {
      write(key, parts)
      write(value[key], parts)
    }
    parts.push(textEncoder.encode('e'))
    return
  }

  throw new TypeError(`cannot bencode ${typeof value}`)
}

function compareByBytes (a, b) {
  const left = textEncoder.encode(a)
  const right = textEncoder.encode(b)
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    if (left[i] !== right[i]) return left[i] - right[i]
  }
  return left.length - right.length
}

/* -------------------------------------------------------------------------- */

/**
 * @param {Uint8Array} bytes
 * @returns {{ value: number|Uint8Array|Array|object, end: number }}
 *
 * Byte strings come back as `Uint8Array`, never as text: this decoder cannot
 * know which are meant to be read as UTF-8 and which are raw — an infohash is
 * twenty bytes that are not a string in any encoding. Callers decode the ones
 * they know about.
 */
export function decode (bytes) {
  const { value, end } = read(bytes, 0)
  if (end !== bytes.length) throw new SyntaxError('trailing bytes after value')
  return value
}

function read (bytes, at) {
  const marker = bytes[at]

  if (marker === 0x69) { // 'i'
    const end = indexOf(bytes, 0x65, at) // 'e'
    const text = textDecoder.decode(bytes.subarray(at + 1, end))
    if (!/^(0|-?[1-9][0-9]*)$/.test(text)) throw new SyntaxError(`bad integer ${text}`)
    return { value: Number(text), end: end + 1 }
  }

  if (marker === 0x6c) { // 'l'
    const items = []
    let cursor = at + 1
    while (bytes[cursor] !== 0x65) {
      if (cursor >= bytes.length) throw new SyntaxError('unterminated list')
      const item = read(bytes, cursor)
      items.push(item.value)
      cursor = item.end
    }
    return { value: items, end: cursor + 1 }
  }

  if (marker === 0x64) { // 'd'
    const out = {}
    let cursor = at + 1
    while (bytes[cursor] !== 0x65) {
      if (cursor >= bytes.length) throw new SyntaxError('unterminated dictionary')
      const key = read(bytes, cursor)
      if (!(key.value instanceof Uint8Array)) throw new SyntaxError('dictionary key is not a string')
      const value = read(bytes, key.end)
      out[textDecoder.decode(key.value)] = value.value
      cursor = value.end
    }
    return { value: out, end: cursor + 1 }
  }

  if (marker >= 0x30 && marker <= 0x39) { // digit: byte string
    const colon = indexOf(bytes, 0x3a, at) // ':'
    const length = Number(textDecoder.decode(bytes.subarray(at, colon)))
    const start = colon + 1
    if (start + length > bytes.length) throw new SyntaxError('byte string runs past the end')
    return { value: bytes.subarray(start, start + length), end: start + length }
  }

  throw new SyntaxError(`unexpected byte 0x${(marker ?? 0).toString(16)} at ${at}`)
}

function indexOf (bytes, byte, from) {
  for (let i = from; i < bytes.length; i++) if (bytes[i] === byte) return i
  throw new SyntaxError('unterminated value')
}

/* -------------------------------------------------------------------------- */

/** Hex, for keys and infohashes, which are shown and pasted constantly. */
export function toHex (bytes) {
  return [...bytes].map(b => b.toString(16).padStart(2, '0')).join('')
}

export function fromHex (hex) {
  if (!/^[0-9a-f]*$/i.test(hex) || hex.length % 2 !== 0) {
    throw new TypeError('not an even-length hex string')
  }
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16)
  return out
}
