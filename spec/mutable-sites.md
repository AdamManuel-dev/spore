# Mutable sites

**Status: draft. Nothing in this document is implemented.** It exists to be
argued with before any code is written. Where something is unproven it says so;
the open questions at the end are real, not rhetorical.

## The problem

A magnet addresses content. `xt=urn:btih:<hash>` is the SHA-1 of the torrent's
`info` dictionary, which contains every file's name, length and piece hashes.
Change one byte and the address changes. That is not a limitation to be worked
around — it is why any stranger can serve you a site and you can still trust
what you got.

But a website that cannot be edited is barely a website. So we need a stable
name that resolves to a changing infohash, without introducing a host, because
a host is the thing the project exists to remove.

## What already exists, and why it does not reach a browser

[BEP 44] defines signed mutable items in the BitTorrent DHT: an Ed25519
keypair, a sequence number, a value of at most 1000 bytes, and a signature that
anyone can verify. [BEP 46] uses one to hold the current infohash of a
"torrent series", addressed as `magnet:?xs=urn:btpk:<pubkey>`.

That is precisely the right design, and a browser cannot use it. The DHT is a
Kademlia overlay speaking bencoded UDP datagrams to arbitrary hosts. Browsers
have no UDP socket API, by design — arbitrary outbound UDP would make every
browser a port scanner. WebRTC is not a substitute: a data channel needs an
out-of-band SDP handshake, then ICE, DTLS and SCTP framing, none of which a
libtorrent DHT node understands. The same limitation is why WebTorrent needs
`wss://` trackers, and why the `udp://` trackers in a typical public magnet are
silently ignored by every browser client.

## The approach

**Keep BEP 44's signed object exactly. Add one transport for it.**

Nothing here invents crypto, a payload format, or an address format. The only
new thing is a way to deliver an existing kind of signed record to peers that
cannot speak UDP: a BitTorrent wire extension, negotiated through [BEP 10],
which every client already implements and which ignores extensions it does not
know.

The consequence is that the peer serving you a site can also tell you a newer
one exists, over the connection you already have. No lookup service, no bridge,
no DHT.

## `spore.pub`

A site declares its identity by including a file named `spore.pub` in the top
level of its folder — beside `index.html`.

- Content: 64 lowercase hexadecimal characters, the Ed25519 public key,
  optionally followed by a single `\n`.
- It is ordinary file content. It is covered by the torrent's own hashes, so it
  cannot be altered without changing the infohash, and any BitTorrent client
  downloads it like any other file.

A site without `spore.pub` is immutable and any update message concerning it
**must** be ignored.

The key is deliberately carried in the content rather than only in the magnet,
so that a link reshared as a bare infohash still carries the identity.

## The record

Byte-for-byte a BEP 44 mutable item, bencoded, with BEP 46's value:

| key | type | meaning |
|---|---|---|
| `k` | 32 bytes | Ed25519 public key |
| `seq` | integer | monotonically increasing version counter |
| `v` | dict | `{ "ih": <20-byte infohash of the new version> }` |
| `sig` | 64 bytes | Ed25519 signature |
| `salt` | bytes | optional; see Open questions |

What gets signed, and how the DHT target is derived, are defined by BEP 44 and
are **not** restated here. Implementations must follow BEP 44 rather than any
paraphrase, so that the same record is valid in the DHT and on the wire.

## The wire extension

Extension name: **`sp_update`**.

A peer that supports it advertises it in the BEP 10 extended handshake:

```
{ "m": { "ut_metadata": 1, "sp_update": 3 } }
```

A peer holding a newer version of a torrent it is serving SHOULD send one
`sp_update` message, carrying the bencoded record above, after the extended
handshake completes. A peer MAY send another if it learns of a newer version
while the connection is open. Peers that did not advertise `sp_update` are
never sent one.

The message is advisory. It carries no content, only an address.

### Verification

On receiving an `sp_update` for a torrent, a client **must** reject it unless
all of the following hold:

1. The torrent being served contains `spore.pub`.
2. `k` equals the key in that `spore.pub`. *(Without this check a peer could
   announce a successor signed by a key of its own choosing.)*
3. `sig` verifies over the record per BEP 44.
4. `seq` is strictly greater than the highest `seq` previously accepted for
   this key, remembered locally across sessions.
5. `v.ih` differs from the infohash currently being read.

A record that fails any check is discarded silently. A record that passes means
only that *the holder of this key says there is a newer version at this
address* — the new version is then fetched and verified like any other torrent.

### Why rule 4 exists

