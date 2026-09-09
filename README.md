# Spore

A browser inside the browser. Static sites live in torrents; opening one helps
host it.

Spore is a single static page — the **gate**. Paste a magnet link and the site
inside it renders, fetched from the swarm by peers rather than from a server.
Drop a folder on the gate and it becomes a torrent that your tab seeds, with a
link you can share. No account, no upload, no backend.

The name: a spore is self-contained, spreads, survives dormant, and any one of
them can regrow the whole organism — which is exactly what a content-addressed
site is.

## Try it

```sh
node tools/serve.mjs          # http://localhost:8080/
```

Any static host over HTTPS works just as well; `tools/serve.mjs` exists only
because service workers need a secure context and `file://` is not one
(`localhost` is exempt).

Then either drop `example-site/` onto the page to publish it, or paste a magnet
into the address bar.

## How it works

```
  ┌─ gate (this bundle) ─────────────────────────────────┐
  │  address bar, controls, publish            page JS   │
  │                                        WebTorrent ───┼── WebRTC ── peers
  │  ┌─ <iframe sandbox> ──────────────┐         ▲       │
  │  │  the site, from the swarm       │         │       │
  │  │  GET /webtorrent/<hash>/…  ─────┼──► service worker│
  │  └─────────────────────────────────┘                 │
  └──────────────────────────────────────────────────────┘
```

- **The magnet lives in the URL fragment** (`https://gate/#<magnet>`). Browsers
  never send a fragment to the server, so whoever hosts the gate does not learn
  what you are reading.
- **WebTorrent runs in the page**, not in the service worker — a worker cannot
  open WebRTC connections.
- **The service worker serves the site** at `/webtorrent/<infoHash>/<path>`, so
  every request a site makes — stylesheets, images, fonts, nested frames —
  passes through one chokepoint. Nothing is rewritten and no custom tags are
  invented; there is nothing for the gate to miss.
- **The site renders in a sandboxed iframe** and is governed by a
  Content-Security-Policy that the worker attaches to every response. See
  [SECURITY.md](SECURITY.md) — it is the heart of the project, not a detail.

## Publishing

Drop a folder with an `index.html` at the top and relative links inside. The
files are hashed in your browser; nothing is uploaded. You get a magnet and a
shareable link, and your tab becomes the site's first seed.

Every reader who opens the link seeds it too, for as long as their tab is open.

## What this is not

- **Not anonymity.** Peers in a swarm see each other's IP addresses. Spore
  protects *content* from being taken down; it does not hide who publishes or
  reads it. Do not use it as if it did.
- **Not persistent yet.** Browser peers only reach other WebRTC peers, and
  seeding stops when the tab closes. Close every tab that has a site open and it
  goes dormant until someone with a copy seeds it again. Always-on seeding is a
  later phase.
- **Not updatable yet.** A magnet addresses fixed bytes. Mutable pointers,
  discovery and human-readable names are a later phase.

## Layout

```
index.html          the gate
app.css
sw.js               service worker: serves the swarm, sets each site's CSP
js/
  app.js            wiring: fragment routing, address bar, publish, status
  swarm.js          WebTorrent client and worker registration
  site.js           finds a torrent's entry page
  viewer.js         the sandboxed iframe
  policy.js         per-site script opt-in, and the bridge to the worker
  publish.js        dropped folder → seeded torrent
  magnet.js         parsing whatever the user pasted
  config.js         trackers and timeouts
vendor/             WebTorrent, committed verbatim (see vendor/README.md)
tools/serve.mjs     dev server
example-site/       a site to publish while testing
```

There is no build step and no dependency to install. Clone it, serve the
directory, and it is the same gate — which is the point: any mirror runs it
identically.

## License

MIT.
