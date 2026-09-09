/**
 * Wiring: URL fragment and user input in, rendered site out.
 *
 * The gate is one static page. Navigating between sites only rewrites the
 * fragment — the gate itself is never reloaded, and the fragment is never sent
 * to whichever host is serving this bundle.
 */

import { collectDiagnostics, resetBrowserState } from './diagnostics.js'
import { openDatabase, usage } from './idb.js'
import { KEEP_WARNING, forget, isKept, keep, keptSites, restoreAll, restoreOne } from './keep.js'
import { InvalidSiteRef, magnetFor, parseSiteRef } from './magnet.js'
import { scriptsAllowed, servePolicyQueries, setScriptsAllowed } from './policy.js'
import { filesFromDrop, filesFromInput, publish } from './publish.js'
import { entryURL, findEntry } from './site.js'
import { SiteNotFound, getClient, openTorrent, startClient, startWorker } from './swarm.js'
import { Viewer } from './viewer.js'

const el = id => document.getElementById(id)

const ui = {
  address: el('address'),
  addressForm: el('address-form'),
  visit: el('visit'),
  visitForm: el('visit-form'),
  viewer: new Viewer(el('viewer')),
  welcome: el('welcome'),
  notice: el('notice'),
  status: el('status'),
  peers: el('peers'),
  progress: el('progress'),
  scripts: el('scripts-toggle'),
  scriptsLabel: el('scripts-label'),
  keep: el('keep-toggle'),
  keepLabel: el('keep-label'),
  kept: el('kept'),
  keptList: el('kept-list'),
  keptUsage: el('kept-usage'),
  share: el('share'),
  shareLink: el('share-link'),
  copy: el('copy'),
  shareDismiss: el('share-dismiss'),
  home: el('home'),
  error: el('error'),
  errorCode: el('error-code'),
  errorTitle: el('error-title'),
  errorDetail: el('error-detail'),
  errorRef: el('error-ref'),
  errorRetry: el('error-retry'),
  errorHome: el('error-home'),
  listing: el('listing'),
  listingName: el('listing-name'),
  listingSummary: el('listing-summary'),
  listingFiles: el('listing-files'),
  saveTorrent: el('save-torrent'),
  diagnose: el('diagnose'),
  diagnostics: el('diagnostics'),
  diagnosticsBody: el('diagnostics-body'),
  diagnosticsReset: el('diagnostics-reset'),
  diagnosticsClose: el('diagnostics-close'),
  dropzone: el('dropzone'),
  folder: el('folder-input')
}

/** The site on screen, or null. @type {{torrent: object, ref: string}|null} */
let current = null
let statsTimer = null
/** True once the swarm client exists; until then there is nothing to publish to. */
let ready = false

/** Infohashes kept on this device, refreshed whenever the list changes. */
let keptHashes = new Set()

boot()

async function boot () {
  servePolicyQueries()

  // Wired before anything is awaited. If the worker is slow to take over, or
  // never does, the page still responds — and a dropped folder is still caught
  // rather than handed to the browser, which would navigate away from Spore.
  window.addEventListener('hashchange', () => route())
  // pushState does not fire hashchange, and going home uses it so the URL is
  // left clean rather than trailing a bare '#'. Back and forward need this too.
  window.addEventListener('popstate', () => route())
  ui.home.addEventListener('click', goHome)
  ui.errorHome.addEventListener('click', goHome)
  ui.errorRetry.addEventListener('click', () => { current = null; route() })
  ui.addressForm.addEventListener('submit', onAddressSubmit)
  ui.visitForm.addEventListener('submit', onAddressSubmit)
  ui.scripts.addEventListener('change', onScriptsToggle)
  ui.keep.addEventListener('change', onKeepToggle)
  ui.copy.addEventListener('click', onCopy)
  ui.shareDismiss.addEventListener('click', () => { ui.share.hidden = true })
  ui.saveTorrent.addEventListener('click', onSaveTorrent)
  ui.diagnose.addEventListener('click', showDiagnostics)
  ui.diagnosticsClose.addEventListener('click', () => ui.diagnostics.close())
  ui.diagnosticsReset.addEventListener('click', onReset)
  wireDropTarget()

  try {
    const registration = await startWorker()
    startClient(registration)
  } catch (err) {
    return fail(err)
  }
  ready = true

  // Storage being unavailable is survivable — keeping sites offline is not —
  // but the reader should know, because it also explains a lot of odd
  // behaviour in a browser that is blocking site data.
  if (!(await storageWorks())) {
    console.warn('Spore: IndexedDB is unavailable, so sites cannot be kept offline.')
    ui.keepLabel.title = 'Unavailable: this browser is blocking site data.'
  }

  // Deliberately not awaited. Restoring kept sites is a convenience; reading
  // the site in the URL is the point. Blocking one on the other meant that a
  // browser with unhealthy storage never got as far as opening anything, which
  // reads as "Spore is broken" rather than "offline storage is unavailable".
  //
  // The cost is a race: landing directly on a kept site can add a second,
  // memory-backed copy of a torrent already being restored. WebTorrent returns
  // the existing torrent for a duplicate infohash, so the loser is discarded.
  restoreKept()

  route()
}

