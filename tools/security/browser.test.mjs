import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  startBrowserHarness,
  publishFixture,
  openFixture,
  grantScripts,
} from "./helpers/browser-harness.mjs";

let harness;
before(
  async () => {
    harness = await startBrowserHarness();
  },
  { timeout: 25_000 },
);
after(
  async () => {
    await harness?.close();
  },
  { timeout: 12_000 },
);
const options = { timeout: 40_000 };
const html = (body) =>
  `<!doctype html><html><body><h1 id="fixture-ready">Security fixture</h1>${body}</body></html>`;
const probe = (source) =>
  html(
    `<script>document.body.dataset.started='yes'; (async()=>{try{${source}}catch(error){document.body.dataset.probeError=error.name}finally{document.body.dataset.finished='yes'}})()</script>`,
  );

async function result(frame) {
  await frame.waitForFunction(() => document.readyState === "complete");
  if (await frame.evaluate(() => document.body.dataset.started === "yes")) {
    await frame.waitForFunction(() => document.body.dataset.finished === "yes");
  }
  return frame.evaluate(() => ({ ...document.body.dataset }));
}

async function rememberDisposableKey(page) {
  return page.evaluate(async () => {
    const { identityFromSeed } = await import("/js/identity.js");
    const { rememberKeyOnDevice, useIdentity } = await import("/js/me.js");
    const identity = await identityFromSeed(
      crypto.getRandomValues(new Uint8Array(32)),
    );
    await rememberKeyOnDevice(identity);
    useIdentity(identity, "Disposable fixture key");
    return identity.hex;
  });
}

async function waitUntil(condition, milliseconds = 1500) {
  const deadline = Date.now() + milliseconds;
  do {
    try {
      if (await condition()) return true;
    } catch (error) {
      if (
        !/Execution context was destroyed|Cannot find context|detached Frame/.test(
          error.message,
        )
      )
        throw error;
    }
    await delay(25);
  } while (Date.now() < deadline);
  return false;
}

test(
  "CONTROL browser: real worker renders own resources, blocks default scripts, and verifies signed bytes",
  options,
  async (t) => {
    const { page } = await harness.gate(t);
    t.diagnostic(`Browser engine: ${harness.browserVersion}`);
    const fixture = await publishFixture(
      page,
      {
        "index.html": html(
          '<link rel="stylesheet" href="style.css"><img id="own-image" src="pixel.svg"><script>document.body.dataset.ran="yes"</script>',
        ),
        "style.css": "h1 { color: rgb(1, 2, 3); }",
        "pixel.svg":
          '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><rect width="1" height="1"/></svg>',
      },
      { signed: true },
    );
    const frame = await openFixture(page, fixture);
    await frame.waitForFunction(() => document.readyState === "complete");
    const observed = await frame.evaluate(() => ({
      ran: document.body.dataset.ran ?? null,
      image: document.getElementById("own-image").naturalWidth,
      color: getComputedStyle(document.getElementById("fixture-ready")).color,
    }));
    assert.deepEqual(observed, { ran: null, image: 1, color: "rgb(1, 2, 3)" });
    await page.waitForFunction(
      () => document.getElementById("author").dataset.state === "verified",
    );
    assert.ok(fixture.publicKey);
  },
);

test(
  "CONTROL browser: changed content fails manifest verification",
  options,
  async (t) => {
    const { page } = await harness.gate(t);
    const fixture = await publishFixture(
      page,
      { "index.html": html(""), "payload.txt": "Original signed bytes" },
      { signed: true, tamper: true },
    );
    await openFixture(page, fixture);
    await page.waitForFunction(
      () => document.getElementById("author").dataset.state === "broken",
    );
    assert.equal(
      await page.$eval("#author", (node) => node.dataset.state),
      "broken",
    );
  },
);

test(
  "SPORE-008 browser: automatic verification rejects an oversized advertised file before reading",
  options,
  async (t) => {
    const { page } = await harness.gate(t);
    const fixture = await publishFixture(
      page,
      { "index.html": html(""), "payload.txt": "Tiny actual fixture" },
      { signed: true, advertisedBytes: 16 * 1024 * 1024 + 1 },
    );
    await openFixture(page, fixture);
    await page.waitForFunction(() => {
      const state = document.getElementById("author").dataset.state;
      return state && state !== "checking";
    });
    assert.equal(
      await page.evaluate(() => window.__securityFileReads),
      0,
      "Proposed 16 MiB automatic per-file cap: declared length is simulated, production verification runs, allocation remains tiny",
    );
  },
);

