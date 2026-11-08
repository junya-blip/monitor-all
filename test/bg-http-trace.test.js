const assert = require("node:assert/strict");
const http = require("node:http");
const net = require("node:net");
const { test } = require("node:test");
const axios = require("axios");
const { createBgHttpTrace } = require("../common/bg-http-trace");

async function listen(server) {
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  return server.address().port;
}

test("observes real Axios requests without changing their transport", async t => {
  const lines = [];
  t.mock.method(console, "log", line => lines.push(line));
  t.mock.method(console, "error", line => lines.push(line));
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    if (req.url === "/headers-stall") return;
    if (req.url === "/body-stall") {
      res.writeHead(200);
      res.write("partial");
      return;
    }
    if (req.url === "/redirect") {
      res.writeHead(302, { Location: "/200" }).end();
      return;
    }
    res.writeHead(Number(req.url.slice(1)), {
      "Set-Cookie": "secret-response-cookie"
    }).end("secret-response-body");
  });
  const tlsStall = net.createServer(socket => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  const port = await listen(server);
  const tlsPort = await listen(tlsStall);
  const keepAlive = new http.Agent({ keepAlive: true, maxSockets: 1 });
  const tcpStall = new http.Agent();
  tcpStall.createConnection = () => {
    const socket = new net.Socket();
    socket.connecting = true;
    setImmediate(() => socket.emit("lookup", null, "127.0.0.1", 4));
    return socket;
  };
  t.after(() => {
    tcpStall.destroy();
    keepAlive.destroy();
    server.closeAllConnections();
    server.close();
    sockets.forEach(socket => socket.destroy());
    tlsStall.close();
  });

  const base = `http://localhost:${port}`;
  async function request(url, options) {
    const trace = createBgHttpTrace(url);
    let error;
    let status;
    try {
      const response = await trace.run(() => axios.get(url, {
        proxy: false,
        headers: { Authorization: "secret-request-token" },
        ...options
      }));
      status = response.status;
    } catch (err) {
      error = err;
      status = err.response?.status;
    }
    trace.finish(error ? "failed" : "ok", error, status);
    return JSON.parse(lines.at(-1).slice("BG HTTP TRACE ".length));
  }

  assert.equal((await request("http://dns-stall.test", {
    lookup() {}, signal: AbortSignal.timeout(150)
  })).lastStage, "socket_assigned");
  assert.equal((await request("http://tcp-stall.test", {
    httpAgent: tcpStall, signal: AbortSignal.timeout(150)
  })).lastStage, "dns_complete");
  assert.equal((await request(`https://localhost:${tlsPort}`, {
    signal: AbortSignal.timeout(150)
  })).lastStage, "tcp_connected");
  assert.equal((await request(base + "/headers-stall", {
    signal: AbortSignal.timeout(150)
  })).lastStage, "tcp_connected");
  assert.equal((await request(base + "/body-stall", {
    signal: AbortSignal.timeout(150)
  })).lastStage, "headers_received");

  for (const status of [200, 403, 429, 500]) {
    const result = await request(base + "/" + status);
    assert.equal(result.status, status);
    assert.equal(result.lastStage, "body_received");
    assert.equal(result.hops[0].status, status);
    assert.equal(result.hops[0].peerIp, "127.0.0.1");
  }
  const redirect = await request(base + "/redirect");
  assert.deepEqual(redirect.hops.map(hop => hop.status), [302, 200]);
  assert.equal(redirect.lastStage, "body_received");

  const controller = new AbortController();
  const abort = setTimeout(() => controller.abort(), 100);
  const canceled = await request(base + "/headers-stall", { signal: controller.signal });
  clearTimeout(abort);
  assert.equal(canceled.axiosCode, "ERR_CANCELED");
  const timeout = await request(base + "/headers-stall", { timeout: 100 });
  assert.equal(timeout.axiosCode, "ECONNABORTED");
  assert.ok(["tcp_connected", "socket_reused"].includes(timeout.lastStage));
  await request(base + "/200", { httpAgent: keepAlive });
  const reused = await request(base + "/200", { httpAgent: keepAlive });
  assert.ok("socket_reused" in reused.hops[0].timingsMs);
  assert.doesNotMatch(lines.join("\n"), /secret-request|secret-response/);
});
