import test from "node:test";
import assert from "node:assert/strict";
import {
  setImmediate as tick,
  setTimeout as delay,
} from "node:timers/promises";
import { readSporePub, readManifest } from "../../js/site.js";
import { updateExtension } from "../../js/updates.js";
import { encodeRecord, signUpdate, verifyUpdate } from "../../js/record.js";
import {
  workerHarness,
  responder,
  SCOPE,
  OTHER_HASH,
  torrentURL,
} from "./helpers/worker-harness.mjs";

const gate = { id: "gate", url: SCOPE, reply: responder() };
const site = { id: "site", url: torrentURL() };

async function withWorker(windows, run) {
  const worker = await workerHarness(windows);
  try {
    await run(worker);
  } finally {
    worker.close();
  }
}

function assertDenied(response) {
  assert.ok(response, "must intercept rather than fall through to the network");
  assert.ok(
    response.status >= 400 && response.status < 500,
    `expected denial, got ${response.status}`,
  );
}

for (const [label, url] of [
  ["gate asset", `${SCOPE}js/main.js`],
  ["same-origin endpoint", "https://gate.test/collect?secret=example"],
  ["external endpoint", "https://outside.test/collect?secret=example"],
]) {
  test(`SPORE-003: known torrent cannot fall through to ${label}`, async () => {
    await withWorker([gate, site], async (worker) => {
      assertDenied(await worker.fetch(url, { clientId: site.id }));
    });
  });
}

test("control: gate bootstrap assets retain network access", async () => {
  await withWorker([gate], async (worker) => {
    assert.equal(
      await worker.fetch(`${SCOPE}js/main.js`, { clientId: gate.id }),
      null,
    );
  });
});

test("control: gate can open a torrent and a known torrent can read itself", async () => {
  await withWorker([gate, site], async (worker) => {
    for (const clientId of [gate.id, site.id]) {
      const response = await worker.fetch(torrentURL(), { clientId });
      assert.equal(response.status, 200);
      assert.equal(await response.text(), "trusted site");
      assert.match(
        response.headers.get("Content-Security-Policy"),
        /script-src 'none'/,
      );
    }
  });
});

test("control: known cross-torrent request is refused", async () => {
  await withWorker([gate, site], async (worker) => {
    assertDenied(
      await worker.fetch(torrentURL(OTHER_HASH), { clientId: site.id }),
    );
  });
});

for (const clientId of ["", "no-longer-resolvable"]) {
  test(`SPORE-004: simulated FetchEvent with unknown provenance (${clientId || "empty id"}) is denied`, async () => {
    // Explicit unit-level input, NOT a claim that sandboxed browser requests
    // actually have these fields. Browser reachability needs separate evidence.
    await withWorker([gate], async (worker) => {
      assertDenied(
        await worker.fetch(torrentURL(OTHER_HASH), { clientId, referrer: "" }),
      );
    });
  });
}

for (const boundary of ["content", "policy"]) {
  test(`SPORE-005: a torrent window cannot win the ${boundary} first-responder race`, async () => {
    const hostile = {
      id: "hostile",
      url: torrentURL(OTHER_HASH),
      reply: responder("forged content", true),
    };
    await withWorker(
      [hostile, { ...gate, delay: 20 }, site],
      async (worker) => {
        const response = await worker.fetch(torrentURL(), {
          clientId: site.id,
        });
        assert.equal(response.status, 200);
        if (boundary === "content")
          assert.equal(await response.text(), "trusted site");
        else
          assert.match(
            response.headers.get("Content-Security-Policy"),
            /script-src 'none'/,
          );
      },
    );
  });
}

for (const [path, limit, read] of [
  ["spore.pub", 4096, readSporePub],
  ["spore.sig", 512 * 1024, readManifest],
]) {
  test(`SPORE-008: oversized ${path} metadata is rejected before arrayBuffer`, async () => {
    let reads = 0;
    const torrent = {
      files: [
        {
          path,
          length: limit + 1,
          arrayBuffer: async () => {
            reads++;
            // Small payload: this checks ordering without allocating the advertised size.
            return new ArrayBuffer(0);
          },
        },
      ],
    };
    const result = await read(torrent, "index.html");
    assert.equal(
      reads,
      0,
      "untrusted file.length must be checked before materializing the file",
    );
    assert.equal(result, null);
  });
}

function textFile(path, text) {
  const bytes = new TextEncoder().encode(text);
  return { path, length: bytes.length, arrayBuffer: async () => bytes.buffer };
}

test("control: small author declaration and manifest remain readable", async () => {
  const hex = "12".repeat(32);
  const torrent = {
    files: [
      textFile("spore.pub", `${hex}\nname=Alice\n`),
      textFile("spore.sig", "small manifest"),
    ],
  };
  assert.equal((await readSporePub(torrent, "index.html")).hex, hex);
  assert.deepEqual(await readManifest(torrent, "index.html"), {
    contents: "small manifest",
    root: "",
  });
});

