const assert = require("node:assert/strict");
const { spawn, execFile } = require("node:child_process");
const fs = require("node:fs/promises");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { setTimeout: delay } = require("node:timers/promises");
const { promisify } = require("node:util");
const { getJSTDate } = require("../common/time");

const root = path.resolve(__dirname, "..");
const launch = String.raw`
const net = require("node:net");
const listen = net.Server.prototype.listen;
net.Server.prototype.listen = function (port, ...rest) {
  if (port !== 10000) return listen.call(this, port, ...rest);
  this.once("listening", () => console.log("TEST PORT " + this.address().port));
  return listen.call(this, 0, "127.0.0.1");
};
const axios = require("axios");
const get = axios.get.bind(axios), post = axios.post.bind(axios);
axios.get = (url, options) => get(process.env.MOCK_ORIGIN + new URL(url).pathname, { ...options, proxy: false });
axios.post = (_, data, options) => post(process.env.MOCK_ORIGIN + "/notice", data, { ...options, proxy: false });
const timeout = AbortSignal.timeout;
// Shorten only the run deadline in the deadline-specific isolated instance.
if (process.env.TEST_RUN_DEADLINE) {
  AbortSignal.timeout = ms => timeout(ms === 50000 ? Number(process.env.TEST_RUN_DEADLINE) : ms);
}
require("./server");
`;

