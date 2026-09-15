# Spore: feature and architecture review

## Scope and reading guide

This is a source-based explanation of the current checkout, not a penetration test or a claim that the browser suite passed during this review. No application behavior was changed.

The implementation has grown beyond the original two-feature MVP in [CLAUDE.md](../CLAUDE.md). Signed publications, successor notifications, offline keeping, author management, and a standalone seeder are already present. Some older documentation still describes them as future work.

Open [project-architecture.drawio](project-architecture.drawio) in draw.io for three editable views:

1. Runtime components and trust boundaries.
2. Publishing, signatures, and peer-delivered updates.
3. Browser persistence and deployment choices.

## The central idea

Spore separates **the application that opens a site** from **the peers that hold its content**. A static host delivers the gate. WebTorrent peers deliver the published site. A service worker turns torrent files into HTTP responses, so the browser can render ordinary HTML, CSS, images, and relative links.

An infohash identifies an immutable version. A publishing key and site-series name provide continuity between versions. A signed update offers a new infohash; it does not change the old content or automatically move the reader.

## Browser features

### 1. Open and navigate sites

**What the reader gets:** paste a magnet, hexadecimal/base32 infohash, or another gate's share link; open it without reloading the application. The logo returns home and browser history supports navigation.

`app.js` turns the URL fragment into a site reference through `magnet.js`, restores locally kept content when available, and asks `swarm.js` to obtain torrent metadata. `site.js` chooses the shallowest `index.html`/`index.htm`, or a sole HTML file. When no entry page is found, the gate presents a file listing instead of requiring every torrent to be a website.

`viewer.js` loads the chosen resource at a scope-relative `webtorrent/<infohash>/<path>` URL. Ordinary relative links and assets work without rewriting the site's markup.

**Connections and limits:** the fragment identifies the current view, while the WebTorrent client survives navigation. Opened torrents remain loaded and can continue seeding after the reader returns home or opens something else. A valid magnet does not guarantee a reachable WebRTC peer; bounded metadata waits produce an unavailable-site state rather than an endless blank view.

**Sources:** [app.js](../js/app.js) (`route`, `open`, `goHome`, `showListing`), [magnet.js](../js/magnet.js), [site.js](../js/site.js), [swarm.js](../js/swarm.js).

### 2. Publish a folder

**What the publisher gets:** drop or select a folder, optionally sign it, and receive a magnet and shareable gate link. The new site opens in the viewer and the tab becomes its first seed.

`publish.js` preserves relative file paths, walks dropped directories, validates the input, and seeds through the existing WebTorrent client. Signing is a publication choice, not a requirement to log in. The UI requests an `index.html` at the folder root; the current validator is more permissive and also accepts a nested index.

**Connections and limits:** publication produces immutable content. Editing the folder and publishing again creates another version, not an overwrite. Files go to peers requesting them rather than to an application upload server. Availability lasts only while some compatible peer has the content and is online.

**Sources:** [publish.js](../js/publish.js), [app.js](../js/app.js) (`seed`, `askAboutSigning`, `withSporePub`, `signContent`).

### 3. Share and export

**What the user gets:** share the current site even if they did not publish it, copy the link, and save its `.torrent` metadata.

The share link combines the current gate location with a magnet fragment. Kept-site records retain the original magnet, including its tracker information. The `.torrent` export contains torrent metadata, not an independent copy of all website files.

**Connections and limits:** an infohash identifies content but does not carry the tracker information that a full magnet can provide. Sharing a link does not ensure anyone will still be seeding it when the recipient opens it.

**Sources:** [app.js](../js/app.js) (`showShareLink`, `onShare`, `onCopy`, `onSaveTorrent`), [keep.js](../js/keep.js).

### 4. Content-request security and script permissions

**Default behavior:** scripts are disabled; the worker attaches a restrictive Content-Security-Policy to torrent responses. Forms, plugins, and external resource origins are blocked. The worker also rejects direct cross-torrent resource requests using the requesting client's URL or referrer.

