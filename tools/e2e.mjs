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
/** Every confirm() the gate raised, newest run of checks clearing it as it goes. */
const prompts = []
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

  // One handler for the whole run: the gate asks before granting anything, and
  // each check clears the flag before the click it cares about.
  page.on('dialog', async dialog => { prompts.push(dialog.message()); await dialog.accept() })

  await page.goto(origin + '/', { waitUntil: 'load' })
  await page.waitForFunction(() => !!navigator.serviceWorker.controller, { timeout: 20_000 })
  check('the service worker takes control of the gate', true)

  await page.waitForFunction(
    () => document.getElementById('status').textContent === 'Nothing open',
    { timeout: 20_000 })
  check('the gate boots and the swarm client starts', true)

  // The viewer must fill the window and the status bar must sit on the bottom
  // edge. A `grid-template-rows` list once handed the free space to the status
  // bar instead, collapsing the viewer to the height of its content.
  const layout = await page.evaluate(() => {
    const box = selector => {
      const { top, height } = document.querySelector(selector).getBoundingClientRect()
      return { top: Math.round(top), height: Math.round(height) }
    }
    return { window: window.innerHeight, stage: box('.stage'), statusbar: box('.statusbar') }
  })
  check('the viewer fills the window and the status bar sits at the bottom',
    layout.stage.height > layout.window / 2 &&
    Math.abs(layout.statusbar.top + layout.statusbar.height - layout.window) <= 1,
    JSON.stringify(layout))

  // With nothing open, the viewer must take up no room at all. `.viewer` sets
  // `display: block`, which silently overrode the browser's own
  // `[hidden] { display: none }` — so a blank white iframe filled the page and
  // pushed the welcome screen below the fold, where nobody would find it.
  const home = await page.evaluate(() => {
    const viewer = document.getElementById('viewer')
    const stage = document.querySelector('.stage').getBoundingClientRect()
    const welcome = document.getElementById('welcome').getBoundingClientRect()
    return {
      viewerDisplay: getComputedStyle(viewer).display,
      viewerHeight: Math.round(viewer.getBoundingClientRect().height),
      welcomeStartsInView: Math.round(welcome.top - stage.top),
      choices: document.querySelectorAll('#welcome .choice').length
    }
  })
  check('with nothing open the viewer takes up no space',
    home.viewerDisplay === 'none' && home.viewerHeight === 0, JSON.stringify(home))
  check('the landing page starts at the top of the stage, not below the fold',
    home.welcomeStartsInView === 0, JSON.stringify(home))
  check('the landing page offers both ways in', home.choices === 2, JSON.stringify(home))

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
  check('CSP: same-origin loads only, so nothing external can be reached',
    csp.includes("img-src 'self' data: blob:") && !/https?:\/\/(?!localhost)/.test(csp))
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
  // The static probe that points into another torrent must come back empty.
  // Its refusal now comes from the worker rather than from a CSP path, and a
  // scriptless page cannot fetch() to inspect the status — that is checked
  // below, once scripts are on and connect-src permits a request at all.
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
  prompts.length = 0
  await page.click('#scripts-toggle')
  await wait(500)
  check('turning scripts on asks first',
    prompts.some(text => text.includes("Run this site's scripts?")), prompts[0]?.split('\n')[0])

  // Opting in reloads the frame, so poll rather than guess how long that takes.
  const after = await settle(page, () => document.getElementById('probe')?.textContent,
    text => text === 'Scripts are on for this site.')
  check('the script runs once the reader opts in', after === 'Scripts are on for this site.', after)

  const sandboxAfter = await page.$eval('#viewer', f => f.getAttribute('sandbox'))
  // allow-same-origin is not a choice: a sandboxed opaque origin is never
  // served by a service worker. The opt-in adds allow-scripts and nothing else.
  check('the opt-in adds allow-scripts and nothing else',
    sandboxAfter.trim() === 'allow-same-origin allow-scripts', sandboxAfter)

  const cspAfter = (await fetchHeaders(page, infoHash, entry))['content-security-policy']
  check('CSP: egress stays on this origin even with scripts on',
    cspAfter.includes("connect-src 'self'"), cspAfter.match(/connect-src [^;]*/)?.[0])

  // Cross-torrent isolation, checked at its enforcement point. With scripts on
  // the site may fetch its own origin, so this is the strongest case: the
  // worker still has to refuse a read into a torrent that is not this one.
  const scripted = await siteFrame(page)
  const cross = await scripted.evaluate(async () => {
    const other = '0000000000000000000000000000000000000000'
    const own = await fetch('css/site.css').then(r => r.status, e => 'ERR ' + e.message)
    const theirs = await fetch(`../../${other}/pixel.png`).then(r => r.status, e => 'ERR ' + e.message)
    return { own, theirs }
  })
  check('a scripted site may read its own torrent', cross.own === 200, JSON.stringify(cross))
  check('the worker refuses a scripted read into another torrent',
    cross.theirs === 403, JSON.stringify(cross))

  // --- the address bar ------------------------------------------------------
  // Navigating by pasting a magnet must not reload the gate: the fragment is
  // the whole of the navigation, and the swarm client has to survive it.
  const gateLoadedAt = await page.evaluate(() => {
    window.__spore_marker = Date.now()
    return window.__spore_marker
  })
  await page.$eval('#address', (input, value) => { input.value = value }, infoHash)
  await page.click('#address-form button')
  await wait(2000)
  check('the address bar navigates without reloading the gate',
    (await page.evaluate(() => window.__spore_marker)) === gateLoadedAt)

  // --- the permission is stored, and bound to the infohash ------------------
  // Not tested across a page reload: reloading kills this tab's client, and it
  // is the only seed here, so there would be no site left to re-open. What can
  // be checked is that the decision is persisted under the right key and that
  // re-opening the site honours it without asking again.
  const stored = await page.evaluate(() => localStorage.getItem('spore.scripts-allowed'))
  check('the permission is stored against the infohash, not a name',
    JSON.parse(stored ?? '[]').includes(infoHash), stored)

  prompts.length = 0
  await page.evaluate(() => { location.hash = '' })
  await wait(1000)
  await page.evaluate(hash => { location.hash = hash }, infoHash)
  const reopened = await settle(page, () => document.getElementById('probe')?.textContent,
    text => text === 'Scripts are on for this site.')
  check('re-opening the site keeps scripts on without asking again',
    reopened === 'Scripts are on for this site.' && prompts.length === 0, reopened)

  await checkKeepingOffline(page, infoHash)
  await checkPublishingByDrop(page)
  await checkSurvivesDeadStorage(page)
  await checkStuckViewerIsDetected(page)
  await checkUncontrolledPageRecovers(page)
  await checkMissingSiteAndHome(page)
  await checkKeptSiteSurvivesReload(page)
}