/* -------------------------------------------------------------------------- */
/* Navigation                                                                  */
/* -------------------------------------------------------------------------- */

function currentRef () {
  return decodeURIComponent(location.hash.replace(/^#/, ''))
}

/** Navigate by rewriting the fragment; `route` does the work on the way back. */
function navigate (ref) {
  const encoded = `#${ref}`
  if (location.hash === encoded) route()
  else location.hash = encoded
}

/**
 * Back to the start, from the logo or from a missing-site page.
 *
 * `pushState` rather than clearing `location.hash`, which would leave a bare
 * '#' hanging off the URL. It does not fire `hashchange`, so routing is called
 * directly; `popstate` is wired so the browser's own back button still works.
 */
function goHome () {
  if (!location.hash) return
  history.pushState(null, '', location.pathname + location.search)
  route()
}

/** The reference currently being opened, if any. */
let opening = null

/**
 * Routing has to tolerate being called twice for the same address.
 *
 * A single hash change can reach here more than once — `hashchange` and
 * `popstate` both fire for one — and `open` is asynchronous, so two calls
 * could each look for the torrent, each find nothing, and each add it. The
 * second add fails with "Cannot add duplicate torrent", which surfaced as a
 * generic error instead of the site, or instead of an honest 404.
 */
async function route () {
  const ref = currentRef()
  if (!ref) return showWelcome()
  if (current?.ref === ref || opening === ref) return

  opening = ref
  try {
    await open(ref)
  } finally {
    if (opening === ref) opening = null
  }
}

async function open (ref) {
  let parsed
  try {
    parsed = parseSiteRef(ref)
  } catch (err) {
    return fail(err)
  }

  ui.address.value = ref
  busy('Looking for peers…')

  try {
    // Disk before swarm. A site kept on this device must come back from
    // storage even when nobody at all is seeding it — that is the entire point
    // of keeping it — and asking the swarm first would race the background
    // restore and often win, leaving the stored copy untouched.
    if (parsed.infoHash) await restoreOne(getClient(), parsed.infoHash)

    const torrent = await openTorrent(parsed.magnetURI, watchJoining)
    stopJoining()

    const entry = findEntry(torrent)

    // Without a controller the iframe's request never reaches the worker and
    // the reader gets the host's 404 instead of the site. Better to say so.
    if (!navigator.serviceWorker.controller) {
      throw new Error(
        'Spore found the site but cannot display it: the service worker is not ' +
        'running. Reload the page. (Service workers need HTTPS, and are ' +
        'disabled in Firefox private windows.)')
    }

    current = { torrent, ref }

    // A torrent without an index.html is not a broken site, it is not a site.
    // Refusing it outright made a whole category of torrent — an archive, an
    // album, a dataset — a dead end, when its contents are perfectly readable.
    if (entry) await render(torrent, entry)
    else showListing(torrent)
  } catch (err) {
    stopJoining()
    fail(err)
  }
}

/**
 * Say what is actually happening while waiting for a swarm.
 *
 * "Looking for peers…" on its own is indistinguishable from a hung page, a
 * dead tracker and a site nobody is seeding — all three of which look like
 * "it doesn't work". Peer counts, elapsed time and tracker complaints tell
 * those three apart without opening a console.
 */
let joiningTimer = null

function watchJoining (torrent) {
  stopJoining()
  const startedAt = Date.now()
  const trackerProblems = new Set()

  const onWarning = err => {
    const message = String(err?.message ?? err)
    const tracker = /(wss?:\/\/[^\s/]+)/.exec(message)
    if (tracker) trackerProblems.add(tracker[1])
  }
  torrent.on('warning', onWarning)

  const tick = () => {
    const seconds = Math.round((Date.now() - startedAt) / 1000)
    const found = torrent.numPeers === 1 ? '1 peer' : `${torrent.numPeers} peers`
    const trouble = trackerProblems.size > 0
      ? ` · ${trackerProblems.size} tracker${trackerProblems.size === 1 ? '' : 's'} unreachable`
      : ''
    busy(`Looking for peers… ${found} after ${seconds}s${trouble}` +
      (seconds >= 8 && torrent.numPeers === 0 ? ' · nobody has answered yet' : ''))
    ui.peers.textContent = found
  }
  tick()

  joiningTimer = setInterval(tick, 1000)
  torrent.once('metadata', stopJoining)
}

function stopJoining () {
  clearInterval(joiningTimer)
  joiningTimer = null
}

async function render (torrent, entry) {
  const allowed = scriptsAllowed(torrent.infoHash)

  ui.scripts.checked = allowed
  ui.scripts.disabled = false
  ui.scriptsLabel.hidden = false
  ui.keep.checked = await isKept(torrent.infoHash)
  ui.keep.disabled = false
  ui.keepLabel.hidden = false
  ui.saveTorrent.hidden = false
  const shown = ui.viewer.show(entryURL(torrent.infoHash, entry), { scripts: allowed })
  ui.welcome.hidden = true
  ui.notice.hidden = true
  ui.error.hidden = true
  ui.status.textContent = torrent.name ?? torrent.infoHash

  watchStats(torrent)

  // Awaited last, deliberately: this only reports a frame that never navigated
  // and must not hold up one that does.
  if (!(await shown)) warnViewerStuck()
}

/**
 * The viewer never left `about:blank`.
 *
 * Nothing else notices this — the torrent is complete, the worker is running,
 * every indicator reads healthy, and the reader is looking at an empty frame
 * with nothing in the console. It was reported exactly that way. Say it out
 * loud, and put the whole diagnostic picture where a reader will copy it from.
 */
async function warnViewerStuck () {
  // The message goes up first: collecting diagnostics probes the network and
  // takes seconds, and the reader is already staring at an empty rectangle.
  ui.notice.textContent =
    'The site downloaded but the viewer stayed blank. Open Diagnostics in the ' +
    'status bar — the "Viewer response" line says what the service worker ' +
    'returned for it. The full picture is in the browser console too.'
  ui.notice.className = 'notice notice--error'
  ui.notice.hidden = false

  console.warn('Spore: the viewer never navigated. Full diagnostics follow.')
  try {
    console.table(await collectDiagnostics())
  } catch (err) {
    console.warn('Spore: diagnostics could not be collected:', err)
  }
}

const SCRIPTS_WARNING = `Run this site's scripts?

Spore has to serve sites from its own origin — a service worker cannot reach a
sandboxed frame — so a site with scripts enabled can also tamper with Spore's
own address bar and controls. It still cannot reach the network outside its
torrent, and this does not apply to any other site.

Only enable this for a site you trust.`

/**
 * Flipping the switch reloads the site: the policy travels on response headers,
 * so the document has to be fetched again to be governed by the new one.
 * Reloading also discards whatever the previous, script-less document did.
 */
async function onScriptsToggle () {
  if (!current) return
  const { torrent } = current

  // Granting scripts is the one decision in the gate that gives something up,
  // so it is the one that asks. Turning them back off never does.
  if (ui.scripts.checked && !confirm(SCRIPTS_WARNING)) {
    ui.scripts.checked = false
    return
  }

  setScriptsAllowed(torrent.infoHash, ui.scripts.checked)

  const entry = findEntry(torrent)
  const shown = await ui.viewer.show(entryURL(torrent.infoHash, entry), { scripts: ui.scripts.checked })
  if (!shown) warnViewerStuck()
}

/* -------------------------------------------------------------------------- */
/* Keeping sites on this device                                                */
/* -------------------------------------------------------------------------- */

/**
 * The other decision that gives something up, so it asks too. Turning it off
 * deletes the data and never asks — undoing a choice should not be a negotiation.
 */
async function onKeepToggle () {
  if (!current) return
  const { torrent } = current

  if (!ui.keep.checked) {
    await forget(torrent.infoHash)
    await refreshKeptList()
    return
  }

  if (!confirm(KEEP_WARNING)) {
    ui.keep.checked = false
    return
  }

  ui.keep.disabled = true
  try {
    await keep(torrent, (done, total) => {
      ui.progress.textContent = `keeping ${Math.round((done / total) * 100)}%`
    })
    await refreshKeptList()
  } catch (err) {
    ui.keep.checked = false
    fail(err)
  } finally {
    ui.keep.disabled = false
  }
}

/** Whether this browser will let us store anything at all. */
async function storageWorks () {
  try {
    await openDatabase()
    return true
  } catch {
    return false
  }
}

async function restoreKept () {
  try {
    const { failed } = await restoreAll(getClient())
    if (failed.length > 0) {
      console.warn(`Spore: ${failed.length} kept site(s) could not be restored:`, failed)
    }
  } catch (err) {
    // Storage can be unavailable outright (private mode, blocked cookies).
    // That costs the reader the kept sites, not the gate.
    console.warn('Spore: offline storage is unavailable.', err)
  }
  await refreshKeptList()
}

async function refreshKeptList () {
  let sites
  try {
    sites = await keptSites()
  } catch {
    return
  }

  keptHashes = new Set(sites.map(site => site.infoHash))
  ui.kept.hidden = sites.length === 0
  ui.keptList.replaceChildren(...sites.map(renderKeptSite))
  if (!ui.welcome.hidden) showSeedingCount()

  const { usage: used, quota } = await usage()
  ui.keptUsage.textContent = quota
    ? `${formatBytes(used)} used of roughly ${formatBytes(quota)} this browser allows.`
    : ''
}

function renderKeptSite (site) {
  const item = document.createElement('li')

  const link = document.createElement('a')
  link.href = `#${site.infoHash}`
  link.textContent = site.name || site.infoHash
  item.append(link)

  const size = document.createElement('span')
  size.className = 'muted'
  size.textContent = formatBytes(site.length)
  item.append(size)

  const drop = document.createElement('button')
  drop.type = 'button'
  drop.textContent = 'Forget'
  drop.addEventListener('click', async () => {
    await forget(site.infoHash)
    if (current?.torrent.infoHash === site.infoHash) ui.keep.checked = false
    await refreshKeptList()
  })
  item.append(drop)

  return item
}

/* -------------------------------------------------------------------------- */

/**
 * Show what is in a torrent that is not a website.
 *
 * Plenty of torrents are archives, albums, datasets — no `index.html`, and
 * nothing wrong with them. Rejecting those made Spore useless for a whole
 * category of content whose files it can serve perfectly well, so it lists
 * them instead and lets the reader open one.
 *
 * Each file opens in the same sandboxed viewer a site would, under the same
 * policy, so a video plays and a text file renders without the torrent gaining
 * anything a site would not have.
 */
function showListing (torrent) {
  const files = [...torrent.files].sort((a, b) => a.path.localeCompare(b.path))

  ui.listingName.textContent = torrent.name ?? torrent.infoHash
  ui.listingSummary.textContent =
    `${files.length} file${files.length === 1 ? '' : 's'} · ${formatBytes(torrent.length)}`
  ui.listingFiles.replaceChildren(...files.map(file => listedFile(torrent, file)))

  ui.listing.hidden = false
  ui.notice.hidden = true
  ui.welcome.hidden = true
  ui.error.hidden = true
  ui.viewer.clear()

  ui.scripts.disabled = true
  ui.scriptsLabel.hidden = true
  ui.keep.checked = false
  ui.keepLabel.hidden = false
  ui.keep.disabled = false
  ui.saveTorrent.hidden = false
  ui.status.textContent = torrent.name ?? torrent.infoHash

  watchStats(torrent)
}

function listedFile (torrent, file) {
  const path = file.path.replace(/\\/g, '/')

  const name = document.createElement('span')
  name.className = 'path'
  name.textContent = path

  const size = document.createElement('span')
  size.className = 'size'
  size.textContent = formatBytes(file.length)

  const open = document.createElement('button')
  open.type = 'button'
  open.append(name, size)
  // Never with scripts: nothing here has been opted in, and a file picked out
  // of a listing has had even less scrutiny than a site someone linked to.
  open.addEventListener('click', () => {
    ui.listing.hidden = true
    ui.viewer.show(entryURL(torrent.infoHash, path), { scripts: false })
  })

  const item = document.createElement('li')
  item.append(open)
  return item
}

/**
 * Hand the .torrent to something that can seed it around the clock.
 *
 * A browser stops seeding when its tab closes, so a site that should stay up
 * needs a seeder outside the browser (tools/seed.mjs is one). Re-creating the
 * torrent from the same folder does not reliably reproduce the same infohash,
 * and a different infohash is a different site with a different link — so the
 * exact torrent has to travel, not just the files.
 */
function onSaveTorrent () {
  if (!current) return
  const { torrent } = current

  const blob = new Blob([torrent.torrentFile], { type: 'application/x-bittorrent' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `${torrent.name ?? torrent.infoHash}.torrent`
  link.click()
  URL.revokeObjectURL(url)
}

/* -------------------------------------------------------------------------- */
/* Diagnostics                                                                 */
/* -------------------------------------------------------------------------- */

async function showDiagnostics () {
  ui.diagnosticsBody.replaceChildren()
  ui.diagnostics.showModal()

  for (const row of await collectDiagnostics()) {
    const term = document.createElement('dt')
    term.textContent = row.label
    const value = document.createElement('dd')
    value.textContent = row.value
    if (row.ok === true) value.className = 'good'
    if (row.ok === false) value.className = 'bad'
    ui.diagnosticsBody.append(term, value)
  }
}

async function onReset () {
  if (!confirm(
    'Reset Spore in this browser?\n\n' +
    "This unregisters Spore's service worker and deletes everything it has " +
    'stored here, including any sites kept offline. Nothing outside Spore is ' +
    'touched. The page will reload.')) return

  ui.diagnosticsReset.disabled = true
  const problems = await resetBrowserState()
  if (problems.length > 0) console.warn('Spore: reset left some state behind:', problems)
  location.reload()
}

/**
 * Shared by the address bar and the landing page's own field: the same action,
 * offered where a reader already is rather than only in the chrome.
 */
function onAddressSubmit (event) {
  event.preventDefault()
  const field = event.target === ui.visitForm ? ui.visit : ui.address
  const value = field.value.trim()
  if (value) navigate(value)
}

/* -------------------------------------------------------------------------- */
/* Publishing                                                                  */
/* -------------------------------------------------------------------------- */

/** Does this drag carry files, as opposed to selected text or a link? */
function draggingFiles (event) {
  return [...(event.dataTransfer?.types ?? [])].includes('Files')
}

/**
 * Publishing by drag and drop, handled across the whole window.
 *
 * Listening only on the dashed box was a bug worth naming: a folder dropped
 * anywhere else — which is most of the page — fell through to the browser,
 * which navigated away from Spore to open the file. From the reader's side
 * that is indistinguishable from "drag and drop does not work".
 *
 * So the window cancels every file drag it sees. Nothing is ever handed to the
 * browser's default handler, wherever it lands.
 */
function wireDropTarget () {
  // dragenter/dragleave fire for every element the pointer crosses, so count
  // depth rather than trusting a single leave to mean the drag is over.
  let depth = 0
  const highlight = on => {
    document.body.classList.toggle('is-dragging', on)
    ui.dropzone.classList.toggle('is-active', on)
  }

  window.addEventListener('dragenter', event => {
    if (!draggingFiles(event)) return
    event.preventDefault()
    depth++
    highlight(true)
  })

  window.addEventListener('dragover', event => {
    if (!draggingFiles(event)) return
    event.preventDefault() // without this the drop never fires at all
    event.dataTransfer.dropEffect = 'copy'
  })

  window.addEventListener('dragleave', event => {
    if (!draggingFiles(event)) return
    if (--depth <= 0) { depth = 0; highlight(false) }
  })

  window.addEventListener('drop', async event => {
    if (!draggingFiles(event)) return
    event.preventDefault()
    depth = 0
    highlight(false)

    const { files, name } = await filesFromDrop(event.dataTransfer)
    seed(files, name)
  })

  ui.folder.addEventListener('change', () => {
    const { files, name } = filesFromInput(ui.folder)
    seed(files, name)
    ui.folder.value = '' // let the same folder be picked twice
  })
}

async function seed (files, name) {
  if (!ready) {
    return fail(new Error('Spore is still starting up. Try that again in a moment.'))
  }
  busy(`Hashing ${files.length} file${files.length === 1 ? '' : 's'}…`)
  try {
    const torrent = await publish(files, name)
    const magnet = magnetFor(torrent.infoHash, torrent.name)
    showShareLink(magnet)
    navigate(magnet)
  } catch (err) {
    fail(err)
  }
}

function showShareLink (magnet) {
  const link = new URL(location.href)
  link.hash = magnet
  ui.shareLink.value = link.href
  ui.share.hidden = false
}

async function onCopy () {
  try {
    await navigator.clipboard.writeText(ui.shareLink.value)
    ui.copy.textContent = 'Copied'
  } catch {
    ui.shareLink.select() // no clipboard permission: let the user copy it
    ui.copy.textContent = 'Press ⌘/Ctrl+C'
  }
  setTimeout(() => { ui.copy.textContent = 'Copy link' }, 2000)
}

/* -------------------------------------------------------------------------- */
/* Chrome                                                                      */
/* -------------------------------------------------------------------------- */

function showWelcome () {
  current = null
  stopStats()
  ui.viewer.clear()
  ui.welcome.hidden = false
  ui.notice.hidden = true
  ui.error.hidden = true
  ui.listing.hidden = true
  ui.address.value = ''
  ui.visit.value = ''
  ui.scripts.disabled = true
  ui.scriptsLabel.hidden = true
  ui.keep.disabled = true
  ui.keepLabel.hidden = true
  ui.saveTorrent.hidden = true
  ui.status.textContent = 'Nothing open'
  showSeedingCount()
  ui.progress.textContent = ''
}

/**
 * Kept sites are seeded from the moment the gate opens, so say so when idle.
 * Counted off the client rather than off the stored list: a site whose pieces
 * failed to verify is kept but is not being seeded, and claiming otherwise
 * would be a lie about availability.
 */
function showSeedingCount () {
  const seeding = getClient().torrents.filter(t => keptHashes.has(t.infoHash) && t.done).length
  ui.peers.textContent = seeding > 0 ? `seeding ${seeding} kept site${seeding === 1 ? '' : 's'}` : ''
}

function busy (message) {
  ui.notice.textContent = message
  ui.notice.className = 'notice'
  ui.notice.hidden = false
  ui.welcome.hidden = true
  ui.error.hidden = true
  ui.listing.hidden = true
}

/**
 * Something went wrong opening a site — show a page about it, not a red line.
 *
 * A site nobody is seeding is by far the commonest of these, and it is not a
 * malfunction: it is the swarm equivalent of a URL that no longer resolves. It
 * gets what a web server would give it, a 404 page that says what happened and
 * offers somewhere to go next.
 */
function fail (error) {
  current = null
  stopStats()
  ui.viewer.clear()

  const { code, title, detail, retry } = describe(error)
  ui.errorCode.textContent = code
  ui.errorTitle.textContent = title
  ui.errorDetail.textContent = detail
  ui.errorRef.textContent = currentRef() || ''
  ui.errorRef.parentElement.hidden = !currentRef()
  ui.errorRetry.hidden = !retry

  ui.error.hidden = false
  ui.notice.hidden = true
  ui.welcome.hidden = true
  ui.listing.hidden = true
  ui.scripts.disabled = true
  ui.scriptsLabel.hidden = true
  ui.keep.disabled = true
  ui.keepLabel.hidden = true
  ui.status.textContent = title
  ui.peers.textContent = ''
  ui.progress.textContent = ''
}

/** Turn a failure into something worth reading. */
function describe (error) {
  if (error instanceof SiteNotFound) {
    return {
      code: '404',
      title: 'This site could not be found',
      detail:
        'No peer answered for it. A site exists only while somebody is seeding ' +
        'it: the tab that published it has to stay open, and so does at least ' +
        'one tab that has it open. If everyone has closed theirs, the site is ' +
        'dormant until someone with a copy opens it again — the bytes are not ' +
        'lost, there is just nobody holding them right now.',
      retry: true
    }
  }
  if (error instanceof InvalidSiteRef) {
    return {
      code: '???',
      title: 'That is not a site address',
      detail: error.message + ' A site address is a magnet link, or the 40-character ' +
        'infohash inside one.',
      retry: false
    }
  }
  return {
    code: ':(',
    title: 'This site could not be opened',
    detail: error instanceof Error ? error.message : String(error),
    retry: true
  }
}

function watchStats (torrent) {
  stopStats()
  const tick = () => {
    ui.peers.textContent = `${torrent.numPeers} peer${torrent.numPeers === 1 ? '' : 's'}`
    ui.progress.textContent = torrent.done
      ? `${formatBytes(torrent.length)} · seeding`
      : `${Math.round(torrent.progress * 100)}% of ${formatBytes(torrent.length)}`
  }
  tick()
  statsTimer = setInterval(tick, 1000)
}

function stopStats () {
  clearInterval(statsTimer)
  statsTimer = null
}

function formatBytes (bytes) {
  const units = ['B', 'kB', 'MB', 'GB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value < 10 && unit > 0 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`
}
