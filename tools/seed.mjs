#!/usr/bin/env node
/**
 * Seed a site from a server, so it stays reachable with nobody's tab open.
 *
 * A browser peer can only talk to other WebRTC peers, so an ordinary
 * BitTorrent client — transmission, rtorrent, a NAS — cannot serve a Spore
 * site no matter how correctly it seeds the same infohash. It has to be a
 * WebRTC-speaking seeder, which in practice means Node with a WebRTC
 * implementation attached.
 *
 * That is the whole difficulty, and it is one line: WebTorrent picks up
 * `globalThis.WRTC` and hands it to the tracker client. `webtorrent-hybrid`,
 * which older guides install for this, is no longer needed.
 *
 *   npm install webtorrent node-datachannel
 *
 *   node tools/seed.mjs ./my-site                 # publish and seed a folder
 *   node tools/seed.mjs site.torrent --path ./..  # seed an existing torrent
 *
 * The second form is the one to use for a site already published from a
 * browser: re-creating a torrent from the same folder does not reliably
 * reproduce the same infohash, and a different infohash is a different site.
 * Export the .torrent from the gate and point this at the folder that
 * contains it.
 */

import { readFileSync, existsSync } from 'node:fs'
import { basename, resolve } from 'node:path'

import { DEFAULT_TRACKERS } from '../js/config.js'

const args = process.argv.slice(2)
const target = args.find(arg => !arg.startsWith('--'))
const pathIndex = args.indexOf('--path')
const contentPath = pathIndex === -1 ? process.cwd() : resolve(args[pathIndex + 1])

if (!target) {
  console.error(`Seed a Spore site from this machine.

  node tools/seed.mjs <folder>                     publish a folder and seed it
  node tools/seed.mjs <file.torrent> --path <dir>  seed a site already published

Needs: npm install webtorrent node-datachannel`)
  process.exit(2)
}

/* -------------------------------------------------------------------------- */

let WebTorrent, wrtc
try {
  wrtc = await import('node-datachannel/polyfill')
  WebTorrent = (await import('webtorrent')).default
} catch (err) {
  console.error(
    `\nMissing dependencies. This tool is not part of the gate, so they are ` +
    `not installed by default:\n\n  npm install webtorrent node-datachannel\n\n${err.message}`)
  process.exit(1)
}

// Read by WebTorrent's constructor and passed down to the tracker client, which
// is what lets this process answer a browser. Without it the seeder announces
// happily and no browser can ever reach it.
globalThis.WRTC = wrtc

const client = new WebTorrent()
client.on('error', err => {
  console.error('client error:', err.message)
  process.exit(1)
})

const announceList = DEFAULT_TRACKERS.map(tracker => [tracker])
const torrent = await start()

console.log(`\nSeeding "${torrent.name}"  (${torrent.files.length} files, ${format(torrent.length)})`)
console.log(`\n  ${torrent.magnetURI}\n`)
console.log('Open it with any Spore gate by putting that magnet in the fragment:')
console.log(`  https://<your-gate>/#${torrent.magnetURI}\n`)
console.log('Leave this running. Ctrl+C stops seeding.\n')

setInterval(() => {
  const peers = torrent.numPeers
  process.stdout.write(
    `\r${new Date().toISOString().slice(11, 19)}  ` +
    `${peers} peer${peers === 1 ? '' : 's'}  ` +
    `↑ ${format(torrent.uploaded)}   `)
}, 2000).unref?.()

process.on('SIGINT', () => {
  console.log('\nStopping.')
  client.destroy(() => process.exit(0))
})

/* -------------------------------------------------------------------------- */

function start () {
  const isTorrentFile = target.endsWith('.torrent')
  const source = resolve(target)

  if (!existsSync(source)) {
    console.error(`Nothing at ${source}`)
    process.exit(1)
  }

  return new Promise((resolve_, reject) => {
    client.on('error', reject)

    if (isTorrentFile) {
      // `path` is the directory the torrent's own files live under. WebTorrent
      // verifies what is already there and seeds it, which is why the infohash
      // comes out identical to the one the browser published.
      console.log(`Verifying ${basename(source)} against ${contentPath}…`)
      const added = client.add(readFileSync(source), { path: contentPath }, () => resolve_(added))
    } else {
      console.log(`Hashing ${source}…`)
      client.seed(source, { announceList }, seeded => resolve_(seeded))
    }
  })
}

function format (bytes) {
  const units = ['B', 'kB', 'MB', 'GB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++ }
  return `${value < 10 && unit > 0 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`
}
