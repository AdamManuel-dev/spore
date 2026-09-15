import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import puppeteer from "puppeteer-core";
import Tracker from "bittorrent-tracker/server";

const ROOT = resolve(fileURLToPath(new URL("../../../", import.meta.url)));
const TYPES = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
};
const IMAGE =
  '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><rect width="1" height="1"/></svg>';

function chromePath() {
  const candidates = [
    process.env.CHROME,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ];
  const found = candidates.find(
    (candidate) => candidate && existsSync(candidate),
  );
  assert.ok(
    found,
    "Harness prerequisite: install Chrome/Chromium or set CHROME to its executable",
  );
  return found;
}

async function within(promise, milliseconds, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Harness timeout: ${label}`)),
          milliseconds,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Real gate/worker/WebTorrent; fixture endpoints are loopback, not an OS network sandbox. */
export async function startBrowserHarness() {
  const requests = [];
  const sockets = new Set();
  const tracker = new Tracker({
    http: false,
    udp: false,
    ws: true,
    stats: false,
  });
  tracker.on("warning", () => {});
  tracker.on("error", () => {});
  let trackerURL;
  let origin;
  let browser;
  tracker.ws.on("connection", (socket, request) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    if (request.url.startsWith("/__security_parent")) {
      requests.push({ url: request.url, kind: "websocket" });
      socket.close();
    }
  });

  const server = createServer((request, response) => {
    handle(request, response).catch((error) => {
      response.writeHead(500, { "content-type": "text/plain" });
      response.end(`Fixture server error: ${error.message}`);
    });
  });
  async function handle(request, response) {
    const url = new URL(request.url, "http://127.0.0.1");
    response.setHeader("Cache-Control", "no-store");
    if (url.pathname.startsWith("/__security_probe/")) {
      requests.push({
        url: request.url,
        referrer: request.headers.referer ?? "",
        kind: "http",
      });
      response.setHeader(
        "Content-Type",
        url.pathname.endsWith(".css") ? "text/css" : "image/svg+xml",
      );
      response.end(
        url.pathname.endsWith(".css") ? "body { --security-probe: 1; }" : IMAGE,
      );
      return;
    }
    const pathname = decodeURIComponent(url.pathname);
    let target = resolve(ROOT, `.${pathname}`);
    if (target !== ROOT && !target.startsWith(ROOT + sep)) {
      response.writeHead(403).end();
      return;
    }
    try {
      if ((await stat(target)).isDirectory())
        target = resolve(target, "index.html");
      let bytes = await readFile(target);
      if (target === resolve(ROOT, "js/config.js")) {
        const source = bytes.toString();
        const replaced = source.replace(
          /export const DEFAULT_TRACKERS = \[[^\]]*\]/,
          `export const DEFAULT_TRACKERS = [${JSON.stringify(trackerURL)}]`,
        );
        assert.notEqual(
          source,
          replaced,
          "Harness tracker override must match; never fall back to public trackers",
        );
        bytes = Buffer.from(replaced);
      }
      response.setHeader(
        "Content-Type",
        TYPES[extname(target)] ?? "application/octet-stream",
      );
      response.end(bytes);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      response
        .writeHead(404, { "Content-Type": "text/plain" })
        .end("Fixture path not found");
    }
  }
  async function close() {
    const errors = [];
    const attempt = async (operation, label) => {
      try {
        await within(Promise.resolve().then(operation), 3000, label);
      } catch (error) {
        errors.push(error);
      }
    };
    await attempt(() => browser?.close(), "browser shutdown");
    if (browser?.process()?.exitCode === null)
      browser.process().kill("SIGKILL");
    for (const socket of sockets) socket.terminate();
    await attempt(
      () => new Promise((resolve_) => tracker.close(resolve_)),
      "tracker shutdown",
    );
    server.closeAllConnections();
    if (server.listening)
      await attempt(
        () => new Promise((resolve_) => server.close(resolve_)),
        "HTTP shutdown",
      );
    if (errors.length)
      throw new AggregateError(errors, "Security harness cleanup failed");
  }
  try {
    await within(
      new Promise((resolve_, reject) => {
        tracker.once("error", reject);
        tracker.listen(0, "127.0.0.1", resolve_);
      }),
      5000,
      "tracker startup",
    );
    trackerURL = `ws://127.0.0.1:${tracker.http.address().port}`;
    const listening = once(server, "listening");
    server.listen(0, "127.0.0.1");
    await within(listening, 5000, "HTTP startup");
    origin = `http://127.0.0.1:${server.address().port}`;
    browser = await puppeteer.launch({
      executablePath: chromePath(),
      timeout: 10_000,
      headless: process.env.SECURITY_HEADFUL !== "1",
      args: [
        "--disable-background-networking",
        "--disable-component-update",
        "--no-first-run",
        ...(process.env.SECURITY_NO_SANDBOX === "1" ? ["--no-sandbox"] : []),
      ],
    });
  } catch (error) {
    try {
      await close();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "Harness startup failed");
    }
    throw error;
  }

  async function gate(t, { fallback = false, context: sharedContext } = {}) {
    const context = sharedContext ?? (await browser.createBrowserContext());
    if (!sharedContext)
      t.after(() => within(context.close(), 3000, "profile shutdown"), {
        timeout: 4000,
      });
    const page = await context.newPage();
    page.setDefaultTimeout(12_000);
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("dialog", (dialog) => dialog.accept());
    await page.setRequestInterception(true);
    page.on("request", (request) => {
      let allowed = false;
      try {
        const url = new URL(request.url());
        allowed =
          ["data:", "blob:", "about:"].includes(url.protocol) ||
          (url.hostname === "127.0.0.1" &&
            [new URL(origin).port, new URL(trackerURL).port].includes(
              url.port,
            ));
      } catch {
        /* malformed requests are refused by the test harness */
      }
      if (!allowed)
        requests.push({ url: request.url(), kind: "harness-blocked-external" });
      void (allowed ? request.continue() : request.abort()).catch(() => {});
    });
    await page.evaluateOnNewDocument(
      ({ localTracker, forceFallback }) => {
        // Avoid public STUN/ICE discovery. These tests use already-local seeded bytes,
        // not peer reachability. Socket restrictions are harness safety, not a fix.
        const NativeRTC = window.RTCPeerConnection;
        if (NativeRTC)
          window.RTCPeerConnection = class extends NativeRTC {
            constructor(config) {
              super({ ...config, iceServers: [] });
            }
          };
        const NativeSocket = window.WebSocket;
        window.WebSocket = class extends NativeSocket {
          constructor(url, protocols) {
            let local = false;
            try {
              local = new URL(url).origin === new URL(localTracker).origin;
            } catch {
              /* deny */
            }
            if (!local)
              throw new Error(
                "Security harness refuses non-loopback tracker sockets",
              );
            super(url, protocols);
          }
        };
        if (forceFallback) {
          const descriptor = Object.getOwnPropertyDescriptor(
            HTMLIFrameElement.prototype,
            "contentDocument",
          );
          Object.defineProperty(
            HTMLIFrameElement.prototype,
            "contentDocument",
            {
              ...descriptor,
              get() {
                if (
                  this.getAttribute("aria-hidden") === "true" &&
                  this.src.includes("/webtorrent/probe/")
                ) {
                  return {
                    URL: this.src,
                    body: {
                      textContent: "Simulated unsupported sandbox probe",
                    },
                  };
                }
                return descriptor.get.call(this);
              },
            },
          );
        }
      },
      { localTracker: trackerURL, forceFallback: fallback },
    );
    const response = await page.goto(origin, { waitUntil: "load" });
    assert.equal(
      response.status(),
      200,
      "Harness prerequisite: static gate must be served successfully",
    );
    try {
      await page.waitForFunction(
        () =>
          navigator.serviceWorker.controller &&
          document.getElementById("status").textContent === "Nothing open",
        { timeout: 20_000 },
      );
    } catch (error) {
      const state = await page.evaluate(() => ({
        status: document.getElementById("status")?.textContent,
        error: document.getElementById("error")?.textContent,
        controlled: Boolean(navigator.serviceWorker.controller),
      }));
      throw new Error(
        `Harness gate boot failed: ${JSON.stringify({ ...state, errors })}`,
        { cause: error },
      );
    }
    assert.deepEqual(
      errors,
      [],
      "Harness prerequisite: gate boot must not throw",
    );
    return { page, context };
  }
  return {
    origin,
    trackerURL,
    requests,
    gate,
    close,
    browserVersion: await browser.version(),
  };
}

