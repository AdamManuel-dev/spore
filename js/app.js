/**
 * Wiring: URL fragment and user input in, rendered site out.
 *
 * The gate is one static page. Navigating between sites only rewrites the
 * fragment — the gate itself is never reloaded, and the fragment is never sent
 * to whichever host is serving this bundle.
 */

import { usage } from './idb.js'
import { KEEP_WARNING, forget, isKept, keep, keptSites, restoreAll } from './keep.js'
import { InvalidSiteRef, magnetFor, parseSiteRef } from './magnet.js'
import { scriptsAllowed, servePolicyQueries, setScriptsAllowed } from './policy.js'
import { filesFromDrop, filesFromInput, publish } from './publish.js'
import { entryURL, findEntry } from './site.js'
import { getClient, openTorrent, startClient, startWorker } from './swarm.js'
import { Viewer } from './viewer.js'

const el = id => document.getElementById(id)

const ui = {
  address: el('address'),
  addressForm: el('address-form'),
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
  dropzone: el('dropzone'),
  folder: el('folder-input')
}

/** The site on screen, or null. @type {{torrent: object, ref: string}|null} */
let current = null
let statsTimer = null
/** Infohashes kept on this device, refreshed whenever the list changes. */
let keptHashes = new Set()

boot()

async function boot () {
  servePolicyQueries()
  try {
    const registration = await startWorker()
    startClient(registration)
  } catch (err) {
    return fail(err)
  }

  window.addEventListener('hashchange', () => route())
  ui.addressForm.addEventListener('submit', onAddressSubmit)
  ui.scripts.addEventListener('change', onScriptsToggle)
  ui.keep.addEventListener('change', onKeepToggle)
  ui.copy.addEventListener('click', onCopy)
  wireDropTarget()

  // Kept sites come back before routing, so landing straight on one opens it
  // from disk instead of racing to add a second copy of the same torrent.
  await restoreKept()

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

async function route () {
  const ref = currentRef()
  if (!ref) return showWelcome()
  if (current?.ref === ref) return

  await open(ref)
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
    const torrent = await openTorrent(parsed.magnetURI)
    const entry = findEntry(torrent)
    if (!entry) throw new Error(`“${torrent.name}” has no index.html, so there is no page to show.`)

    current = { torrent, ref }
    await render(torrent, entry)
  } catch (err) {
    fail(err)
  }
}

async function render (torrent, entry) {
  const allowed = scriptsAllowed(torrent.infoHash)

  ui.scripts.checked = allowed
  ui.scripts.disabled = false
  ui.scriptsLabel.hidden = false
  ui.keep.checked = await isKept(torrent.infoHash)
  ui.keep.disabled = false
  ui.keepLabel.hidden = false
  ui.viewer.show(entryURL(torrent.infoHash, entry), { scripts: allowed })
  ui.welcome.hidden = true
  ui.notice.hidden = true
  ui.status.textContent = torrent.name ?? torrent.infoHash

  watchStats(torrent)
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
  await ui.viewer.show(entryURL(torrent.infoHash, entry), { scripts: ui.scripts.checked })
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

function onAddressSubmit (event) {
  event.preventDefault()
  const value = ui.address.value.trim()
  if (value) navigate(value)
}

/* -------------------------------------------------------------------------- */
/* Publishing                                                                  */
/* -------------------------------------------------------------------------- */

function wireDropTarget () {
  const zone = ui.dropzone

  // Without cancelling dragover the browser navigates away to the dropped file.
  for (const type of ['dragenter', 'dragover']) {
    zone.addEventListener(type, event => {
      event.preventDefault()
      zone.classList.add('is-active')
    })
  }
  for (const type of ['dragleave', 'drop']) {
    zone.addEventListener(type, () => zone.classList.remove('is-active'))
  }

  zone.addEventListener('drop', async event => {
    event.preventDefault()
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
  ui.address.value = ''
  ui.scripts.disabled = true
  ui.scriptsLabel.hidden = true
  ui.keep.disabled = true
  ui.keepLabel.hidden = true
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
}

function fail (error) {
  current = null
  stopStats()
  ui.viewer.clear()
  ui.notice.textContent = error instanceof InvalidSiteRef || error instanceof Error
    ? error.message
    : String(error)
  ui.notice.className = 'notice notice--error'
  ui.notice.hidden = false
  ui.welcome.hidden = true
  ui.status.textContent = 'Failed'
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