async function signedFixture() {
  const pair = await crypto.subtle.generateKey("Ed25519", true, [
    "sign",
    "verify",
  ]);
  const key = new Uint8Array(
    await crypto.subtle.exportKey("raw", pair.publicKey),
  );
  const record = await signUpdate(pair.privateKey, key, OTHER_HASH, 2);
  return { key, record, bytes: encodeRecord(record) };
}

function extension(options) {
  const Extension = updateExtension({
    offer: () => null,
    onUpdate: () => {},
    ...options,
  });
  return new Extension({ peerExtendedMapping: {}, extended() {} });
}

test("control: malformed and invalid signatures are rejected", async () => {
  const { key, record } = await signedFixture();
  assert.equal(
    (await verifyUpdate({ ...record, sig: new Uint8Array(63) }, key)).ok,
    false,
  );
  assert.equal(
    (await verifyUpdate({ ...record, sig: new Uint8Array(64) }, key)).ok,
    false,
  );
});

test("control: underbudget authentic update is delivered", async () => {
  const { key, bytes } = await signedFixture();
  const accepted = [];
  const rejected = [];
  await extension({
    publicKey: () => key,
    onUpdate: (value) => accepted.push(value),
    onRejected: (reason) => rejected.push(reason),
  }).onMessage(bytes);
  assert.equal(accepted.length, 1);
  assert.equal(accepted[0].infoHash, OTHER_HASH);
  assert.deepEqual(rejected, []);
});

// Proposed T16 budgets from docs/security-implementation-plan.md, NOT existing
// or measured production constants: one pending record per wire, at most two
// crypto verifications per gate. These per-instance probes are a baseline, not
// proof of fairness/global caps across every wire or tab. No live peers are used.
const PROPOSED_PENDING_BOUND = 1;
const PROPOSED_CRYPTO_BOUND = 2;
const BATCH = 64;

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("SPORE-009: unresolved metadata bounds admitted update work", async () => {
  const { key, bytes } = await signedFixture();
  assert.ok(bytes.length <= 2048);
  const ready = deferred();
  let started = 0;
  const receiver = extension({
    publicKey: () => {
      started++;
      return ready.promise;
    },
  });
  const jobs = [];
  let settled = 0;
  try {
    for (let i = 0; i < BATCH; i++) {
      const job = Promise.resolve(receiver.onMessage(bytes));
      jobs.push(
        job.finally(() => {
          settled++;
        }),
      );
    }
    await tick();
    assert.ok(started > 0, "positive control: production invoked publicKey");
    const pending = BATCH - settled;
    assert.ok(
      started <= PROPOSED_PENDING_BOUND,
      `${started} key lookups admitted; returning early from onMessage must not hide unbounded background work`,
    );
    assert.ok(
      pending <= PROPOSED_PENDING_BOUND,
      `${pending} message handlers remain pending (${started} key lookups); proposed per-wire cap ${PROPOSED_PENDING_BOUND}`,
    );
  } finally {
    ready.resolve(key);
    await Promise.allSettled(jobs);
  }
});

test("SPORE-009: update verification has bounded crypto concurrency", async (t) => {
  const { key, bytes } = await signedFixture();
  assert.ok(bytes.length <= 2048);
  const ready = deferred();
  const subtle = crypto.subtle;
  const realVerify = subtle.verify.bind(subtle);
  let active = 0;
  let peak = 0;
  let starts = 0;
  t.mock.method(subtle, "verify", async (...args) => {
    starts++;
    active++;
    peak = Math.max(peak, active);
    try {
      await ready.promise;
      return await realVerify(...args);
    } finally {
      active--;
    }
  });
  const jobs = [];
  const receiver = extension({ publicKey: () => key });
  try {
    for (let i = 0; i < BATCH; i++) jobs.push(receiver.onMessage(bytes));
    // Hold verification open for a bounded wall-clock readiness window. A
    // fixed microtask count can end before native importKey has completed.
    const deadline = Date.now() + 1000;
    while (starts < BATCH && Date.now() < deadline) await delay(5);
  } finally {
    ready.resolve();
    await Promise.allSettled(jobs);
    t.mock.restoreAll();
  }
  // Include late-arriving native work in the verdict rather than passing on an
  // early peak sampled before all submitted handlers have completed.
  assert.ok(
    starts > 0,
    "positive control: production reached crypto.subtle.verify",
  );
  assert.ok(
    peak <= PROPOSED_CRYPTO_BOUND,
    `${peak} verifications concurrently active; proposed cap ${PROPOSED_CRYPTO_BOUND}`,
  );
});
