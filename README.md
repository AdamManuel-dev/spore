# Spore

A browser inside the browser. Static sites live in torrents; opening one helps
host it.

Spore is a single static page — the **gate**. Paste a magnet link and the site
inside it renders, fetched from the swarm by peers rather than from a server.
Drop a folder on the gate and it becomes a torrent that your tab seeds, with a
link you can share. No account and no backend — your files go to readers, not
to a host.

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

Or run it yourself, behind your own TLS:

```sh
cd deploy/gate
docker compose up -d      # http://localhost:8080
```

Those are two of the three ways to host, and they do different jobs —
[`deploy/`](deploy/) says which is which. In short: **`deploy/gate/` serves the
page people browse with; `deploy/seeder/` keeps one published site alive.** A
compose file at the repository root would have implied that starting "the
project" meant one specific thing, and it does not.

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
files are hashed in your browser and never sent to a server — they travel
directly to the readers who ask for them. You get a magnet and a shareable
link, and your tab becomes the site's first seed.

Every reader who opens the link seeds it too, for as long as their tab is open.

## Updating a site

A magnet is the hash of its content, so editing a site gives it a new address.
That is not a limitation to route around — it is what makes a site verifiable
without trusting anyone. What it costs is continuity: readers holding the old
link have no way to learn the new one.

Signing fixes the continuity without giving up the verification.

**Drop your folder, and Spore asks whether to sign it** before anything is
hashed. Signing is a decision about that publication, not a login: a site
published without a key is a perfectly good site that simply can never be
updated.

Say yes and you give a name and a passphrase. **The name is what readers see** —
it goes into the site's `spore.pub` as the name your key claims for itself, and
it is what your password manager files the passphrase under. Leave it blank to
publish under the key alone. The passphrase *is* the key —
it is derived here, never stored, never sent, and there is nothing to back up
and nobody who can reset it. Spore then shows you the key it derived, as a
picture and a fingerprint, before signing anything with it. That step is the
only check that exists: there is no account to be wrong at, so a mistyped
passphrase produces a *different valid identity* rather than an error. Compare
it to what you saw last time; the second time on the same browser it greets you
by the name you gave it.

Then you say **which site this is** — `blog`, `notes` — picking from what you
have published before or naming a new one. This matters more than it looks: a
key is an *author*, and an author has many sites. The name goes in the site's
`spore.pub` and is what an update actually addresses, so publishing your CV
never announces itself as the new version of your blog. Type the same name on
another machine and you are publishing the same site.

Your folder then gets a `spore.pub` naming your public key and that site, so the
site says who it belongs to and which of their sites it is.

