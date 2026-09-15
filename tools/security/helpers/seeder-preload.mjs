// Requires Node >=22.15 (module.registerHooks). Loaded with --import, before
// the REAL tools/seed.mjs entry point. No source extraction or replacement.
import { registerHooks } from "node:module";
import { Server } from "node:http";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "webtorrent") {
      return {
        url: new URL("./seeder-torrent.mjs", import.meta.url).href,
        shortCircuit: true,
      };
    }
    if (specifier === "node-datachannel/polyfill") {
      return {
        url: "data:text/javascript,export default {}",
        shortCircuit: true,
      };
    }
    return nextResolve(specifier, context);
  },
});

// SAFETY INSTRUMENTATION: record the host/port requested by production, then
// force a loopback ephemeral socket. This tests the native bind REQUEST, not
// actual wide-interface reachability. The HTTP handler is wholly production.
const originalListen = Server.prototype.listen;
const requests = [];
Server.prototype.listen = function (...args) {
  let options = args[0];
  if (typeof options !== "object") {
    options = { port: args[0] };
    if (typeof args[1] === "string") options.host = args[1];
  }
  const record = { host: options.host ?? null, port: options.port };
  requests.push(record);
  const callback = args.find((arg) => typeof arg === "function");
  return originalListen.call(this, { port: 0, host: "127.0.0.1" }, () => {
    record.actualPort = this.address().port;
    callback?.();
  });
};

// IPC keeps the offline client alive even when production disables status.
process.on("message", (message) => {
  if (message === "snapshot") process.send({ type: "snapshot", requests });
});