test(
  "SPORE-001 browser: a stored script grant must not expose gate DOM or storage",
  options,
  async (t) => {
    const { page } = await harness.gate(t);
    await page.evaluate(() => {
      const canary = document.createElement("span");
      canary.id = "security-gate-canary";
      canary.textContent = "unchanged";
      document.body.append(canary);
      localStorage.setItem("security.disposable-canary", "fixture-secret");
    });
    const fixture = await publishFixture(page, {
      "index.html": probe(`
    try { parent.document.getElementById('security-gate-canary').textContent='changed'; document.body.dataset.parentRead='yes' } catch {}
    try { if(localStorage.getItem('security.disposable-canary')==='fixture-secret') document.body.dataset.storageRead='yes' } catch {}
  `),
    });
    await grantScripts(page, fixture.infoHash);
    const observed = await result(await openFixture(page, fixture));
    const canary = await page.$eval(
      "#security-gate-canary",
      (node) => node.textContent,
    );
    assert.deepEqual(
      {
        parentRead: observed.parentRead ?? null,
        storageRead: observed.storageRead ?? null,
        canary,
      },
      { parentRead: null, storageRead: null, canary: "unchanged" },
      "Content must not inherit gate authority; disabling scripts is also a valid containment fix",
    );
  },
);

test(
  "SPORE-001 browser: content cannot sign using a remembered gate key",
  options,
  async (t) => {
    const { page } = await harness.gate(t);
    await rememberDisposableKey(page);
    const fixture = await publishFixture(page, {
      "index.html": probe(`
    const {getKey}=await import('/js/idb.js'); const key=await getKey();
    if(key){const sig=await crypto.subtle.sign('Ed25519',key.privateKey,new TextEncoder().encode('disposable security challenge')); document.body.dataset.signed=String(sig.byteLength)}
  `),
    });
    await grantScripts(page, fixture.infoHash);
    const observed = await result(await openFixture(page, fixture));
    assert.equal(
      observed.signed,
      undefined,
      "A non-extractable key must not be reachable as a signing capability from content",
    );
  },
);

test(
  "SPORE-001 browser: content cannot borrow gate WebSocket egress authority",
  options,
  async (t) => {
    const { page } = await harness.gate(t);
    const token = `parent-${Date.now()}`;
    // Gate-authorized loopback socket is a positive control for the observer.
    await page.evaluate(
      (url) =>
        new Promise((resolve_, reject) => {
          const socket = new WebSocket(url);
          socket.onopen = () => {
            socket.close();
            resolve_();
          };
          socket.onerror = () =>
            reject(new Error("Loopback WebSocket control failed"));
        }),
      `${harness.trackerURL}/__security_parent/control-${token}`,
    );
    assert.ok(
      harness.requests.some(
        (request) => request.url === `/__security_parent/control-${token}`,
      ),
    );
    const fixture = await publishFixture(page, {
      "index.html": probe(
        `await new Promise((resolve_,reject)=>{const script=parent.document.createElement('script');script.src=new URL('bridge.js',location.href).href;script.onload=resolve_;script.onerror=reject;parent.document.body.append(script)})`,
      ),
      "bridge.js": `window.__securitySocket=new WebSocket(${JSON.stringify(`${harness.trackerURL}/__security_parent/${token}`)});window.__securitySocket.onopen=()=>window.__securitySocket.close();`,
    });
    await grantScripts(page, fixture.infoHash);
    const observed = await result(await openFixture(page, fixture));
    if (observed.started)
      await waitUntil(() =>
        harness.requests.some(
          (request) => request.url === `/__security_parent/${token}`,
        ),
      );
    assert.equal(
      harness.requests.filter(
        (request) => request.url === `/__security_parent/${token}`,
      ).length,
      0,
      "A child cannot escape its network policy by inserting code into the gate",
    );
  },
);