You can tick **keep this key on this device** to stop retyping. What gets stored
is the key itself in a form the browser will sign with but will not hand back —
not your passphrase — so it cannot be copied out. It can still be *used* by
anything running on Spore's origin, which includes a site you grant scripts to,
and there is no revocation. Don't do it in a browser where you enable scripts
for sites you don't trust. The full reasoning is in
[SECURITY.md](SECURITY.md#keeping-a-publishing-key-on-this-device).

Publish again later, same key and same site name, and Spore signs a small record
saying "the newest `blog` from this key is at *this* infohash" and offers it to
peers still on the old version. A reader there sees:

> **"Lara from work" has published a newer version.**
> Published 11 September 2026, signed by `2317-e451-c8f8-2b8c` — the same key as
> the version you are reading. **[Open it]** [Not now]

They are offered it. They are never moved. A signature proves *who* wrote a
version, not that the reader wants to be taken to it — and silently swapping
the page would hand anyone who ever stole the key control over what everyone is
currently reading.

Three things worth being plain about:

- **The name is a claim.** Anyone can put `name=Lara Croft` in their
  `spore.pub`. The key cannot be faked; the name is decoration. That is why the
  fingerprint is shown next to it.
- **It travels between peers, not through the DHT.** BEP 46 resolves successors
  over the DHT, which is UDP, which a browser cannot open at all. The record is
  the identical BEP 44 item — a seeder with UDP can put the same bytes in the
  DHT and an ordinary BEP 46 client resolves it — but in a browser it moves over
  the wire between peers. So an update reaches someone only if a peer they
  connect to holds it. **Keep the old version seeded.**
- **Versions are timestamps, so your clock matters.** There is no counter to
  keep, which is what lets you publish from any machine — but a clock running
  far ahead burns the series until real time catches up.

## Checking who published something

A signed site shows its author in the status bar — their avatar and either the
name *you* gave them or, in quotes, the name the key claims for itself. Click it
and you get the whole picture: the fingerprint, the full public key, which of
their sites you are reading, when this version was published, and whether this
browser has ever seen the key before.

You can give the author your own name for them. It is stored only in your
browser, never published, and it replaces their self-declared name everywhere
you see them. This is the answer to two people both calling themselves Lara: one
becomes "Lara from work" because you said so, and the other stays a claim in
quotes.

**A signature proves the key, not the person.** It shows the site was published
by whoever holds that key and has not been altered since. It says nothing about
who they are. A site that declares `name=Lara Croft` is making a claim about
itself, exactly like a caller saying a name on the phone — which is why the gate
never renders it as plain fact.

Sites nobody signed say **unsigned** rather than showing nothing, because a
missing signature and a page that has not finished loading should not look the
same.

The design, the threat model and what is deliberately not built are in
[spec/mutable-sites.md](spec/mutable-sites.md).

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
cd deploy/seeder
mkdir -p site data
cp -r your-website/. site/
docker compose up -d
docker compose logs        # the magnet is printed once, at startup
curl -s localhost:8081     # is it actually serving?
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

### Is it alive?

A seeder's characteristic failure is not crashing. It is staying up while
serving nothing — announcing a torrent whose files no longer verify, accepting
peer connections, and sending them no data. Every log line reads healthy. So
`--status <port>` answers with what actually matters:

```sh
curl -s localhost:8081
{ "infoHash": "…", "complete": true, "progress": 1, "peers": 2, "uploaded": 15360, … }
```

`complete: false` is the one to alert on: the pinned `.torrent` describes
content the folder does not hold. That is also the Docker `HEALTHCHECK`, so
`docker compose ps` reports `healthy` rather than merely `Up`, and the seeder
now says so loudly at startup instead of leaving it to be discovered by asking
why a site went dark.

The port is published on `127.0.0.1` only. It exposes nothing the magnet does
not already tell anyone, but there is no reason to put it on the internet.

**To keep an existing link**, do not re-publish the folder — re-creating a
torrent does not reliably reproduce the same infohash, and a different
infohash is a different site. Open the site in the gate, press
**Save .torrent** in the status bar, and give the server that file:

```sh
node tools/seed.mjs my-site.torrent --path /srv/sites
```

`--path` is the directory containing the site's folder. WebTorrent verifies
what is already on disk and seeds it under the original infohash.

Both images run on x86-64 and 64-bit ARM, so a Raspberry Pi 5 is a perfectly
good seeder — see [deploy/](deploy/#architectures), including the one
architecture that will not work.

Keep it running however you keep anything running — `systemd`, `pm2`, a
`tmux` window, `docker compose up -d`. Nothing about Spore cares which.

### What "permanent" does and does not mean

The link keeps working for as long as something is seeding it, and this is that
something. Two limits worth understanding before you rely on it:

- **Editing the site changes its address.** Content *is* the address here, so a
  new version is a new magnet, and the old link goes on serving the old bytes
  until nobody holds them. What carries readers across that gap is a signed
  successor — see [Updating a site](#updating-a-site) — which reaches only the
  people whose peers hold it. Keep the *old* version seeded too, or nobody
  still on it ever hears.
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
- **Not updatable yet.** A magnet addresses fixed bytes, so editing a site
  changes its address. A design for fixing that without introducing a host is
  drafted in [spec/mutable-sites.md](spec/mutable-sites.md) — signed
  successors delivered peer to peer, reusing BEP 44's record unchanged. It is
  a draft, not an implementation.

## Checking it still works

The security model is a set of claims about what a browser will and will not
do, so it is checked in one rather than argued about:

```sh
npm install                    # dev dependencies, needed only for this
npm test                       # or: node tools/e2e.mjs --chrome /path/to/chrome
```

It publishes `example-site/`, opens it the way a reader would, and asserts each
guarantee: the site renders from the swarm with its stylesheet and images,
scripts stay dead until opted in, an off-site image is refused, and a site
cannot climb out of its own torrent into another one. Signing and updates are
driven through the gate's own UI across three browser contexts — one publisher,
one reader who is offered the successor, one who expects a different author and
must refuse it.

It runs a **local tracker** for the duration. The two public `wss://` trackers
are this project's most fragile dependency, and a suite that fails when one of
them is having a bad afternoon teaches nobody anything. What is exercised —
real WebRTC between real browser peers — is the same either way.

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
  identity.js       ed25519 keys from a passphrase, spore.pub, fingerprints
  record.js         BEP 44 signed records: sign, encode, verify
  bencode.js        canonical bencode, because a signature covers exact bytes
  updates.js        sp_update: moving signed successors between peers
  authors.js        keys this browser has met, and their highest version
  me.js             the identity signed in to this tab (memory only)
deploy/gate/        container that serves the gate (nginx)
deploy/seeder/      container that seeds one site, permanently
vendor/             WebTorrent, committed verbatim (see vendor/README.md)
tools/serve.mjs     dev server
tools/e2e.mjs       browser check of both MVP promises and the security model
tools/seed.mjs      seed a site from a server, with a --status health endpoint
spec/               protocol drafts, for anyone writing a second gate
example-site/       the Spore whitepaper, published through Spore
```

There is no build step and no dependency to install. Clone it, serve the
directory, and it is the same gate — which is the point: any mirror runs it
identically.

`package.json` lists dev dependencies, and they are only for `tools/` and
`deploy/`: the browser check, the local tracker it runs, and the server seeder.
None of them is needed to host or mirror the gate.

## License

MIT.
