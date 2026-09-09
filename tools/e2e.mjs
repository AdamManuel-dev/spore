#!/usr/bin/env node
/**
 * End-to-end check of both MVP promises and the security model behind them.
 *
 * The guarantees in SECURITY.md are claims about browser behaviour, so they are
 * checked in a browser rather than reasoned about. It drives a real Chrome:
 * publishes `example-site/`, opens it through the normal fragment route, and
 * inspects what the site is allowed to do.
 *
 *   npm install puppeteer-core        # the only dependency, and only for this
 *   node tools/e2e.mjs [--headful] [--chrome /path/to/chrome]
 *
 * Nothing in the gate itself needs this: it is a static bundle with no build
 * step and no dependencies to install.
 */

import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { fileURLToPath } from 'node:url'

const args = process.argv.slice(2)
const flag = name => args.includes(name)
const option = (name, fallback) => {
  const i = args.indexOf(name)
  return i === -1 ? fallback : args[i + 1]
}

const CHROME = option('--chrome', process.env.CHROME ?? '/usr/bin/google-chrome')
const SITE = 'example-site'
const SITE_FILES = ['index.html', 'about.html', 'probe.js', 'css/site.css', 'css/leaf.svg']

let puppeteer
try {
  puppeteer = (await import('puppeteer-core')).default
} catch {
  console.error('This check needs puppeteer-core:\n\n  npm install puppeteer-core\n')
  process.exit(2)
}

/* -------------------------------------------------------------------------- */

const results = []
const check = (name, pass, detail = '') => {
  results.push({ name, pass })
  console.log(`${pass ? '  ok  ' : ' FAIL '}${name}${detail ? ` — ${detail}` : ''}`)
}
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

const port = await freePort()
const server = spawn(process.execPath, [fileURLToPath(new URL('serve.mjs', import.meta.url)), String(port)], { stdio: 'ignore' })
const origin = `http://localhost:${port}`

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: flag('--headful') ? false : 'new',
  protocolTimeout: 30_000,
  args: ['--no-sandbox', '--disable-dev-shm-usage']
})

try {
  await run()
} catch (err) {
  console.error('\nThe check itself broke:', err.message)
  results.push({ name: 'suite completed', pass: false })
} finally {
  await browser.close()
  server.kill()
}

const failed = results.filter(r => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)

/* -------------------------------------------------------------------------- */

