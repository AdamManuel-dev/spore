/**
 * Publishing: a dropped folder becomes a torrent that this tab seeds.
 *
 * The folder is read in the browser and never uploaded anywhere. What leaves
 * the machine is what peers ask for, over WebRTC, once the magnet is shared.
 * While the tab is open this tab is the swarm; every reader who opens the link
 * becomes another seed for as long as *their* tab is open. Closing the last tab
 * takes the site offline — that is the honest limit of the MVP.
 */

import { seedTorrent } from './swarm.js'

/**
 * Pull a full file tree out of a drop.
 *
 * `webkitGetAsEntry` is the only way to see inside a dropped directory. Each
 * file is tagged with its `fullPath`, which is what create-torrent reads to lay
 * out the torrent — it strips the shared root folder itself, so `index.html`
 * lands at the top of the torrent exactly as it sat in the folder.
 *
 * @param {DataTransfer} dataTransfer
 * @returns {Promise<{ files: File[], name: string|null }>}
 */
export async function filesFromDrop (dataTransfer) {
  const entries = [...dataTransfer.items]
    .filter(item => item.kind === 'file')
    .map(item => item.webkitGetAsEntry?.())
    .filter(Boolean)

  if (entries.length === 0) {
    // No directory API (or a plain file list): take what we can get.
    return { files: [...dataTransfer.files], name: null }
  }

  const files = []
  for (const entry of entries) await collect(entry, files)

  const roots = entries.filter(entry => entry.isDirectory)
  return { files, name: roots.length === 1 ? roots[0].name : null }
}

/** Files chosen through `<input type="file" webkitdirectory>`. */
export function filesFromInput (input) {
  const files = [...input.files]
  for (const file of files) {
    if (file.webkitRelativePath) file.fullPath = file.webkitRelativePath
  }
  const name = files[0]?.webkitRelativePath?.split('/')[0] ?? null
  return { files, name }
}

/**
 * Seed a set of files.
 * @returns {Promise<import('webtorrent').Torrent>}
 */
export async function publish (files, name) {
  if (files.length === 0) throw new Error('That folder is empty.')
  if (!files.some(file => /(^|\/)index\.html?$/i.test(file.fullPath || file.name))) {
    // Refuse early rather than hand back a magnet that renders nothing.
    throw new Error('A site needs an index.html in its top folder.')
  }
  return await seedTorrent(files, { name: name ?? undefined })
}

async function collect (entry, out, prefix = '') {
  if (entry.isFile) {
    const file = await new Promise((resolve, reject) => entry.file(resolve, reject))
    file.fullPath = prefix + entry.name
    out.push(file)
    return
  }
  for (const child of await readDirectory(entry)) {
    await collect(child, out, `${prefix}${entry.name}/`)
  }
}

/** `readEntries` returns a page at a time and signals the end with an empty batch. */
function readDirectory (entry) {
  const reader = entry.createReader()
  const entries = []

  const readBatch = () => new Promise((resolve, reject) => reader.readEntries(resolve, reject))

  return (async () => {
    for (;;) {
      const batch = await readBatch()
      if (batch.length === 0) return entries
      entries.push(...batch)
    }
  })()
}
