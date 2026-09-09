/**
 * What state is this browser actually in?
 *
 * Spore depends on a service worker and, optionally, on IndexedDB. Both can be
 * switched off by a browser setting, and a service worker can outlive the code
 * that installed it. When that happens the gate simply does not work, and the
 * reader has no way to tell which of those it is — so this reports it, and
 * offers the one repair that fixes a profile left in a bad state.
 */

export async function collectDiagnostics () {
  const rows = []
  const add = (label, value, ok) => rows.push({ label, value, ok })

  add('Page origin', location.origin, null)
  add('Secure context', window.isSecureContext ? 'yes' : 'no — service workers need HTTPS',
    window.isSecureContext)

  if (!('serviceWorker' in navigator)) {
    add('Service worker', 'not supported by this browser', false)
  } else {
    const controller = navigator.serviceWorker.controller
    add('Worker controlling', controller ? 'yes' : 'NO — sites cannot be displayed', !!controller)
    if (controller) add('Worker script', controller.scriptURL.replace(location.origin, ''), null)

    try {
      const registrations = await navigator.serviceWorker.getRegistrations()
      add('Registrations', registrations.length
        ? registrations.map(r => r.scope.replace(location.origin, '') || '/').join(', ')
        : 'none', registrations.length > 0)
    } catch (err) {
      add('Registrations', `unreadable: ${err.message}`, false)
    }
  }

  try {
    const { openDatabase } = await import('./idb.js')
    await openDatabase()
    add('Offline storage', 'available', true)
  } catch (err) {
    add('Offline storage', `unavailable — ${err.message}`, false)
  }

  try {
    localStorage.setItem('spore.probe', '1')
    localStorage.removeItem('spore.probe')
    add('Site data', 'writable', true)
  } catch {
    add('Site data', 'blocked — this browser is refusing to store anything', false)
  }

  add('WebRTC', typeof RTCPeerConnection === 'function'
    ? 'available' : 'missing — no peers can be reached',
  typeof RTCPeerConnection === 'function')

  return rows
}

/**
 * Unregister the worker and delete everything Spore has stored here.
 *
 * This is the escape hatch for a profile carrying a stale worker or a wedged
 * database. It is destructive within Spore's own origin and touches nothing
 * else, which is why it asks first and says exactly what it removes.
 */
export async function resetBrowserState () {
  const problems = []

  try {
    const registrations = await navigator.serviceWorker?.getRegistrations() ?? []
    await Promise.all(registrations.map(r => r.unregister()))
  } catch (err) {
    problems.push(`service worker: ${err.message}`)
  }

  try {
    const names = await caches?.keys() ?? []
    await Promise.all(names.map(name => caches.delete(name)))
  } catch (err) {
    problems.push(`caches: ${err.message}`)
  }

  try {
    await new Promise((resolve, reject) => {
      const request = indexedDB.deleteDatabase('spore')
      request.onsuccess = resolve
      request.onerror = () => reject(request.error)
      request.onblocked = resolve // other tabs hold it; the reload below clears them
      setTimeout(resolve, 3000)
    })
  } catch (err) {
    problems.push(`database: ${err.message}`)
  }

  try {
    localStorage.removeItem('spore.scripts-allowed')
  } catch { /* already unwritable, so nothing to remove */ }

  return problems
}