test(
  "SPORE-002 browser: simulated failed sandbox probe overrides legacy grants",
  options,
  async (t) => {
    const { page } = await harness.gate(t, { fallback: true });
    assert.equal(
      await page.evaluate(async () =>
        (await import("/js/viewer.js")).sandboxWorks(),
      ),
      false,
      "Harness prerequisite: probe failure must actually have been observed",
    );
    const fixture = await publishFixture(page, {
      "index.html": probe('document.body.dataset.executed="yes"'),
    });
    await grantScripts(page, fixture.infoHash);
    await page.evaluate((magnet) => {
      location.hash = magnet;
    }, fixture.magnet);
    await page.waitForFunction(
      () =>
        document.getElementById("isolation-dialog")?.open ||
        !document.getElementById("notice").hidden,
    );
    if (
      await page.evaluate(
        () => document.getElementById("isolation-dialog")?.open,
      )
    ) {
      await page.click("#isolation-accept");
    }
    await page.waitForFunction(() => {
      const frame = document.getElementById("viewer");
      const notice = document.getElementById("notice");
      return (
        (!frame.hidden &&
          frame.contentDocument?.readyState === "complete" &&
          frame.contentDocument?.getElementById("fixture-ready")) ||
        (frame.hidden &&
          !notice.hidden &&
          /not|cannot|unsupported|isola/i.test(notice.textContent))
      );
    });
    const shown = await page.$eval("#viewer", (frame) => !frame.hidden);
    if (shown) {
      const frame = await (await page.$("#viewer")).contentFrame();
      const observed = await result(frame);
      assert.equal(
        observed.executed,
        undefined,
        "Fallback must enforce scripts off, not merely reject the toggle action",
      );
    } else {
      assert.match(
        await page.$eval("#notice", (node) => node.textContent),
        /not|cannot|unsupported|isola/i,
      );
    }
  },
);

test(
  "SPORE-003 browser: scripts-off images and CSS cannot hit non-torrent host paths",
  options,
  async (t) => {
    const { page } = await harness.gate(t);
    const token = `passive-${Date.now()}`;
    const control = await page.evaluate(
      async () => (await fetch("/__security_probe/control.svg")).status,
    );
    assert.equal(
      control,
      200,
      "Harness counting endpoint is available to the gate",
    );
    const fixture = await publishFixture(page, {
      "index.html": html(`
    <img src="/__security_probe/${token}.svg"><link rel="stylesheet" href="/__security_probe/${token}.css">
  `),
    });
    const frame = await openFixture(page, fixture);
    await frame.waitForFunction(() => document.readyState === "complete");
    const leaked = harness.requests.filter((request) =>
      request.url.includes(token),
    );
    t.diagnostic(JSON.stringify(leaked));
    assert.equal(
      leaked.length,
      0,
      "Content resources must stay within the torrent even when the URL is same-origin",
    );
  },
);

test(
  "SPORE-004 browser: referrerless nested navigation must not load a second torrent",
  options,
  async (t) => {
    const { page } = await harness.gate(t);
    const target = await publishFixture(page, {
      "index.html": html('<p id="other-torrent">Other torrent bytes</p>'),
    });
    const targetFrame = await openFixture(page, target);
    assert.ok(
      await targetFrame.$("#other-torrent"),
      "Target torrent is genuinely available to authorized gate navigation",
    );
    const source = await publishFixture(page, {
      "index.html": html(
        `<iframe referrerpolicy="no-referrer" src="/webtorrent/${target.infoHash}/security-fixture/index.html"></iframe>`,
      ),
    });
    const frame = await openFixture(page, source);
    await frame.waitForFunction(() => document.readyState === "complete");
    const children = frame.childFrames();
    assert.equal(
      children.length,
      1,
      "The fixture created its nested browsing context",
    );
    const loaded = await children[0].evaluate(() => ({
      loaded: Boolean(document.getElementById("other-torrent")),
      url: document.URL,
      text: document.body?.textContent?.slice(0, 100),
    }));
    t.diagnostic(JSON.stringify(loaded));
    assert.equal(
      loaded.loaded,
      false,
      "This is a Chromium observation, not a claim about untested engines or script-readable cross-torrent bytes",
    );
  },
);

