import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { MessageChannel } from "node:worker_threads";

export const SCOPE = "https://gate.test/app/";
export const HASH = "a".repeat(40);
export const OTHER_HASH = "b".repeat(40);
export const torrentURL = (hash = HASH, path = "index.html") =>
  `${SCOPE}webtorrent/${hash}/${path}`;

// Boundary adapter only: this is not evidence that a browser emits any specific
// combination of clientId/referrer. Routing and response construction are real sw.js.
class SimulatedFetchEvent {
  constructor(request, clientId) {
    this.request = request;
    this.clientId = clientId;
    this.resultingClientId = "";
    this.response = null;
  }
  respondWith(response) {
    this.response = Promise.resolve(response);
  }
  waitUntil() {}
}

export async function workerHarness(windows = []) {
  const listeners = new Map();
  const ports = new Set();
  const timers = new Set();
  const schedule = (fn, delay) => {
    const timer = setTimeout(() => {
      timers.delete(timer);
      fn();
    }, delay);
    timers.add(timer);
    return timer;
  };
  const cancel = (timer) => {
    clearTimeout(timer);
    timers.delete(timer);
  };
  const clients = windows.map((window) => ({
    ...window,
    postMessage(message, transferred) {
      if (!window.reply) return;
      const send = () => {
        const data = window.reply(message);
        if (data !== undefined) transferred[0].postMessage(data);
      };
      if (window.delay) schedule(send, window.delay);
      else send();
    },
  }));
  const self = {
    registration: { scope: SCOPE },
    clients: {
      get: async (id) => clients.find((client) => client.id === id),
      matchAll: async () => clients,
      claim: async () => {},
    },
    skipWaiting: async () => {},
    addEventListener: (type, handler) => listeners.set(type, handler),
  };
  class TrackedMessageChannel {
    constructor() {
      const channel = new MessageChannel();
      ports.add(channel.port1);
      ports.add(channel.port2);
      return channel;
    }
  }
  vm.runInNewContext(
    await readFile(new URL("../../../sw.js", import.meta.url), "utf8"),
    {
      self,
      URL,
      Response,
      Headers,
      ReadableStream,
      MessageChannel: TrackedMessageChannel,
      setTimeout: schedule,
      clearTimeout: cancel,
    },
    { filename: "sw.js" },
  );
  return {
    async fetch(
      url,
      { clientId = "", referrer = "", destination = "iframe" } = {},
    ) {
      const request = {
        url,
        referrer,
        destination,
        method: "GET",
        headers: new Headers(),
      };
      const event = new SimulatedFetchEvent(request, clientId);
      listeners.get("fetch")(event);
      if (!event.response) return null; // browser would use the network
      let deadline;
      try {
        return await Promise.race([
          event.response,
          new Promise((_resolve, reject) => {
            deadline = schedule(
              () =>
                reject(new Error("worker harness response deadline exceeded")),
              1500,
            );
          }),
        ]);
      } finally {
        cancel(deadline);
      }
    },
    close() {
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      for (const port of ports) {
        port.onmessage = null;
        port.close();
      }
      ports.clear();
    },
  };
}

export function responder(body = "trusted site", scripts = false) {
  return (message) =>
    message.type === "spore/policy-query"
      ? { scripts }
      : { status: 200, headers: { "Content-Type": "text/html" }, body };
}
