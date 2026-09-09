# A seeder for one Spore site, so it stays reachable with nobody's tab open.
#
# This is not the gate. It hosts nothing over HTTP and serves no web page; it
# joins a swarm and answers browsers over WebRTC. For the gate, see
# deploy/gate/.
#
# Nothing in here builds the gate — the gate is static files and needs no
# toolchain. This image exists only for the seeder, whose one hard requirement
# is a WebRTC implementation: a browser peer speaks WebRTC and nothing else, so
# an ordinary BitTorrent client cannot serve a Spore site at all.
#
# Debian rather than Alpine on purpose: node-datachannel ships prebuilt
# binaries for glibc, and on musl it would have to compile from source.
FROM node:22-slim

WORKDIR /app

# Only the two files the seeder actually needs, so a change to the gate does
# not invalidate this layer.
COPY package.json ./
COPY js/config.js ./js/config.js
COPY tools/seed.mjs ./tools/seed.mjs

RUN npm install --no-audit --no-fund webtorrent node-datachannel

# /site is the folder to serve; /data holds the pinned .torrent so the magnet
# survives restarts, rebuilds and moving to another machine.
VOLUME ["/site", "/data"]

ENTRYPOINT ["node", "tools/seed.mjs"]
CMD ["/site", "--torrent", "/data/site.torrent"]