test(
  "SPORE-006 browser: navigating outside a signed root must not retain verified attribution",
  options,
  async (t) => {
    const { page } = await harness.gate(t);
    const fixture = await publishFixture(
      page,
      {
        "signed/index.html": html(
          '<a id="leave-root" href="../unsigned.html">Sibling</a>',
        ),
        "unsigned.html":
          '<!doctype html><h1 id="unsigned-sibling">Unsigned sibling</h1>',
      },
      { signed: true },
    );
    const frame = await openFixture(page, fixture);
    await page.waitForFunction(
      () => document.getElementById("author").dataset.state === "verified",
    );
    const navigation = frame
      .waitForNavigation({ waitUntil: "load", timeout: 5000 })
      .then(
        () => true,
        (error) => {
          if (error.name !== "TimeoutError") throw error;
          return false;
        },
      );
    await frame.click("#leave-root");
    const navigated = await navigation;
    const explicitRejection = await page.evaluate(() => {
      const notice = document.getElementById("notice");
      return (
        !notice.hidden &&
        /refused|denied|outside|scope|root/i.test(notice.textContent)
      );
    });
    assert.ok(
      navigated || explicitRejection,
      "Observation was inconclusive: require completed navigation or explicit scope rejection, not an unchanged page after a short sleep",
    );
    const currentFrame = await (await page.$("#viewer")).contentFrame();
    const observed = {
      unsignedShown: Boolean(
        currentFrame && (await currentFrame.$("#unsigned-sibling")),
      ),
      badge: await page.$eval("#author", (node) =>
        node.hidden ? "hidden" : node.dataset.state,
      ),
    };
    assert.equal(
      observed.unsignedShown && observed.badge === "verified",
      false,
      JSON.stringify(observed),
    );
  },
);

test(
  "SPORE-007 browser: sign-out must report a failed stored-key deletion",
  options,
  async (t) => {
    const { page } = await harness.gate(t);
    await rememberDisposableKey(page);
    const outcome = await page.evaluate(async () => {
      const { signOut } = await import("/js/me.js");
      const { getKey } = await import("/js/idb.js");
      const original = IDBDatabase.prototype.transaction;
      let injected = 0;
      IDBDatabase.prototype.transaction = function (stores, mode, ...rest) {
        if ([stores].flat().includes("keys") && mode === "readwrite") {
          injected++;
          throw new DOMException("Injected deletion failure", "UnknownError");
        }
        return original.call(this, stores, mode, ...rest);
      };
      let reported = false;
      try {
        const answer = await signOut();
        reported =
          answer === false ||
          answer?.ok === false ||
          Boolean(answer?.problems?.length);
      } catch {
        reported = true;
      } finally {
        IDBDatabase.prototype.transaction = original;
      }
      return { injected, reported, keyRemains: Boolean(await getKey()) };
    });
    assert.equal(
      outcome.injected,
      1,
      "Harness injected the actual key deletion transaction",
    );
    assert.equal(
      outcome.keyRemains,
      true,
      "The failed delete must leave the disposable record intact",
    );
    assert.equal(
      outcome.reported,
      true,
      "Failure must be observable to the caller, not silently reported as success",
    );
  },
);

test(
  "SPORE-007 browser: sign-out locks cooperative other-tab signing sessions",
  options,
  async (t) => {
    const { page, context } = await harness.gate(t);
    await rememberDisposableKey(page);
    const { page: other } = await harness.gate(t, { context });
    // A real cooperative gate tab, not a claim that stolen handles are revocable.
    await other.evaluate(async () => {
      await (await import("/js/me.js")).restoreRememberedKey();
    });
    assert.equal(
      await other.evaluate(async () =>
        Boolean((await import("/js/me.js")).me()),
      ),
      true,
    );
    await page.evaluate(async () => {
      await (await import("/js/me.js")).signOut();
    });
    const locked = await waitUntil(() =>
      other.evaluate(async () => (await import("/js/me.js")).me() === null),
    );
    assert.equal(
      locked,
      true,
      "Cooperative sessions must lock; previously stolen raw CryptoKey handles cannot be recalled by this",
    );
  },
);

