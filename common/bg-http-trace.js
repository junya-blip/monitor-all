const { AsyncLocalStorage } = require("node:async_hooks");
const { subscribe } = require("node:diagnostics_channel");
const { isIP } = require("node:net");
const { performance } = require("node:perf_hooks");

const context = new AsyncLocalStorage();
const requests = new WeakMap();

function errorCode(error) {
  const code = error?.code;
  return typeof code === "string" && /^[A-Z0-9_]+$/.test(code) ? code : undefined;
}

subscribe("http.client.request.created", ({ request }) => {
  const trace = context.getStore();
  if (!trace?.active) return;

  const hop = { method: request.method, timingsMs: {} };
  trace.hops.push(hop);
  requests.set(request, hop);

  function mark(stage) {
    if (!trace.active) return;
    hop.timingsMs[stage] ??= trace.elapsed();
    hop.lastStage = stage;
  }
  mark("request_created");

  request.once("socket", socket => {
    mark("socket_assigned");
    function peer() {
      hop.peerIp = socket.remoteAddress;
      hop.peerPort = socket.remotePort;
      hop.peerFamily = socket.remoteFamily;
    }
    if (request.reusedSocket) {
      peer();
      hop.tlsVersion = socket.getProtocol?.();
      mark("socket_reused");
      return;
    }

    function lookup(err, address, family) {
      if (err) {
        hop.dnsError = errorCode(err);
      } else if (isIP(address)) {
        (hop.resolved ??= []).push({ ip: address, family });
        mark("dns_complete");
      }
    }
    function connect() {
      peer();
      mark("tcp_connected");
    }
    function secureConnect() {
      hop.tlsVersion = socket.getProtocol();
      mark("tls_complete");
    }
    socket.on("lookup", lookup);
    socket.once("connect", connect);
    socket.once("secureConnect", secureConnect);
    request.once("close", () => {
      socket.off("lookup", lookup);
      socket.off("connect", connect);
      socket.off("secureConnect", secureConnect);
    });
  });

  // Observe headers before follow-redirects handles a possible redirect.
  request.prependOnceListener("response", response => {
    hop.status = response.statusCode;
    mark("headers_received");
    // An end listener observes completion without consuming the body.
    response.once("end", () => mark("body_received"));
  });
});

subscribe("http.client.request.error", ({ request, error }) => {
  const hop = requests.get(request);
  if (hop) hop.errorCode = errorCode(error);
});

function createBgHttpTrace(url) {
  const started = performance.now();
  const trace = {
    active: true,
    hops: [],
    elapsed: () => Math.round((performance.now() - started) * 10) / 10
  };
  console.log(`BG HTTP START ${url}`);
  return {
    run: operation => context.run(trace, operation),
    finish(result, error, status) {
      trace.active = false;
      const details = {
        url,
        result,
        elapsedMs: trace.elapsed(),
        lastStage: trace.hops.at(-1)?.lastStage ?? "started",
        status,
        axiosCode: errorCode(error),
        nodeCauseCode: errorCode(error?.cause),
        hops: trace.hops
      };
      const log = error ? console.error : console.log;
      log(`BG HTTP TRACE ${JSON.stringify(details)}`);
    }
  };
}

module.exports = { createBgHttpTrace };
