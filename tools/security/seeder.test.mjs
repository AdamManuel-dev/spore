// SPORE-011 secure-contract regressions. Run: node --test tools/security/seeder.test.mjs
// Node >=22.15 is required for the preload's module.registerHooks API.
// Real entry point, filesystem publication/restore, and HTTP responses; only
// WebTorrent/WebRTC and listen binding are instrumented (see seeder-preload).
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { fixtureHash } from "./helpers/seeder-torrent.mjs";

const oldBytes = "<!doctype html><title>Disposable retained fixture</title>";
const newBytes = "<!doctype html><title>Disposable current fixture</title>";
const oldHash = fixtureHash(oldBytes);
const newHash = fixtureHash(newBytes);

async function launch(t, disabled = false) {
  const root = await mkdtemp(join(tmpdir(), "spore-security-seeder-"));
  let child;
  t.after(async () => {
    try {
      if (child && child.exitCode === null && child.signalCode === null) {
        const exited = once(child, "exit");
        child.kill("SIGINT");
        const force = setTimeout(() => child.kill("SIGKILL"), 1000);
        try {
          await exited;
        } finally {
          clearTimeout(force);
        }
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  const content = join(root, "content");
  const data = join(root, "data");
  const retained = join(data, "versions", "1");
  await mkdir(content, { recursive: true });
  await mkdir(join(retained, "fixture"), { recursive: true });
  await writeFile(join(content, "index.html"), newBytes);
  await writeFile(join(retained, "fixture", "index.html"), oldBytes);
  await writeFile(
    join(data, "versions.json"),
    JSON.stringify({
      versions: [{ seq: 1, infoHash: oldHash, dir: retained, createdAt: 1 }],
    }),
  );

  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !key.startsWith("SPORE_") && key !== "NODE_OPTIONS",
    ),
  );
  Object.assign(env, {
    SPORE_CONTENT: content,
    SPORE_DATA: data,
    SPORE_SITE_NAME: "fixture",
    SPORE_WATCH_SECONDS: "0",
    SPORE_UID: String(process.getuid?.() ?? 1000),
    SPORE_GID: String(process.getgid?.() ?? 1000),
  });
  // Leave status port and host entirely unset for the native-default cases.
  if (disabled) env.SPORE_STATUS_PORT = "0";
  child = spawn(
    process.execPath,
    [
      "--import",
      fileURLToPath(new URL("./helpers/seeder-preload.mjs", import.meta.url)),
      fileURLToPath(new URL("../seed.mjs", import.meta.url)),
    ],
    { env, stdio: ["ignore", "pipe", "pipe", "ipc"] },
  );
  let output = "";
  let spawnError;
  child.on("error", (error) => {
    spawnError = error;
  });
  child.stdout.on("data", (bytes) => {
    output += bytes;
  });
  child.stderr.on("data", (bytes) => {
    output += bytes;
  });
  const deadline = Date.now() + 8000;
  while (
    !output.includes("Re-announcing every") ||
    (!disabled && !output.includes("Status on "))
  ) {
    if (spawnError || child.exitCode !== null || Date.now() > deadline) {
      throw new Error(
        `Seeder harness did not reach startup: ${spawnError ?? output}`,
      );
    }
    await delay(10);
  }
  // Prove restore and publication both ran successfully, independent of HTTP
  // inventory (which is precisely the disclosure these tests prohibit).
  const state = JSON.parse(await readFile(join(data, "versions.json"), "utf8"));
  assert.deepEqual(
    state.versions.map((version) => version.infoHash),
    [oldHash, newHash],
    "Harness must restore a retained version and publish readable current content",
  );
  const snapshot = once(child, "message", {
    signal: AbortSignal.timeout(3000),
  });
  child.send("snapshot");
  const [message] = await snapshot;
  assert.equal(message.type, "snapshot");
  return {
    requests: message.requests,
    async get(path) {
      assert.equal(
        message.requests.length,
        1,
        "Harness expects one real status server",
      );
      const port = message.requests[0].actualPort;
      assert.ok(port > 0, "Instrumented loopback server must be listening");
      const response = await fetch(`http://127.0.0.1:${port}${path}`, {
        headers: { Origin: "https://untrusted.invalid" },
        signal: AbortSignal.timeout(3000),
      });
      return {
        status: response.status,
        headers: response.headers,
        text: await response.text(),
      };
    },
  };
}

function assertNoInventory(text) {
  for (const marker of [oldHash, newHash, "magnet:?"]) {
    assert.ok(
      !text.includes(marker),
      `SPORE-011: public health must not disclose ${marker}`,
    );
  }
}

test("SPORE-011: native default requests a loopback status bind (instrumented request, not wide-bind probe)", async (t) => {
  const seeder = await launch(t);
  assert.equal(seeder.requests.length, 1);
  assert.ok(
    ["127.0.0.1", "::1", "localhost"].includes(seeder.requests[0].host),
    `SPORE-011: native default must explicitly request loopback; requested ${JSON.stringify(seeder.requests[0])}`,
  );
});

test("SPORE-011: health omits current and retained magnet inventory", async (t) => {
  const seeder = await launch(t);
  const response = await seeder.get("/");
  assert.equal(response.status, 200);
  assertNoInventory(response.text);
});

test("SPORE-011: health omits detailed identity and version fields, including on unsigned startup", async (t) => {
  const seeder = await launch(t);
  const response = await seeder.get("/");
  assert.equal(response.status, 200);
  const body = JSON.parse(response.text);
  const exposed = [
    "key",
    "site",
    "name",
    "current",
    "magnetURI",
    "versions",
  ].filter((key) => Object.hasOwn(body, key));
  assert.deepEqual(
    exposed,
    [],
    "SPORE-011: unauthenticated health must not publish identity/inventory fields",
  );
});

test("SPORE-011: health does not grant wildcard cross-origin reads", async (t) => {
  const seeder = await launch(t);
  const response = await seeder.get("/");
  assert.equal(response.status, 200);
  assert.notEqual(
    response.headers.get("access-control-allow-origin"),
    "*",
    "SPORE-011: arbitrary websites must not be granted status access",
  );
});

test("SPORE-011: unknown status paths do not return inventory", async (t) => {
  const seeder = await launch(t);
  const response = await seeder.get("/not-a-health-route");
  assertNoInventory(response.text);
  assert.equal(
    response.status,
    404,
    "SPORE-011: unknown status paths must be rejected",
  );
});

test("SPORE-011 positive control: explicit status disabled still seeds but never requests a listener", async (t) => {
  const seeder = await launch(t, true);
  assert.deepEqual(seeder.requests, []);
});