/**
 * Reading a site must not depend on being able to store one.
 *
 * Browsers set to block site data give a failing or hanging IndexedDB, and the
 * gate used to take that personally: `render()` awaited `isKept()`, and an
 * unopenable database turned into "Spore is broken" rather than "offline
 * storage is unavailable". Simulated here by making `indexedDB.open` hang, the
 * worst case, since a promise that never settles is what actually wedged it.
 */
async function checkSurvivesDeadStorage (page) {
  const wedged = await browser.createBrowserContext()
  const victim = await wedged.newPage()

  await victim.evaluateOnNewDocument(() => {
    indexedDB.open = () => ({ // never fires an event, either way
      set onsuccess (_) {}, set onerror (_) {}, set onblocked (_) {}, set onupgradeneeded (_) {}
    })
  })

  await victim.goto(origin + '/', { waitUntil: 'load' })
  await victim.waitForFunction(
    () => document.getElementById('status').textContent === 'Nothing open',
    { timeout: 30_000 }).catch(() => {})
  check('the gate finishes booting even when IndexedDB never answers',
    (await victim.$eval('#status', el => el.textContent)) === 'Nothing open',
    await victim.$eval('#status', el => el.textContent))

  const hash = await victim.evaluate(async (site, paths) => {
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

  await victim.evaluate(h => { location.hash = h }, hash)
  const shown = await victim.waitForFunction(() => {
    const frame = document.getElementById('viewer')
    return !frame.hidden && frame.src.includes('/webtorrent/')
  }, { timeout: 30_000 }).then(() => true, () => false)
  check('a site still opens when offline storage is unavailable', shown,
    await victim.$eval('#notice', el => el.textContent.slice(0, 80)))

  await wedged.close()
}

/**
 * Publishing through the actual UI, not by calling publish() directly.
 *
 * This is the path a reader uses and it was broken while every other check
 * passed: the drop was only handled on the dashed box, so a folder dropped
 * anywhere else fell through to the browser, which navigated away from the
 * gate to open the file.
 *
 * A real folder drag cannot be synthesised — `webkitGetAsEntry` needs one from
 * the OS — so this covers the wiring and the flat-file fallback around it.
 */
async function checkPublishingByDrop (page) {
  await page.evaluate(() => { location.hash = '' })
  await page.waitForFunction(() => !document.getElementById('welcome').hidden, { timeout: 10_000 })

  const handled = await page.evaluate(() => {
    const data = new DataTransfer()
    data.items.add(new File(['<h1>dropped</h1>'], 'index.html', { type: 'text/html' }))

    const dropOn = target => {
      const event = new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data })
      target.dispatchEvent(event)
      return event.defaultPrevented
    }
    return {
      dropzone: dropOn(document.getElementById('dropzone')),
      body: dropOn(document.body),
      header: dropOn(document.querySelector('.chrome'))
    }
  })
  check('a folder dropped on the drop zone is handled', handled.dropzone)
  check('a folder dropped anywhere else on the page is handled too, not opened by the browser',
    handled.body && handled.header, JSON.stringify(handled))

  await page.waitForFunction(() => !document.getElementById('share').hidden, { timeout: 30_000 })
  const link = await page.$eval('#share-link', input => input.value)
  check('dropping publishes and offers a shareable link', link.includes('#magnet:?xt=urn:btih:'), link.slice(0, 60))

  // Dragging must announce itself across the whole window, or readers aim at
  // the dashed box, miss, and conclude that dropping does not work.
  const overlay = await page.evaluate(() => {
    const data = new DataTransfer()
    data.items.add(new File([''], 'x.html'))
    document.body.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: data }))
    const shown = getComputedStyle(document.getElementById('drop-overlay')).display
    document.body.dispatchEvent(new DragEvent('dragleave', { bubbles: true, cancelable: true, dataTransfer: data }))
    return { shown, hidden: getComputedStyle(document.getElementById('drop-overlay')).display }
  })
  check('dragging a file over the page shows where it can be dropped',
    overlay.shown === 'flex' && overlay.hidden === 'none', JSON.stringify(overlay))
}

