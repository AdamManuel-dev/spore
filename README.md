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

### Hosting it

Any static host over HTTPS will do, because the gate is only files. GitHub
Pages is the least-effort option:

1. Push this repository to GitHub.
2. Settings → Pages → Source: *Deploy from a branch*, branch `main`, folder
   `/ (root)`.

That is the whole deployment. There is no build step to configure, and nothing
in the bundle assumes a particular hostname or path — verified running from a
subpath, which is what a project page (`https://you.github.io/spore/`) gives
you: the service worker takes its scope from wherever it was registered.

Two details that matter on a static host:

- `.nojekyll` is committed so Pages serves the files as they are.
- The worker is registered with `updateViaCache: 'none'`. Pages serves assets
  with a ten-minute `max-age`, and a cached `sw.js` outliving a fix is a bug
  that looks exactly like the fix never happened.

One caveat once you are on HTTPS: a magnet whose trackers are `ws://` rather
than `wss://` is blocked as mixed content, and the site will never find a peer.
Spore's own default trackers are `wss://`.

### Testing on a phone, or any other device

```sh
node tools/serve.mjs 8080 --tls    # prints the LAN URLs to type
```

`--tls` is not optional here, and the reason is worth knowing before you file a
bug against a browser. A service worker requires a **secure context**, and
`localhost` is the only insecure origin browsers exempt. Reaching the dev server
at `http://192.168.x.x` therefore gets you no service worker at all — the API is
switched off entirely — and Spore serves every site through one. Mobile Firefox
and Chrome will report exactly this under **Diagnostics**.

The certificate is self-signed, so each device accepts the warning once. After
that the origin is a secure context and everything behaves normally.

**In production this is a non-issue**: served over HTTPS from any static host,
mobile browsers get a service worker like desktop ones do.

Then drop `example-site/` onto the page to publish it. That folder is the
Spore whitepaper — what it is, why adoption is the mechanism rather than the
scoreboard, who it is for, and what it refuses to promise. It is also the test
fixture, which is deliberate: every claim it makes about the security model is
demonstrated live on the page, so a broken guarantee shows up as a broken
document.

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

## Seeding from a server

A browser seeds only while its tab is open. To keep a site up regardless, run a
seeder that stays running — but it has to speak **WebRTC**, because that is the
only transport a browser peer can use. An ordinary BitTorrent client
(transmission, rtorrent, a NAS) cannot serve a Spore site no matter how
correctly it seeds the same infohash. That single fact is what most guides on
this are really working around.

Modern WebTorrent does WebRTC in Node directly, so it takes one dependency and
one line — `webtorrent-hybrid`, which older guides install, is no longer
needed:

```sh
npm install webtorrent node-datachannel
node tools/seed.mjs ./my-site
```

### With Docker

```sh
mkdir -p site data
cp -r your-website/. site/
docker compose up -d
docker compose logs        # the magnet is printed once, at startup
```

`site/` is your website; `data/` holds the pinned `.torrent`. **Keep `data/`.**
It is what makes the magnet survive restarts, rebuilds and moving to another
machine — verified: restart the container and the same infohash comes back,
because it seeds the stored torrent rather than re-hashing the folder.

Nothing needs to be exposed. WebRTC connections are established outbound
through the trackers, so there are no ports to forward and none are published.

One thing that looks like a bug and is not, so it is worth stating: the site
volume is **not** mounted read-only. Seeding a pinned torrent goes through
WebTorrent's `add()`, which opens the files read-write to verify them. Mounted
`:ro` the seeder connects to peers and then serves nothing — verification fails
quietly and it has no verified pieces to offer. It looks exactly like
`1 peer, progress 0.00` and never finishing.

It prints the magnet and holds it. Verified end to end: the seeder reported
`1 peer  ↑ 15 kB` while a browser gate rendered the site from it in about six
seconds, with no other peer anywhere.

**To keep an existing link**, do not re-publish the folder — re-creating a
torrent does not reliably reproduce the same infohash, and a different
infohash is a different site. Open the site in the gate, press
**Save .torrent** in the status bar, and give the server that file:

```sh
node tools/seed.mjs my-site.torrent --path /srv/sites
```

`--path` is the directory containing the site's folder. WebTorrent verifies
what is already on disk and seeds it under the original infohash.

Keep it running however you keep anything running — `systemd`, `pm2`, a
`tmux` window, `docker compose up -d`. Nothing about Spore cares which.

### What "permanent" does and does not mean

The link keeps working for as long as something is seeding it, and this is that
something. Two limits worth understanding before you rely on it:

- **Editing the site changes its address.** Content *is* the address here, so a
  new version is a new magnet, and the old link goes on serving the old bytes
  until nobody holds them. Mutable addresses are a later phase. In the
  meantime, a site you expect to edit is better announced with the gate URL you
  control and a fresh magnet each time.
- **One seeder is one point of failure**, which is the thing Spore is supposed
  to avoid. The seeder makes a site *available*; readers keeping it open are
  what make it *resilient*. They are not the same property.

## Keeping a site

Spore writes nothing to disk by default — no cache, no history. **Keep offline**
is you deciding otherwise for one site: its contents are stored in IndexedDB, it
opens instantly with no peer online, and it is seeded from the moment Spore
starts rather than only once someone else turns up.

It asks before it does that, because it is not free: the site's contents sit on
your device where anyone using the browser profile can read them, and you
announce that you hold it every time Spore opens rather than only while reading.
**Forget** deletes the record and every stored byte. Full reasoning in
[SECURITY.md](SECURITY.md#keeping-a-site-on-this-device).

This is not the same as always-on availability: a kept site is still only
reachable while one of your tabs is open. A seeder that runs without a browser
is a later phase.

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

## Checking it still works

The security model is a set of claims about what a browser will and will not
do, so it is checked in one rather than argued about:

```sh
npm install puppeteer-core     # the only dependency, and only for this
node tools/e2e.mjs             # --chrome /path/to/chrome if it is not found
```

It publishes `example-site/`, opens it the way a reader would, and asserts each
guarantee: the site renders from the swarm with its stylesheet and images,
scripts stay dead until opted in, an off-site image is refused, and a site
cannot climb out of its own torrent into another one.

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
  keep.js           opt-in offline storage: keep, forget, restore on boot
  idb.js            IndexedDB — the only thing that writes to disk
  magnet.js         parsing whatever the user pasted
  config.js         trackers and timeouts
vendor/             WebTorrent, committed verbatim (see vendor/README.md)
tools/serve.mjs     dev server
tools/e2e.mjs       browser check of both MVP promises and the security model
example-site/       the Spore whitepaper, published through Spore
```

There is no build step and no dependency to install. Clone it, serve the
directory, and it is the same gate — which is the point: any mirror runs it
identically.

## License

MIT.
