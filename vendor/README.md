# vendor/

Third-party code, committed verbatim so the gate stays a **static bundle with no
build step**: clone, serve the directory over HTTPS, done. No npm install, no
bundler, no transpiler — anyone can re-host a mirror.

| file                 | source                                   | version | license |
|----------------------|------------------------------------------|---------|---------|
| `webtorrent.min.js`  | npm `webtorrent`, `dist/webtorrent.min.js` | 3.0.21  | MIT (`webtorrent.LICENSE`) |

To upgrade:

```sh
npm pack webtorrent@<version>
tar xzf webtorrent-<version>.tgz
cp package/dist/webtorrent.min.js vendor/
cp package/LICENSE vendor/webtorrent.LICENSE
```

Note: we deliberately do **not** vendor `dist/sw.min.js`. Our own `sw.js` is a
re-implementation of that worker's message protocol which additionally injects a
per-torrent Content-Security-Policy — see the comments in `sw.js`.
