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
# Debian for the boring reason that it is the most widely tested target, not
# because Alpine would fail: node-datachannel publishes prebuilt binaries for
# linux x64 and arm64, glibc and musl alike, so npm downloads one rather than
# compiling. Nothing here needs a toolchain on any of those.
#
# The architecture that does NOT have a prebuilt binary is 32-bit ARM. On a
# 64-bit OS a Raspberry Pi is fine; on 32-bit Raspberry Pi OS this image cannot
# build without adding cmake and a compiler.
FROM node:22-slim

WORKDIR /app

# The seeder signs with the gate's own code rather than a second implementation
# that could drift from it — the same bencode, the same BEP 44 record, the same
# key derivation. All of it runs unmodified under Node: WebCrypto has Ed25519.
COPY package.json ./
COPY js/config.js js/bencode.js js/identity.js js/record.js js/updates.js ./js/
COPY tools/seed.mjs ./tools/seed.mjs

RUN npm install --no-audit --no-fund webtorrent node-datachannel

# /site is the folder to serve, and can be mounted read-only. /data holds a
# frozen copy of every published version — that is what makes each magnet
# permanent, and what lets readers on an old version be told about a new one.
VOLUME ["/site", "/data"]

# The status endpoint, so `docker ps` can report more than "the process has not
# exited". A seeder's characteristic failure is staying up while serving
# nothing, which a liveness check on the process cannot see.
EXPOSE 8081

# Healthy means every version it claims to seed actually verifies — not merely
# that the process has not exited, which is a seeder's characteristic failure.
HEALTHCHECK --interval=60s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.SPORE_STATUS_PORT||8081)+'/').then(r=>r.json()).then(s=>process.exit(s.complete?0:1)).catch(()=>process.exit(1))"

# No arguments. Everything is configuration, and configuration is environment —
# which keeps the passphrase out of the command line, where `docker inspect`
# and `ps` would show it to anyone on the host.
ENTRYPOINT ["node", "tools/seed.mjs"]