Without it, a peer can replay an older signed record and pin a reader to a
stale version. The content is still authentically the author's, so this is a
freshness problem rather than a forgery one, and for most sites it is a minor
one. It matters when the update *is* the point: a correction, a retraction, or
"the previous version has a security bug". Remembering the highest `seq` per
key costs a row in storage the gate already has.

A consequence: reverting is done by publishing the old content forward under a
higher `seq`, never by going back.

## Publishing an update

1. Edit the folder. Keep `spore.pub` in it — same key.
2. Create the new torrent. Its infohash is M2.
3. Build the record: `seq` = previous + 1, `v.ih` = M2. Sign with the private
   key.
4. **Keep seeding the old version**, now also offering the record over
   `sp_update`.
5. A seeder that has UDP SHOULD also publish the identical record to the DHT
   per BEP 46, so that non-browser clients resolve it the standard way.

Old links keep working and now point forward. They upgrade for exactly as long
as someone keeps the old swarm alive; when nobody does, an old link is dead —
which is what it would have been anyway.

## Bootstrapping from an identity alone

Everything above requires the reader to already hold *some* infohash: you join
that swarm and meet a peer who tells you the current one. A `btpk:`-only
address — an identity with no content address — has nothing to join. That is
the case the DHT genuinely exists to solve.

**Unproven idea, offered for scrutiny:** derive a meeting point from the key.

Construct a torrent deterministically from the public key — one file whose
content is the 32 raw bytes of the key, with the file name, torrent name and
piece length fixed by this specification. Every implementation computes the
same infohash from the same key without communicating. Publishers join that
swarm; a reader holding only `btpk:P` constructs it identically, joins through
the ordinary `wss://` trackers, meets the publisher and receives the record.

This would make identity-addressed sites work in a browser with no DHT and no
bridge, using only infrastructure that already exists. It is also the least
examined idea in this document. See Open questions.

## What this does not do

- **It does not tie a key to a person.** A signature proves the same key
  published both versions, nothing more. `P` means "you" only because you
  announced it somewhere already trusted — a talk, an existing site, a business
  card. Same as an SSH or PGP key.
- **There is no revocation.** A key is the identity; a compromised key cannot
  be retired by any mechanism here.
- **Losing the key ends the site's history.** No recovery. If the key is
  derived from a passphrase, forgetting the passphrase is losing the key.
- **It does not resurrect abandoned sites.** Nobody seeding, nothing to find.
- **It is not anonymity.** Peers see each other's addresses, as always.

## Interoperability

A Spore site remains an ordinary torrent. Clients that do not know `sp_update`
never receive it — BEP 10 makes unknown extensions a non-event — and download
the site normally. They simply do not learn about updates, which is
unsurprising given they were not going to render it either.

Because the record is a BEP 44 item and not an invention, a seeder with UDP can
publish it to the DHT, where any BEP 46-capable client resolves it without
knowing this document exists.

## Open questions

**The rendezvous swarm.** Do public `wss://` trackers accept a swarm with no
real content? What stops a stranger squatting an identity's rendezvous with
noise — signature checks make it correct but not quiet? Joining the rendezvous
tells the tracker you are interested in that identity, which is a different
disclosure from asking for an infohash. And is the deterministic construction
stable enough to specify exactly, across implementations?

**Auto-follow or offer.** When a newer version is found, does the gate switch,
or say so and wait? Switching silently changes what someone is reading, and a
specific version may have been linked deliberately. Offering means most readers
stay on stale content out of inertia. This is a product decision and it is not
made.

**Salt.** BEP 44 allows one, letting a single key run several independent
series — a site and its changelog, say. Reserved and unused for now; adding it
later changes the DHT target and the rendezvous construction, so it should be
decided before anything ships.

**Key rotation.** A record signed by the old key naming a new key is the
obvious mechanism and has an obvious flaw: whoever stole the key can rotate
first. Out of scope here, deliberately.

**Passphrase-derived keys.** Attractive — nothing to back up, publish from any
machine. But the public key is public and offline-grindable, exactly like a
cryptocurrency brain wallet. If offered at all it needs a generated multi-word
passphrase rather than a free-text field. Ed25519 and PBKDF2 are both native in
current Chrome, Chromium and Firefox, and a derived 32-byte seed can be
imported by wrapping it in the fixed PKCS#8 prefix — measured at 290–912 ms for
600k iterations of PBKDF2-SHA-512, so the cost can go higher.

[BEP 10]: https://www.bittorrent.org/beps/bep_0010.html
[BEP 44]: https://www.bittorrent.org/beps/bep_0044.html
[BEP 46]: https://www.bittorrent.org/beps/bep_0046.html