The normal iframe sandbox includes `allow-same-origin`, which is needed for worker serving. Opting into scripts adds `allow-scripts`, updates the per-infohash permission, and reloads the viewer. `policy.js` stores grants and answers the worker's policy queries; absent replies default to scripts off. A new content hash is a different permission target.

**Critical boundary:** these sites do not have separate browser origins. Enabling scripts combines same-origin access with script execution: hostile code can reach the parent application and origin storage. Worker/CSP checks on direct content requests must not be described as complete containment of an untrusted scripted site. This also affects remembered publishing keys.

The application probes whether the browser can serve a sandboxed frame. A negative result, notably on WebKit, offers a reduced-isolation mode after consent and disables the script-toggle action. This is a compatibility compromise: removing sandbox protection can allow user-clicked external navigation. Existing stored script grants are still read by rendering and worker-policy code, so blocking the toggle does **not** guarantee scripts are off in fallback mode. It is not equivalent to the normal security posture.

**Sources:** [sw.js](../sw.js) (`serve`, `askingTorrent`, `contentSecurityPolicy`), [policy.js](../js/policy.js), [viewer.js](../js/viewer.js), [app.js](../js/app.js) (`onScriptsToggle`), [SECURITY.md](../SECURITY.md).

### 5. Keep a site on this device

**What the reader gets:** explicitly keep a complete site, reopen its stored content without an online peer, see a kept-sites list and storage usage, or forget the stored copy.

`keep.js` requests persistent storage, copies torrent pieces into IndexedDB, and writes the site record after the copy completes. `idb.js` implements the WebTorrent-compatible chunk store. On startup, kept torrents are restored from exact torrent metadata and seeded again.

**Connections and limits:** keeping is both a local-storage decision and a future swarm-participation decision. It does not create an always-on peer. It also does not install an offline copy of the gate itself: stored site bytes remain useful once the gate is loaded. Forget removes site metadata and pieces, but does not remove an already loaded torrent from the running client; it is not a “stop seeding now” control.

**Sources:** [keep.js](../js/keep.js) (`keep`, `restoreAll`, `restoreOne`, `forget`), [idb.js](../js/idb.js), [app.js](../js/app.js) (`refreshKeptList`, `onKeepToggle`).

### 6. Publishing identities and optional remembered keys

**What the publisher gets:** derive an identity from a passphrase, confirm its avatar/fingerprint, choose a site-series name, and optionally retain the signing key on this device.

`identity.js` derives Ed25519 keys using normalized passphrases and PBKDF2. The same passphrase yields the same key, so a typo creates a different identity rather than a login error. A key identifies an author; the normalized site name distinguishes that author's independent publications and becomes the update-record salt.

The active identity lives in `me.js`. Remembering it stores a non-extractable signing `CryptoKey` in IndexedDB rather than the passphrase. The server seeder can derive the same identity and reuse the same signing modules.

**Connections and limits:** this is not an account system, verified real-world identity, or password-reset service. Weak passphrases remain susceptible to offline guessing. A non-extractable key cannot be exported through the WebCrypto API, but same-origin code can still use it to sign. There is no implemented revocation mechanism.

**Sources:** [identity.js](../js/identity.js), [me.js](../js/me.js), [idb.js](../js/idb.js), [app.js](../js/app.js) (`showConfirmStep`, `showChooseStep`).

### 7. Authorship, content verification, and local names

**What the reader gets:** a status indicator for unsigned content or a declared author, an author-details panel, content-signature results, and a local name (“petname”) for a familiar key.

Three different checks must not be conflated:

| Mechanism | What it establishes |
| --- | --- |
| Torrent infohash and piece hashes | The downloaded bytes match the addressed torrent. |
| `spore.pub` | The site declares a public key and series; this alone is not proof of authorship. |
| `spore.sig` | The declared key signed a manifest of file paths and SHA-256 hashes; verification checks the actual files and rejects missing or unlisted files. |

The gate distinguishes checking, verified, an unverified declaration, and broken content-signature states. Verification runs asynchronously **after rendering begins**; it is an informational result, not a pre-render gate that blocks unverified content.

