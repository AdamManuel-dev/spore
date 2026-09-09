#!/usr/bin/env node
/**
 * Development static server. Not part of the gate — the gate is just files.
 *
 * Exists because service workers need a secure context, and `localhost`
 * qualifies while `file://` does not. Deliberately dependency-free so that
 * `node tools/serve.mjs` works in a fresh clone.
 *
 *   node tools/serve.mjs [port]
 */

import { createServer } from 'node:http'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { extname, join, normalize, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const PORT = Number(process.argv[2] ?? 8080)

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

createServer(async (req, res) => {
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
}).listen(PORT, () => {
  console.log(`Spore gate: http://localhost:${PORT}/`)
})

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