test(
  "CONTROL key lifetime: deleting storage does NOT revoke a retained CryptoKey handle",
  options,
  async (t) => {
    const { page } = await harness.gate(t);
    await rememberDisposableKey(page);
    const observation = await page.evaluate(async () => {
      const { getKey } = await import("/js/idb.js");
      const held = await getKey();
      await (await import("/js/me.js")).signOut();
      const message = new TextEncoder().encode(
        "disposable retained-handle control",
      );
      const signature = await crypto.subtle.sign(
        "Ed25519",
        held.privateKey,
        message,
      );
      const publicKey = await crypto.subtle.importKey(
        "raw",
        held.publicKey,
        "Ed25519",
        false,
        ["verify"],
      );
      return {
        deleted: (await getKey()) == null,
        extractable: held.privateKey.extractable,
        verifies: await crypto.subtle.verify(
          "Ed25519",
          publicKey,
          signature,
          message,
        ),
      };
    });
    assert.deepEqual(
      observation,
      { deleted: true, extractable: false, verifies: true },
      "Characterization, not a vulnerability acceptance test: fixes must prevent access or retire the identity, not promise impossible revocation",
    );
  },
);

test(
  "SPORE-010 browser: reading a declared author without consent leaves no persistent history",
  options,
  async (t) => {
    const { page } = await harness.gate(t);
    const declaration = await page.evaluate(async () => {
      const { identityFromSeed, formatSporePub } = await import(
        "/js/identity.js"
      );
      const identity = await identityFromSeed(
        crypto.getRandomValues(new Uint8Array(32)),
      );
      return {
        key: identity.hex,
        text: formatSporePub(
          identity.hex,
          "Unverified fixture author",
          "fixture",
        ),
      };
    });
    const fixture = await publishFixture(page, {
      "index.html": html(""),
      "spore.pub": declaration.text,
    });
    await openFixture(page, fixture);
    await page.waitForFunction(
      () => document.getElementById("author").dataset.state === "unverified",
    );
    const history = await page.evaluate(
      (key) =>
        JSON.parse(localStorage.getItem("spore.authors") ?? "{}")[key] ?? null,
      declaration.key,
    );
    assert.equal(
      history,
      null,
      `No Keep, recognition consent, or signature proof was supplied; persisted ${JSON.stringify(history)}`,
    );
  },
);

test(
  "SPORE-010 browser: reset reports blocked IndexedDB erasure instead of success",
  options,
  async (t) => {
    const { page } = await harness.gate(t);
    const outcome = await page.evaluate(async () => {
      const held = await new Promise((resolve_, reject) => {
        const request = indexedDB.open("spore");
        request.onsuccess = () => resolve_(request.result);
        request.onerror = () => reject(request.error);
      });
      let askedToClose = false;
      held.onversionchange = () => {
        askedToClose = true;
      }; // Deliberately keep this fixture connection open.
      try {
        const problems = await (
          await import("/js/diagnostics.js")
        ).resetBrowserState();
        return { askedToClose, problems };
      } finally {
        held.close();
      }
    });
    assert.equal(
      outcome.askedToClose,
      true,
      "The real database deletion encountered an open connection",
    );
    assert.ok(
      outcome.problems.some((problem) =>
        /database|blocked|incomplete|pending/i.test(problem),
      ),
      "A blocked deletion must be reported as incomplete; timeout or onblocked is not success",
    );
  },
);

test(
  "SPORE-010 browser: full reset removes all Spore metadata but preserves unrelated data",
  options,
  async (t) => {
    const { page } = await harness.gate(t);
    const observed = await page.evaluate(async () => {
      const owned = [
        "spore.authors",
        "spore.published",
        "spore.my-keys",
        "spore.scripts-allowed",
      ];
      for (const key of owned) localStorage.setItem(key, "{}");
      localStorage.setItem("neighbor.canary", "keep");
      await caches.open("neighbor-cache");
      await (await import("/js/diagnostics.js")).resetBrowserState();
      return {
        remaining: owned.filter((key) => localStorage.getItem(key) !== null),
        neighbor: localStorage.getItem("neighbor.canary"),
        neighborCache: (await caches.keys()).includes("neighbor-cache"),
      };
    });
    assert.deepEqual(
      observed,
      { remaining: [], neighbor: "keep", neighborCache: true },
      "Reset must erase owned metadata without deleting another application’s cache",
    );
  },
);
