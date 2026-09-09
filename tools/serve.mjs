#!/usr/bin/env node
/**
 * Development static server. Not part of the gate — the gate is just files.
 *
 * Exists because service workers need a secure context, and `localhost`
 * qualifies while `file://` does not. Deliberately dependency-free so that
 * `node tools/serve.mjs` works in a fresh clone.
 *
 *   node tools/serve.mjs [port] [--tls]
 *
 * `--tls` serves HTTPS with a self-signed certificate, which is the only way to
 * reach Spore from another device on the network: a service worker needs a
 * secure context, and localhost is the sole insecure origin browsers exempt.
 */

import { execFileSync } from 'node:child_process'
import { createServer as createHttpServer } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { createReadStream, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { networkInterfaces } from 'node:os'
import { extname, join, normalize, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const args = process.argv.slice(2)
const TLS = args.includes('--tls')
const PORT = Number(args.find(a => /^\d+$/.test(a)) ?? 8080)

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8'
}

const handler = async (req, res) => {
  const url = new URL(req.url, 'http://localhost')
  const target = await resolvePath(decodeURIComponent(url.pathname))

  if (!target) {
    res.writeHead(404, { 'Content-Type': 'text/plain' })
    return res.end('Not found')
  }

  res.writeHead(200, {
    'Content-Type': TYPES[extname(target)] ?? 'application/octet-stream',
    // Always serve fresh bytes: a cached sw.js is the classic way to spend an
    // afternoon debugging code that is no longer running.
    'Cache-Control': 'no-store'
  })
  createReadStream(target).pipe(res)
}

const server = TLS ? createHttpsServer(devCertificate(), handler) : createHttpServer(handler)
const scheme = TLS ? 'https' : 'http'

server.listen(PORT, () => {
  console.log(`Spore gate: ${scheme}://localhost:${PORT}/`)
  for (const address of lanAddresses()) console.log(`            ${scheme}://${address}:${PORT}/`)

  if (!TLS && lanAddresses().length > 0) {
    console.log(
      '\nTo open Spore on another device (a phone, say), restart with --tls.\n' +
      'Service workers need a secure context and only localhost is exempt, so\n' +
      'over a LAN address plain http cannot work — the browser switches the\n' +
      'whole service worker API off and Spore cannot display anything.')
  }
  if (TLS) {
    console.log(
      '\nThe certificate is self-signed, so each device has to accept the warning\n' +
      'once ("Advanced" → "Proceed"). After that the origin is a secure context\n' +
      'and Spore works normally.')
  }
})

/** Every non-loopback IPv4 address, so the URL to type on a phone is printed. */
function lanAddresses () {
  return Object.values(networkInterfaces()).flat()
    .filter(iface => iface && iface.family === 'IPv4' && !iface.internal)
    .map(iface => iface.address)
}

/**
 * A self-signed certificate for local development, generated once.
 *
 * Only reason this exists: a service worker needs a secure context, and
 * `localhost` is the sole insecure origin browsers make an exception for. A
 * phone reaching the dev server at `http://192.168.x.x` therefore has no
 * service worker at all, and Spore serves every site through one.
 *
 * Never use this for anything but development. It is a key on disk with no
 * passphrase, and it is deliberately gitignored.
 */
function devCertificate () {
  const dir = join(ROOT, '.dev-cert')
  const key = join(dir, 'key.pem')
  const cert = join(dir, 'cert.pem')

  if (!existsSync(key) || !existsSync(cert)) {
    mkdirSync(dir, { recursive: true })
    const names = ['DNS:localhost', 'IP:127.0.0.1', ...lanAddresses().map(a => `IP:${a}`)]
    console.log(`Generating a development certificate for ${names.join(', ')}…`)
    try {
      execFileSync('openssl', [
        'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
        '-keyout', key, '-out', cert, '-days', '365',
        '-subj', '/CN=spore-dev', '-addext', `subjectAltName=${names.join(',')}`
      ], { stdio: ['ignore', 'ignore', 'pipe'] })
    } catch (err) {
      console.error(
        '\nCould not generate a certificate. --tls needs the `openssl` command.\n' +
        String(err.stderr ?? err.message))
      process.exit(1)
    }
  }
  return { key: readFileSync(key), cert: readFileSync(cert) }
}

/** Resolve a URL path to a file inside ROOT, or null. */
async function resolvePath (pathname) {
  // normalize() collapses `..` before we check containment, so a crafted path
  // cannot climb out of the served directory.
  const candidate = join(ROOT, normalize(pathname))
  if (candidate !== ROOT && !candidate.startsWith(ROOT + sep)) return null

  try {
    const info = await stat(candidate)
    if (!info.isDirectory()) return candidate
  } catch {
    return null
  }

  try {
    const index = join(candidate, 'index.html')
    await stat(index)
    return index
  } catch {
    return null
  }
}
