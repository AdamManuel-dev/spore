// Offline WebTorrent adapter: reads the fixture's real files, but never starts
// discovery, trackers, sockets, or peers. Hashes identify fixtures, not torrents.
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export function fixtureHash(bytes) {
  return createHash("sha256").update(bytes).digest("hex").slice(0, 40);
}

export default class OfflineWebTorrent extends EventEmitter {
  seed(directory, _options, callback) {
    const path = join(directory, "index.html");
    const bytes = readFileSync(path);
    const infoHash = fixtureHash(bytes);
    const torrent = Object.assign(new EventEmitter(), {
      infoHash,
      magnetURI: `magnet:?xt=urn:btih:${infoHash}`,
      files: [
        { createReadStream: (options) => createReadStream(path, options) },
      ],
      length: bytes.length,
      progress: 1,
      numPeers: 0,
      uploaded: 0,
      destroy() {},
    });
    setImmediate(() => callback(torrent));
    return torrent;
  }

  destroy(callback) {
    callback();
  }
}