Names claimed by publishers are not authenticated personal identities. A petname is the reader's local label; comparing a fingerprint through a trusted channel is still necessary to identify a person. Reading a site with an author declaration automatically remembers author/infohash metadata in this browser, even without keeping the site.

**Sources:** [manifest.js](../js/manifest.js), [authors.js](../js/authors.js), [app.js](../js/app.js) (`nameAuthor`, `verifyContent`, `showAuthor`, `showAuthorChip`).

### 8. Signed update offers

**What the reader gets:** an offer to open a newer version from the same declared key and site series. The reader chooses whether to follow it; the old address keeps meaning the old bytes.

`record.js` signs and verifies BEP 44-style records containing a successor infohash, sequence, key, and series salt. `bencode.js` provides canonical serialization. `updates.js` transports records over the `sp_update` BitTorrent wire extension, negotiated through BEP 10.

The receiver checks the expected key and salt, signature, record shape, sequence, and target hash. Strictly older sequences are rejected; an equal known sequence can still help a reader currently viewing an older torrent. Accepted-version history is remembered locally. Verified records can be relayed by readers; watchers live with torrents rather than only with the visible page.

**Connections and limits:** a successor is learned from peers on a swarm the reader can already join, not from browser DHT lookup or a global latest-version service. Browser publication relies on local history and a previously loaded torrent to reach the old swarm. Offers are sent during peer handshakes rather than through a general live broadcast loop. Keeping an old swarm available is therefore essential, but does not guarantee immediate notification to every connected reader.

Sequences use timestamps, so a badly advanced publisher clock can disrupt future progression. These signatures authenticate an update record; content-manifest verification is a separate process. The application does not resolve a site from its author's key alone.

**Sources:** [record.js](../js/record.js), [bencode.js](../js/bencode.js), [updates.js](../js/updates.js), [app.js](../js/app.js) (`watchTorrentForUpdates`, `announceSuccessor`, `offerUpdate`, `onUpdateOpen`).

### 9. Status, diagnostics, and recovery

**What the user gets:** loading and unavailable states, transfer/peer status, diagnostics for browser capabilities, service-worker control, viewer state, storage and tracker activity, plus recovery/reset controls.

`swarm.js` manages worker registration/control and WebTorrent startup. The application checks for lost worker registrations while viewing and attempts to restore serving. The viewer checks whether navigation actually landed instead of treating any iframe `load` event as success.

**Connections and limits:** failures may originate in the static host, worker lifecycle, browser compatibility, peer discovery, or content availability; diagnostics expose these separately. Storage failures should not prevent ordinary reading. Reset is not a complete privacy wipe: it attempts worker/cache/database removal and deletes script grants, but leaves other local/session storage entries. Its worker/cache cleanup is origin-wide, so dedicated-origin hosting avoids affecting unrelated applications.

**Sources:** [diagnostics.js](../js/diagnostics.js) (`collectDiagnostics`, `resetBrowserState`), [swarm.js](../js/swarm.js), [viewer.js](../js/viewer.js), [app.js](../js/app.js) (`watchTheWorker`, `restoreWorker`, `onReset`).

## How the modules fit together

| Layer | Main files | Responsibility |
| --- | --- | --- |
| Gate interface and orchestration | `index.html`, `app.css`, `js/app.js` | Controls, dialogs, routing, status, feature coordination. |
| Reference and entry handling | `js/magnet.js`, `js/site.js` | Parse addresses and locate a renderable file. |
| Network lifecycle | `js/swarm.js`, `js/config.js`, vendored WebTorrent | Register worker, own the torrent client, discover peers, seed/download. |
| HTTP-style content serving | `sw.js`, `js/policy.js`, `js/viewer.js` | Request/response bridge, security headers, script grants, iframe rendering. |
| Publishing and persistence | `js/publish.js`, `js/keep.js`, `js/idb.js` | Folder ingestion, torrent creation, opt-in piece storage and restore. |
| Identity and content integrity | `js/identity.js`, `js/me.js`, `js/authors.js`, `js/manifest.js` | Keys, active identity, local recognition, signed file manifests. |
| Publication continuity | `js/bencode.js`, `js/record.js`, `js/updates.js` | Exact signed bytes, record validation, peer transport. |
| Diagnostics | `js/diagnostics.js` | Capability/state reports and reset operations. |