async function run () {
  const page = await browser.newPage()
  const console_ = []
  page.on('console', m => console_.push(m.text()))
  page.on('pageerror', e => console_.push('pageerror: ' + e.message))

  await page.goto(origin + '/', { waitUntil: 'load' })
  await page.waitForFunction(() => !!navigator.serviceWorker.controller, { timeout: 20_000 })
  check('the service worker takes control of the gate', true)

  await page.waitForFunction(
    () => document.getElementById('status').textContent === 'Nothing open',
    { timeout: 20_000 })
  check('the gate boots and the swarm client starts', true)

  // --- publish -------------------------------------------------------------
  // Feeding the files in directly rather than through a drag-and-drop, which
  // no automation API can synthesise; publish() sees exactly what a drop gives.
  const infoHash = await page.evaluate(async (site, paths) => {
    const files = []
    for (const path of paths) {
      const res = await fetch(`/${site}/${path}`)
      const file = new File([await res.blob()], path.split('/').pop())
      file.fullPath = `${site}/${path}`
      files.push(file)
    }
    const { publish } = await import('/js/publish.js')
    return (await publish(files, site)).infoHash
  }, SITE, SITE_FILES)
  check('a dropped folder is seeded and yields an infohash', /^[0-9a-f]{40}$/.test(infoHash), infoHash)

  // --- open ----------------------------------------------------------------
  await page.evaluate(hash => { location.hash = hash }, infoHash)
  await page.waitForFunction(() => {
    const frame = document.getElementById('viewer')
    return !frame.hidden && frame.src.includes('/webtorrent/')
  }, { timeout: 20_000 })

  const src = await page.$eval('#viewer', f => f.src)
  const entry = src.slice(src.indexOf(infoHash) + infoHash.length + 1)
  check('the viewer opens the entry page the worker serves',
    src.startsWith(`${origin}/webtorrent/${infoHash}/`) && src.endsWith('index.html'), src)

  const sandbox = await page.$eval('#viewer', f => f.getAttribute('sandbox'))
  check('the sandbox grants nothing but same-origin by default',
    sandbox.trim() === 'allow-same-origin', sandbox)

  const site = await siteFrame(page)
  const rendered = await site.evaluate(() => ({
    heading: document.querySelector('h1')?.textContent,
    headingColour: getComputedStyle(document.querySelector('h1')).color,
    imageLoaded: document.images[0]?.complete && document.images[0]?.naturalWidth > 0,
    probe: document.getElementById('probe')?.textContent
  }))
  check('the page renders out of the swarm', rendered.heading === 'Hello from a spore', rendered.heading)
  check('a relative stylesheet loads', rendered.headingColour === 'rgb(47, 143, 69)', rendered.headingColour)
  check('a relative image loads', rendered.imageLoaded === true)
  check('scripts do not run by default', rendered.probe === 'Scripts are off.', rendered.probe)

  // --- the policy on the wire ----------------------------------------------
  const headers = await fetchHeaders(page, infoHash, entry)
  const csp = headers['content-security-policy'] ?? ''
  check('CSP: everything is denied unless named', csp.includes("default-src 'none'"))
  check('CSP: no scripts by default', csp.includes("script-src 'none'"))
  check('CSP: no network egress by default', csp.includes("connect-src 'none'"))
  check('CSP: sources are pinned to this torrent alone',
    csp.includes(`img-src ${origin}/webtorrent/${infoHash}/`))
  check('CSP: the gate may frame the site (WebTorrent would forbid it)',
    csp.includes(`frame-ancestors ${origin}`), csp.match(/frame-ancestors [^;]*/)?.[0])
  check('the entry page is served inline, not as a download',
    !(headers['content-disposition'] ?? '').includes('attachment'), headers['content-disposition'])
  check('the entry page is served as HTML', (headers['content-type'] ?? '').includes('text/html'),
    headers['content-type'])

  // --- egress --------------------------------------------------------------
  // The probes are static markup in example-site: no script is involved, which
  // is the threat this is about. CSP refusals surface as console errors.
  const refusals = console_.filter(line => line.includes('Content Security Policy'))
  check('an off-site image is refused, so plain markup cannot leak the reader',
    refusals.some(line => line.includes('example.invalid')), `${refusals.length} refusals`)
  check('climbing out of the torrent to another one is refused',
    refusals.some(line => line.includes('0000000000000000000000000000000000000000')))
  check('neither probe image loaded',
    await site.evaluate(() => [...document.images].slice(1).every(img => img.naturalWidth === 0)))

  // --- navigation ----------------------------------------------------------
  await site.evaluate(() => document.querySelector('a[href="about.html"]').click()).catch(() => {})
  await wait(3000)
  const second = await (await siteFrame(page)).evaluate(() => document.querySelector('h1')?.textContent)
  check('a relative link opens a second page from the torrent', second === 'Second page', second)

  await page.evaluate(() => {
    const frame = document.getElementById('viewer')
    frame.src = frame.src.replace('about.html', 'index.html')
  })
  await wait(3000)

  // --- opting in to scripts -------------------------------------------------
  let asked = false
  page.on('dialog', async dialog => { asked = true; await dialog.accept() })
  await page.click('#scripts-toggle')
  await wait(500)
  check('turning scripts on asks first', asked)
  await wait(2500)

  const after = await (await siteFrame(page)).evaluate(
    () => document.getElementById('probe')?.textContent)
  check('the script runs once the reader opts in', after === 'Scripts are on for this site.', after)

  const sandboxAfter = await page.$eval('#viewer', f => f.getAttribute('sandbox'))
  // allow-same-origin is not a choice: a sandboxed opaque origin is never
  // served by a service worker. The opt-in adds allow-scripts and nothing else.
  check('the opt-in adds allow-scripts and nothing else',
    sandboxAfter.trim() === 'allow-same-origin allow-scripts', sandboxAfter)

  const cspAfter = (await fetchHeaders(page, infoHash, entry))['content-security-policy']
  check('CSP: egress stays inside the torrent even with scripts on',
    cspAfter.includes(`connect-src ${origin}/webtorrent/${infoHash}/`),
    cspAfter.match(/connect-src [^;]*/)?.[0])
}

/** The site's frame, once its document has actually settled. */
async function siteFrame (page) {
  for (let attempt = 0; attempt < 60; attempt++) {
    const frame = page.frames().find(f => f.url().includes('/webtorrent/'))
    if (frame) {
      try {
        if (await frame.evaluate(() => document.readyState === 'complete')) return frame
      } catch { /* context swapped mid-navigation; look again */ }
    }
    await wait(250)
  }
  throw new Error('the site frame never finished loading')
}

function fetchHeaders (page, infoHash, path) {
  return page.evaluate(async (hash, file) => {
    const res = await fetch(`/webtorrent/${hash}/${file}`)
    await res.text()
    return Object.fromEntries(res.headers.entries())
  }, infoHash, path)
}

function freePort () {
  return new Promise(resolve => {
    const probe = createServer()
    probe.listen(0, () => {
      const { port } = probe.address()
      probe.close(() => resolve(port))
    })
  })
}