/**
 * Keeping a site is the only thing that writes to disk, so it gets checked the
 * same way: nothing stored until asked, and everything gone when forgotten.
 */
async function checkKeepingOffline (page, infoHash) {
  const stored = () => page.evaluate(async () => {
    const { listSites } = await import('/js/idb.js')
    return (await listSites()).map(s => s.infoHash)
  })

  check('nothing is on disk before the reader asks', (await stored()).length === 0)

  prompts.length = 0
  await page.click('#keep-toggle')
  await page.waitForFunction(() => !document.getElementById('kept').hidden, { timeout: 30_000 })
  check('keeping a site on this device asks first',
    prompts.some(text => text.includes('Keep this site on this device?')), prompts[0]?.split('\n')[0])
  check('the site is stored under its infohash', (await stored()).includes(infoHash))
  check('the kept site is listed with a way to forget it',
    await page.$eval('#kept-list', list => list.children.length === 1 &&
      !!list.querySelector('button')))

  // The payoff: a kept site comes back complete, with no peer to ask.
  const restored = await page.evaluate(async hash => {
    const { restoreAll } = await import('/js/keep.js')
    const { getClient } = await import('/js/swarm.js')
    const client = getClient()
    const torrent = await client.get(hash)
    await torrent.destroy()                    // as if the tab had been closed
    const result = await restoreAll(client)
    const back = await client.get(hash)
    return { ...result, done: !!back?.done, progress: back?.progress }
  }, infoHash)
  check('a kept site reloads from disk, complete, with no peers',
    restored.restored === 1 && restored.done === true,
    `restored ${restored.restored}, progress ${restored.progress}`)

  // Kept sites are managed from the welcome screen, so go back to it first.
  await page.evaluate(() => { location.hash = '' })
  await page.waitForFunction(() => !document.getElementById('welcome').hidden, { timeout: 10_000 })
  check('the welcome screen reports what is being seeded from disk',
    (await page.$eval('#peers', el => el.textContent)).includes('1 kept site'),
    await page.$eval('#peers', el => el.textContent))

  await page.click('#kept-list button')
  await page.waitForFunction(() => document.getElementById('kept').hidden, { timeout: 10_000 })
  check('forgetting a site removes it from disk', (await stored()).length === 0)

  const chunks = await page.evaluate(() => new Promise(resolve => {
    const open = indexedDB.open('spore')
    open.onsuccess = () => {
      const count = open.result.transaction('chunks').objectStore('chunks').count()
      count.onsuccess = () => resolve(count.result)
    }
    open.onerror = () => resolve(-1)
  }))
  check('forgetting deletes the stored bytes, not just the record', chunks === 0, `${chunks} chunks left`)
}

