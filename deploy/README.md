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
