# deploy/

Two containers that do unrelated jobs. Picking the wrong one is easy, so they
are named and separated rather than sharing a compose file at the repository
root — where `docker compose up` would read as "start the project" and quietly
have meant "seed a folder".

| | you want this if | what it is |
|---|---|---|
| **[`gate/`](gate/)** | *"let people open and publish sites"* | nginx serving the static bundle |
| **[`seeder/`](seeder/)** | *"keep my published site up when my tab is closed"* | a WebRTC seeder for one folder |

They are independent. Running the gate seeds nothing; running a seeder serves
no web page. A working setup for one person will often be the gate on a host
with TLS and a seeder wherever the content lives — but you can run either
alone, and most people only ever need the gate.

## Architectures

Both images build and run on **x86-64** and on **64-bit ARM** — a Raspberry Pi
5 running 64-bit Raspberry Pi OS or Ubuntu is fine, and so is an Apple Silicon
machine. Docker picks the right architecture for the host on its own; there is
nothing to configure.

What that rests on, since one of these is a native module:

- `nginx:1.27-alpine` and `node:22-slim` both publish `linux/arm64/v8`.
- `node-datachannel` ships a prebuilt binary per platform, and the arm64 one is
  a genuine `ELF 64-bit … ARM aarch64` object for glibc. npm downloads it, so
  no compiler is needed on the Pi.

**32-bit ARM is the exception.** There is no prebuilt binary for `armv7`/
`armhf`, so on 32-bit Raspberry Pi OS the seeder would have to compile
node-datachannel from source and the image, which carries no toolchain, will
fail to build. Use the 64-bit OS — on a Pi 5 there is no reason not to. The
gate has no native code and runs on 32-bit ARM regardless.

Verified here by inspecting the published images and binaries, not by running
them on ARM hardware: this machine is x86-64 and has no emulation registered.
If it matters to you, `docker compose build` on the Pi itself is the test, and
it either downloads the arm64 binary or fails loudly.

## gate/

```sh
cd deploy/gate
docker compose up -d          # http://localhost:8080
```

Serves `index.html`, `app.css`, `sw.js`, `js/` and `vendor/`. It stores nothing
and learns nothing about what is read through it: the site being viewed lives
in the URL fragment, which browsers never send to a server.

**HTTPS is required in production.** A service worker needs a secure context
and the gate serves every site through one, so on a plain-HTTP LAN address the
whole thing simply will not work. `localhost` is the one exemption browsers
make. Put this behind Caddy, Traefik or nginx for a real deployment — or skip
containers entirely and drop the bundle on any static host, which is what
[GitHub Pages](../README.md#hosting-it) does.

## seeder/

```sh
cd deploy/seeder
mkdir -p site data
cp -r /path/to/your-website/. site/
docker compose up -d
docker compose logs           # the magnet, printed once at startup
```

`site/` is the folder being served; `data/site.torrent` pins the magnet so it
survives restarts and rebuilds. Keep `data/`.

Two things that are easy to get wrong and are commented in the compose file:
the site volume cannot be mounted `:ro` (WebTorrent opens the files read-write
to verify them, and read-only it serves nothing while looking healthy), and
editing the site changes its address, because content *is* the address here.