/**
 * A site nobody seeds gets a page, and the logo gets you out of it.
 *
 * An infohash with no seeder is the swarm's version of a dead URL, so it earns
 * what a web server gives one: a 404 that explains itself. Uses a hash nothing
 * can possibly be seeding, and a shortened timeout so the check does not sit
 * through the full minute the gate allows a real swarm.
 */
async function checkMissingSiteAndHome (page) {
  const missing = 'ffffffffffffffffffffffffffffffffffffffff'

  // A magnet with a typo in it must be refused at once, not waited on. This is
  // the shape a reader actually hits: one wrong character in a pasted link,
  // which WebTorrent accepts without complaint and then waits out in full.
  await page.evaluate(() => {
    location.hash = 'magnet:?xt=urn:btih:ba62786619c7e7b0ccfdqdd1c660cd24c53e6d8b&dn=x'
  })
  await wait(2500)
  const typo = await page.evaluate(() => ({
    hidden: document.getElementById('error').hidden,
    code: document.getElementById('error-code').textContent,
    detail: document.getElementById('error-detail').textContent.slice(0, 60)
  }))
  check('a magnet with a typo is refused immediately, not waited on',
    typo.hidden === false && typo.code === '???', JSON.stringify(typo))

  // Deliberately the slow path. An earlier version of this check faked the
  // failure by emitting an error on the torrent, which took the generic branch
  // and never exercised the 404 at all — it passed while proving nothing. This
  // waits out the real timeout so the real error travels the real route.
  await page.evaluate(hash => { location.hash = hash }, missing)

  // Polled in short steps rather than one long waitForFunction: the browser is
  // launched with a 30s protocolTimeout, which aborts any single CDP call that
  // outlives it — including a wait. That is what made an earlier version of
  // this check read the page's defaults and report a passing 404 it had never
  // actually seen.
  let shown = false
  for (let waited = 0; waited < 90_000 && !shown; waited += 2000) {
    await wait(2000)
    shown = await page.evaluate(() => !document.getElementById('error').hidden)
  }

  const view = await page.evaluate(() => ({
    code: document.getElementById('error-code').textContent,
    title: document.getElementById('error-title').textContent,
    ref: document.getElementById('error-ref').textContent,
    welcomeHidden: document.getElementById('welcome').hidden,
    viewerHidden: document.getElementById('viewer').hidden
  }))
  check('a site nobody is seeding gets a 404 page, not a red line',
    shown && view.code === '404' && view.viewerHidden, JSON.stringify(view))
  check('the missing-site page names the address that failed',
    view.ref === missing, view.ref)

  // The landing page's own field is the primary call to action, so it has to
  // navigate exactly like the address bar in the chrome does.
  await page.click('#home')
  await page.waitForFunction(() => !document.getElementById('welcome').hidden, { timeout: 10_000 })
  await page.$eval('#visit', (input, value) => { input.value = value }, missing)
  await page.click('#visit-form button')
  await wait(1500)
  check('the landing page field opens what it is given',
    (await page.evaluate(() => location.hash)) === '#' + missing,
    await page.evaluate(() => location.hash))

  // The logo is the way back, and it should leave a clean URL behind it.
  await page.click('#home')
  await page.waitForFunction(() => !document.getElementById('welcome').hidden, { timeout: 10_000 })
  const home = await page.evaluate(() => ({
    hash: location.hash,
    welcome: !document.getElementById('welcome').hidden,
    error: document.getElementById('error').hidden
  }))
  check('the logo goes home, leaving no stray fragment behind',
    home.welcome && home.error && home.hash === '', JSON.stringify(home))

  // And the browser's own back button still works across that transition.
  await page.goBack()
  await wait(1500)
  check('back returns to the address that was open',
    (await page.evaluate(() => location.hash)) === '#' + missing,
    await page.evaluate(() => location.hash))
  await page.evaluate(() => history.pushState(null, '', location.pathname))
  await page.evaluate(() => { location.hash = '' })
}

/**
 * A kept site survives a reload with nobody seeding it.
 *
 * The reported sequence: keep a site, close the tab that published it, reload.
 * The site was lost — which is precisely what keeping it is supposed to
 * prevent. Reloading discards the client, so after it there is no peer
 * anywhere and the only possible source is IndexedDB.
 */