### One read, end to end

1. The static host serves the gate; `app.js` boots the page-owned client and worker bridge.
2. The URL fragment is parsed; kept content or swarm metadata supplies a torrent.
3. The gate selects an entry and navigates the iframe.
4. The worker receives a file request, applies provenance/policy checks, and requests content from page clients through WebTorrent's MessagePort protocol.
5. The page client supplies locally held or peer-downloaded bytes; the worker streams a response with security headers.
6. The browser requests relative assets the same way. In parallel, author/content verification and successor watching update the gate's status.
7. Available pieces remain shareable while the torrent client lives, even if the visible page changes.

### State and lifetime

| Location | What lives there | Consequence |
| --- | --- | --- |
| URL fragment | Current magnet/reference | Shareable route; excluded from the gate's HTTP request. |
| Tab memory | Ordinary torrent content, client, active key, update watchers/records | Lost when the tab closes; changing views does not destroy the client. |
| IndexedDB `sites` and `chunks` | Opt-in kept torrent metadata and pieces | Restored/seeding on later launches; removable with Forget. |
| IndexedDB `keys` | Optional remembered signing key and metadata | Persistent signing capability on this origin. |
| `localStorage` | Script grants, authors/infohashes, petnames, version history, publishing labels/history, compatibility choice | The application does persist metadata beyond explicitly kept site bytes. |
| `sessionStorage` | Worker-restart guard | Prevents recovery reload loops. |
| Seeder data directory | Frozen versions and `versions.json` | Independent of browser storage; supports old magnets and update delivery. |

## Hosting and operational features

### Static, mirrorable gate

**Purpose:** let people browse and publish without an application backend or account service.

The gate consists of `index.html`, `app.css`, `js/`, `sw.js`, and the committed WebTorrent browser bundle. Hosting it requires no npm install or build step. It needs HTTPS, with localhost as the development exception. Registration scope supports hosting under a subpath rather than requiring a particular domain.

`deploy/gate/` provides nginx hosting; it does not seed published sites. Its configuration prevents stale service-worker responses and revalidates application assets. TLS is supplied by the hosting platform or a reverse proxy.

**Connections:** the static host bootstraps the application; the page then talks to trackers and peers. The magnet is in the URL fragment and is not included in the HTTP request to the static host. This does not hide the reader from swarm peers or make an untrusted gate safe.

**Sources:** [vendor/README.md](../vendor/README.md), [deploy/gate/nginx.conf](../deploy/gate/nginx.conf), [deploy/README.md](../deploy/README.md).

### Standalone, version-retaining seeder

**Purpose:** keep a publication available when browser tabs are closed.

`tools/seed.mjs` runs WebTorrent in Node with `node-datachannel` providing WebRTC. This is an optional peer, not an application backend and not the gate's web server. Ordinary TCP/uTP-only BitTorrent seeders cannot directly serve browser peers.

Its publication cycle is:

1. Restore frozen versions from the data directory, checking their infohashes and file readability.
2. Copy the live content folder into a version directory; do not seed mutable source files directly.
3. Optionally add an identity declaration and sign a content manifest with the shared browser/Node crypto modules.
4. Seed the resulting immutable torrent and save its version metadata.
5. Offer the newest signed successor on retained older swarms.
6. Prune versions beyond the configured retention limit.

The watch loop compares file paths, sizes, and modification times before doing another publication pass. Defaults include a 30-second watch interval and ten retained versions. A passphrase enables signing; without one, edited content gets new magnets but this tool does not generate signed update offers.

**Connections:** keeping old versions is part of update delivery, not just archival convenience. A reader on an old swarm needs a peer on that swarm to tell them about its successor. Deleting the data directory or pruning a version can remove that route.