/** Use the real publishing API, avoiding synthetic OS folder-drag support. */
export async function publishFixture(
  page,
  files,
  { signed = false, tamper = false, advertisedBytes = 0 } = {},
) {
  return page.evaluate(
    async ({ input, sign, alterSignedBytes, reportedBytes }) => {
      const { publish } = await import("/js/publish.js");
      const paths = { ...input };
      // Keep a multi-file torrent: the production publisher's single-file naming
      // behavior can otherwise remove the HTML extension and open a file listing.
      if (Object.keys(paths).length === 1)
        paths["fixture-control.txt"] = "Local multi-file fixture";
      let publicKey = null;
      if (sign) {
        const { identityFromSeed, formatSporePub } = await import(
          "/js/identity.js"
        );
        const { manifestEntries, signManifest } = await import(
          "/js/manifest.js"
        );
        const identity = await identityFromSeed(
          crypto.getRandomValues(new Uint8Array(32)),
        );
        publicKey = identity.hex;
        const entry = Object.keys(paths).find((path) =>
          /(^|\/)index\.html$/.test(path),
        );
        const root = entry.slice(0, entry.lastIndexOf("/") + 1);
        paths[`${root}spore.pub`] = formatSporePub(
          identity.hex,
          "Disposable security fixture",
          "fixture",
        );
        const entries = await manifestEntries(
          Object.entries(paths)
            .filter(([path]) => path.startsWith(root))
            .map(([path, content]) => ({
              path: path.slice(root.length),
              bytes: new TextEncoder().encode(content),
            })),
        );
        paths[`${root}spore.sig`] = await signManifest(identity.privateKey, {
          key: identity.hex,
          site: "fixture",
          entries,
        });
      }
      if (alterSignedBytes)
        paths["payload.txt"] = "Changed after the manifest was signed";
      const files_ = Object.entries(paths).map(([path, content]) => {
        const file = new File([content], path.split("/").pop());
        file.fullPath = `security-fixture/${path}`;
        return file;
      });
      const torrent = await publish(files_, "security-fixture");
      if (reportedBytes) {
        // Bounded resource-budget simulation: exercise real app verification but
        // replace only this file's advertised length/read boundary; no giant data.
        const file = torrent.files.find((item) =>
          item.path.endsWith("/payload.txt"),
        );
        if (!file) throw new Error("Missing resource-budget fixture file");
        const bytes = await file.arrayBuffer();
        file.length = reportedBytes;
        window.__securityFileReads = 0;
        file.arrayBuffer = async () => {
          window.__securityFileReads++;
          return bytes;
        };
      }
      return {
        infoHash: torrent.infoHash,
        magnet: torrent.magnetURI,
        publicKey,
      };
    },
    {
      input: files,
      sign: signed,
      alterSignedBytes: tamper,
      reportedBytes: advertisedBytes,
    },
  );
}

export async function openFixture(page, fixture) {
  await page.evaluate((magnet) => {
    location.hash = magnet;
  }, fixture.magnet);
  await page.waitForFunction(
    (hash) => {
      const frame = document.getElementById("viewer");
      return !frame.hidden && frame.src.includes(`/webtorrent/${hash}/`);
    },
    {},
    fixture.infoHash,
  );
  const frame = await (await page.$("#viewer")).contentFrame();
  assert.ok(frame, "Harness prerequisite: viewer frame exists");
  await frame.waitForFunction(
    (hash) => document.URL.includes(hash) && document.readyState === "complete",
    {},
    fixture.infoHash,
  );
  await frame.waitForSelector("#fixture-ready");
  return frame;
}

export async function grantScripts(page, infoHash) {
  // Seed an actual legacy permission through the public policy API. An eventual
  // emergency scripts-off fix must override even this persisted decision.
  await page.evaluate(async (hash) => {
    const { setScriptsAllowed } = await import("/js/policy.js");
    setScriptsAllowed(hash, true);
  }, infoHash);
}