async function checkKeptSiteSurvivesReload (page) {
  const kept = await browser.createBrowserContext()
  const victim = await kept.newPage()
  victim.on('dialog', async dialog => { await dialog.accept() })

  await victim.goto(origin + '/', { waitUntil: 'load' })
  await victim.waitForFunction(
    () => document.getElementById('status').textContent === 'Nothing open', { timeout: 30_000 })

  const hash = await victim.evaluate(async (site, paths) => {
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

  await victim.evaluate(h => { location.hash = h }, hash)
  await victim.waitForFunction(() => {
    const frame = document.getElementById('viewer')
    return !frame.hidden && frame.src.includes('/webtorrent/')
  }, { timeout: 30_000 })

  await victim.click('#keep-toggle')
  await victim.waitForFunction(() => !document.getElementById('kept').hidden, { timeout: 30_000 })

  // The reload throws the swarm client away. Nothing else has these bytes.
  await victim.reload({ waitUntil: 'load' })

  let rendered = false
  for (let waited = 0; waited < 45_000 && !rendered; waited += 2000) {
    await wait(2000)
    rendered = await victim.evaluate(() => {
      const frame = document.getElementById('viewer')
      return !frame.hidden && frame.src.includes('/webtorrent/')
    })
  }
  check('a kept site comes back after a reload with nobody seeding it', rendered,
    await victim.evaluate(() => document.getElementById('error-title').textContent ||
      document.getElementById('notice').textContent))

  if (rendered) {
    const frame = victim.frames().find(f => f.url().includes('/webtorrent/'))
    const heading = await frame?.evaluate(() => document.querySelector('h1')?.textContent)
    check('and it renders from disk, not from a peer', heading === 'Hello from a spore', heading)
  }

  await kept.close()
}

/**
 * An uncontrolled page must recover on its own.
 *
 * Reported from Chromium as `Worker controlling: NO` with a registration
 * present at `/` — the worker installed and simply never took this page over.
 * A hard reload produces exactly that state, and `clients.claim()` only runs on
 * activate, which happened long before. Asking the worker to claim is the fix;
 * this checks the ask works, starting from a genuinely uncontrolled page.
 */
async function checkUncontrolledPageRecovers (page) {
  const recovered = await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.getRegistration()
    const before = !!navigator.serviceWorker.controller

    const claimed = await new Promise(resolve => {
      const { port1, port2 } = new MessageChannel()
      const timer = setTimeout(() => resolve(null), 3000)
      port1.onmessage = ({ data }) => { clearTimeout(timer); resolve(data) }
      registration.active.postMessage({ type: 'spore/claim' }, [port2])
    })
    return { before, claimed, after: !!navigator.serviceWorker.controller }
  })

  // Honest about what this proves. A page that is genuinely uncontrolled
  // cannot be manufactured here — a hard reload is the way to get one and no
  // automation API performs one — so this covers the round-trip and the
  // resulting state, not the recovery itself. The recovery is the same call.
  check('the worker answers a request to claim this page',
    recovered.claimed?.claimed === true, JSON.stringify(recovered))
  check('the page is controlled after claiming', recovered.after === true, JSON.stringify(recovered))
}

/**
 * A viewer that never navigates must be detected, not left blank.
 *
 * Reported as "I see the frame of the website but not the content", with the
 * only trace a console line showing the frame still on about:blank. The silence
 * was as much the bug as the blank frame.
 *
 * Driving Viewer directly is deliberate. The obvious approach — blocking the
 * frame's request — cannot work, and finding out why was the useful part: the
 * service worker answers that request, so it never reaches the network layer an
 * automation tool can interfere with. A URL the gate's own `frame-src` refuses
 * leaves the frame exactly where the report described it.
 */
async function checkStuckViewerIsDetected (page) {
  const result = await page.evaluate(async () => {
    const { Viewer } = await import('/js/viewer.js')
    const frame = document.createElement('iframe')
    frame.src = 'about:blank'
    document.body.append(frame)
    const viewer = new Viewer(frame)

    const refused = await viewer.show('https://example.invalid/nope.html', { scripts: false })
    const accepted = await viewer.show(location.origin + '/example-site/index.html', { scripts: false })
    frame.remove()
    return { refused, accepted }
  })

  check('a viewer that never navigates is detected', result.refused === false, JSON.stringify(result))
  check('a viewer that does navigate is not falsely accused', result.accepted === true, JSON.stringify(result))
}

/**
 * Read something out of the site frame until it settles on an expected value.
 * The frame reloads underneath us whenever the policy changes, so a fixed sleep
 * either flakes or wastes time.
 */
async function settle (page, read, done, attempts = 40) {
  let last
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      last = await (await siteFrame(page)).evaluate(read)
      if (done(last)) return last
    } catch { /* the frame is mid-navigation; try again */ }
    await wait(250)
  }
  return last
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