The tool periodically re-announces to trackers and exposes JSON status with current magnet, version completeness, peer/upload totals, and tracker-reply timing. The Docker health check uses `complete`. Treat that as a limited local health signal: it is based on torrent progress, not a continuous end-to-end browser-read test. Startup/publication readability checks read the first byte of each file rather than re-hashing every file in full.

**Sources:** [tools/seed.mjs](../tools/seed.mjs), especially `checkForNewVersion`, `restoreVersions`, `refreshOffers`, `verifyReadable`, `status`, and `startWatching`; [deploy/seeder/Dockerfile](../deploy/seeder/Dockerfile).

### Development and release tooling

- **Local serving:** `node tools/serve.mjs` serves the checkout on localhost. `--tls` generates a local development certificate using OpenSSL for HTTPS testing on other devices; device/browser certificate trust still matters.
- **Browser regression suite:** `npm test` runs `tools/e2e.mjs` using Puppeteer and an installed Chrome executable. The harness attempts to start a local tracker and drives real browser/WebRTC flows.
- **Seeder releases:** `.github/workflows/seeder.yml` builds and pushes amd64/arm64 images on seeder tags or manual dispatch, then smoke-tests the published image on the runner. The smoke test checks status and the existence of `spore.sig`; it is not a browser-to-seeder transfer test. Publication happens before this smoke test, so a failure does not itself retract the image.
- **Example content:** `example-site/` is both the whitepaper and a fixture containing resource, script, navigation, and egress probes.

The browser suite contains scenarios for rendering, script permissions, off-site and cross-torrent resource rejection, folder publishing, offline restore, identity/signature verification, successor offers and relay, remembered keys, slow peers, worker recovery, and mobile layout. These are existing test scenarios, not newly verified results from this review.

**Sources:** [package.json](../package.json), [tools/serve.mjs](../tools/serve.mjs), [tools/e2e.mjs](../tools/e2e.mjs), [.github/workflows/seeder.yml](../.github/workflows/seeder.yml).

## Documentation drift to resolve

1. **Project scope:** `CLAUDE.md` places signed updates and always-on seeding in later phases, but the checkout implements both. The original scope document is not an accurate inventory of current features.
2. **Contradictory README status:** the README explains updates and server seeding, then calls them unimplemented/later-phase under “What this is not.”
3. **Stale protocol banner:** `spec/mutable-sites.md` starts with “Nothing in this document is implemented,” despite containing formats used by `identity.js`, `manifest.js`, `record.js`, and `updates.js`. Implemented protocol pieces should be distinguished from unresolved proposals.
4. **Privacy/reset language:** claims of no history or no writes by default conflict with automatic author/infohash persistence. Reset does not clear all Spore metadata. The security document also contains an older `no-referrer` description, while current torrent responses use `same-origin`.
5. **Fallback safety wording:** the compatibility flow blocks the script-toggle action but does not override stored script grants in rendering or worker policy. Descriptions that promise scripts are always disabled in fallback mode overstate the implementation.
6. **Operational claims need precise wording:** seeder completeness and a CI smoke test are useful checks, but neither establishes continuous reachability or successful delivery to a browser. Environment-based passphrases avoid command-line arguments, but are not hidden from privileged process/container inspection.

These observations are recorded here rather than silently changing the existing project instructions or security claims.

## What is still absent

The inspected implementation does not provide identity-only latest-version resolution, a browser DHT bridge, rendezvous-based discovery, separate-origin content isolation, key rotation/revocation, global human-readable aliases, mirror discovery, gate-hash pinning/TOFU, or reproducible-build attestations. None is required to understand the current implemented flows.

## Overall assessment

The architecture's strongest property is the separation between a mirrorable static gate, content-addressed peer delivery, and reusable signing code shared with the optional seeder. Updates retain immutable addresses and require an explicit reader decision.

The most important qualifications are equally central: availability depends on active WebRTC peers; swarm participation is not anonymous; remembered metadata and keys carry local privacy implications; and script-enabled content is not isolated from the gate's origin. Existing documentation should be reconciled with these implemented behaviors before being treated as a definitive security or feature specification.