const date = getJSTDate();
const jstDay = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
const days = Array.from({ length: 8 }, (_, i) => {
  const d = new Date(jstDay + 86_400_000 * i);
  return `/schedule/${d.getUTCFullYear()}/${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
});
const hits = '<table><tr><td><h4>対象</h4>キャンセル発生</td><td><h4>対象外</h4><img alt="急遽出勤"></td></tr></table>';
const empty = "<table><tr><td>通常出勤</td></tr></table>";

async function until(condition) {
  const deadline = Date.now() + 3000;
  while (!condition()) {
    assert.ok(Date.now() < deadline, "timed out waiting for mock event");
    await delay(10);
  }
}

async function fixture(t, runDeadline) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "monitor-bg-test-"));
  const state = { visits: [], notices: [], replies: {}, active: 0, peak: 0 };
  const upstream = http.createServer(async (req, res) => {
    if (req.url === "/notice") {
      let body = "";
      for await (const chunk of req) body += chunk;
      state.notices.push(JSON.parse(body).messages[0].text);
      await delay(state.noticeDelay || 0);
      if (!res.destroyed) res.writeHead(state.noticeStatus || 200).end();
      return;
    }
    state.visits.push(req.url);
    state.peak = Math.max(state.peak, ++state.active);
    res.once("close", () => state.active--);
    const reply = state.replies[req.url];
    if (reply === "hang") return;
    await delay(20);
    res.writeHead(reply || 200).end(req.url === days[0] ? hits : empty);
  });
  let child;
  t.after(async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      await new Promise(resolve => { child.once("exit", resolve); child.kill(); });
    }
    upstream.closeAllConnections();
    await new Promise(resolve => upstream.close(resolve));
    await fs.rm(temp, { recursive: true, force: true });
  });
  await new Promise(resolve => upstream.listen(0, "127.0.0.1", resolve));
  for (const file of [
    "bg-monitor.js", "server.js", "scripts/run-cron.js", "common/bg-http-trace.js",
    "common/notifier.js", "common/time.js"
  ]) {
    const destination = path.join(temp, file);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.copyFile(path.join(root, file), destination);
  }
  for (const monitor of ["pickup", "heaven", "yuuri"]) {
    await fs.writeFile(path.join(temp, monitor + "-monitor.js"), "module.exports = async () => {};");
  }
  await fs.mkdir(path.join(temp, "data"));
  await fs.writeFile(path.join(temp, "config.json"), JSON.stringify({
    castFilterEnabled: false, castNames: []
  }));
  const last = path.join(temp, "data/bg-last.json");
  const history = path.join(temp, "data/bg-lastNotice.json");
  await fs.writeFile(last, "[]");
  await fs.writeFile(history, '{"notices":["previous"],"lastNoticeTime":"previous"}');
  await fs.writeFile(path.join(temp, "mock.cjs"), launch);
  let logs = "";
  child = spawn(process.execPath, ["mock.cjs"], {
    cwd: temp,
    env: {
      ...process.env,
      NODE_PATH: path.join(root, "node_modules"),
      MOCK_ORIGIN: `http://127.0.0.1:${upstream.address().port}`,
      NOTIFY_MODE: "line",
      LINE_TOKEN: "fake", LINE_USER_ID: "fake",
      TEST_RUN_DEADLINE: runDeadline ? String(runDeadline) : ""
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stdout.on("data", chunk => logs += chunk);
  child.stderr.on("data", chunk => logs += chunk);
  await until(() => /TEST PORT \d+/.test(logs));
  const base = "http://127.0.0.1:" + logs.match(/TEST PORT (\d+)/)[1];
  return {
    state,
    logs: () => logs,
    config: config => fs.writeFile(path.join(temp, "config.json"), JSON.stringify(config)),
    snapshot: async () => Promise.all([last, history].map(file => fs.readFile(file, "utf8"))),
    request: options => fetch(base + "/run-bg", options),
    runner: async () => {
      try {
        const { stdout, stderr } = await promisify(execFile)(process.execPath, ["scripts/run-cron.js"], {
          cwd: temp, timeout: 65_000,
          env: { ...process.env, MONITOR_BASE_URL: base, MONITOR_REQUEST_TIMEOUT_MS: "60000" }
        });
        return { code: 0, output: stdout + stderr };
      } catch (err) {
        return { code: err.code, output: err.stdout + err.stderr };
      }
    }
  };
}

test("success, filter, persistence, runner failure and client cancellation", async t => {
  const app = await fixture(t);
  await app.config({ castFilterEnabled: true, castNames: ["対象外"] });
  app.state.noticeStatus = 500;
  const initial = await app.snapshot();
  assert.equal((await app.request()).status, 500);
  assert.deepEqual(await app.snapshot(), initial);
  app.state.noticeStatus = 200;
  app.state.notices.length = 0;
  app.state.visits.length = 0;

  const success = await app.runner();
  assert.equal(success.code, 0);
  assert.match(success.output, /successes=4 failures=0/);
  assert.deepEqual([...app.state.visits].sort(), [...days].sort());
  assert.equal(app.state.peak, 3);
  assert.equal(app.state.notices.length, 1);
  assert.match(app.state.notices[0], /対象外/);
  const baseline = await app.snapshot();
  assert.deepEqual(JSON.parse(baseline[0]).map(hit => hit.keyword), ["キャンセル発生", "急遽出勤"]);
  assert.equal(JSON.parse(baseline[1]).notices.length, 2);
  assert.equal((await app.request()).status, 200);
  assert.equal(app.state.notices.length, 1);
  assert.deepEqual(await app.snapshot(), baseline);

  for (const [i, status] of [403, 429, 500].entries()) app.state.replies[days[i + 1]] = status;
  const failure = await app.runner();
  assert.equal(failure.code, 1);
  assert.match(failure.output, /FAIL \/run-bg .*HTTP 502/);
  assert.match(failure.output, /SUCCESS \/run-heaven/);
  assert.match(failure.output, /SUCCESS \/run-yuuri/);
  assert.deepEqual(await app.snapshot(), baseline);

  app.state.replies = Object.fromEntries(days.map(day => [day, "hang"]));
  const before = app.state.visits.length;
  const controller = new AbortController();
  const pending = app.request({ signal: controller.signal });
  await until(() => app.state.visits.length === before + 3);
  assert.equal((await app.request()).status, 409);
  const canceled = assert.rejects(pending, { name: "AbortError" });
  controller.abort();
  await canceled;
  await until(() => app.state.active === 0 && app.logs().includes('"result":"AbortError"'));
  assert.equal(app.state.visits.length, before + 3);
  assert.deepEqual(await app.snapshot(), baseline);
  assert.equal(app.state.notices.length, 1);
});

test("all upstream requests time out under the unchanged runner limit", async t => {
  const app = await fixture(t);
  const initial = await app.snapshot();
  app.state.replies = Object.fromEntries(days.map(day => [day, "hang"]));
  const start = Date.now();
  const result = await app.runner();
  const elapsed = Date.now() - start;
  assert.equal(result.code, 1);
  assert.match(result.output, /FAIL \/run-bg .*HTTP 502/);
  assert.match(result.output, /successes=3 failures=1/);
  assert.ok(elapsed >= 35_000 && elapsed < 48_000, `elapsed=${elapsed}`);
  assert.equal(app.state.visits.length, 8);
  assert.equal(app.state.notices.length, 0);
  assert.deepEqual(await app.snapshot(), initial);
});

test("run deadline returns 504 and leaves both files intact", async t => {
  const app = await fixture(t, 400);
  const initial = await app.snapshot();
  app.state.replies = Object.fromEntries(days.map(day => [day, "hang"]));
  const response = await app.request();
  assert.equal(response.status, 504);
  assert.match(await response.text(), /bg-monitor failed/);
  assert.equal(app.state.visits.length, 3);
  assert.equal(app.state.notices.length, 0);
  assert.deepEqual(await app.snapshot(), initial);
});
