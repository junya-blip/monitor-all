const assert = require("node:assert/strict");
const { test } = require("node:test");
const {
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand
} = require("@aws-sdk/client-s3");
const {
  R2StateStore,
  StateStoreError,
  createStateStore
} = require("../common/state-store");

class MemoryS3 {
  objects = new Map();
  failNextPut = null;
  failNextGet = false;

  async send(command) {
    const input = command.input;
    if (command instanceof GetObjectCommand) {
      if (this.failNextGet) {
        this.failNextGet = false;
        const error = new Error("injected connection reset"); error.code = "ECONNRESET"; throw error;
      }
      if (!this.objects.has(input.Key)) {
        const error = new Error("missing"); error.name = "NoSuchKey"; throw error;
      }
      const value = this.objects.get(input.Key);
      return { Body: { transformToString: async () => value } };
    }
    if (command instanceof PutObjectCommand) {
      if (this.failNextPut && input.Key.includes(this.failNextPut)) {
        this.failNextPut = null;
        throw new Error("injected storage failure");
      }
      this.objects.set(input.Key, String(input.Body));
      return {};
    }
    if (command instanceof DeleteObjectCommand) {
      this.objects.delete(input.Key);
      return {};
    }
    throw new Error("unexpected command");
  }
}

function store(client) {
  return new R2StateStore({ client, bucket: "unit-test", logger: { warn() {} } });
}

test("R2 initializes, reloads, and rejects an initialized missing or corrupt object", async () => {
  const client = new MemoryS3();
  const state = store(client);
  assert.deepEqual(await state.read("pickup-last.json"), { initialized: false, data: null });
  const snapshot = { current: { period: "11/1", names: ["A"] }, lastNoticeTime: null };
  await state.write("pickup-last.json", undefined, snapshot, { initialize: true });
  assert.deepEqual(await state.read("pickup-last.json"), { initialized: true, data: snapshot });
  assert.equal((await state.read("pickup-last.json")).data.current.names[0], "A");

  client.objects.delete("state/pickup-last.json");
  await assert.rejects(state.read("pickup-last.json"), error => error.code === "STATE_STORE_MISSING");
  client.objects.set("state/pickup-last.json", "{");
  await assert.rejects(state.read("pickup-last.json"), error => error.code === "STATE_STORE_CORRUPT");
  client.objects.set("state/pickup-last.json", JSON.stringify(snapshot));
  client.objects.delete([...client.objects.keys()].find(key => key.startsWith("meta/initialized/")));
  await assert.rejects(state.read("pickup-last.json"), error => error.code === "STATE_STORE_MISSING");
  client.objects.set("meta/initialized/" + require("node:crypto").createHash("sha256").update("pickup-last.json").digest("hex") + ".json", JSON.stringify({ version: 1, status: "ready" }));
  client.objects.delete("meta/state-index.json");
  await assert.rejects(state.read("pickup-last.json"), error => error.code === "STATE_STORE_CORRUPT");
});

test("incomplete initialization retries silently; ready keys cannot be reinitialized", async () => {
  const client = new MemoryS3();
  const state = store(client);
  client.failNextPut = "yuuri-last.json";
  await assert.rejects(state.write("yuuri-last.json", undefined, { title: "old" }, { initialize: true }));
  assert.deepEqual(await state.read("yuuri-last.json"), { initialized: false, data: null });
  await state.write("yuuri-last.json", undefined, { title: "latest" }, { initialize: true });
  assert.equal((await state.read("yuuri-last.json")).data.title, "latest");
  await assert.rejects(
    state.write("yuuri-last.json", undefined, { title: "overwrite" }, { initialize: true }),
    error => error.code === "STATE_STORE_ALREADY_INITIALIZED"
  );
});

test("R2 authentication errors fail closed and environment config must be complete and HTTPS", async () => {
  const client = { async send() { const error = new Error("denied"); error.name = "AccessDenied"; throw error; } };
  await assert.rejects(store(client).read("bg-monitor.json"), error => error.code === "STATE_STORE_AUTH");
  assert.throws(() => createStateStore({ env: { R2_BUCKET: "b" } }), error => error.code === "STATE_STORE_CONFIG");
  assert.throws(() => createStateStore({ env: {
    R2_ENDPOINT: "http://r2.invalid", R2_BUCKET: "b", R2_ACCESS_KEY_ID: "a", R2_SECRET_ACCESS_KEY: "s"
  } }), error => error.code === "STATE_STORE_CONFIG");
});

test("R2 diagnostics only write, read and delete a unique temporary key", async () => {
  const client = new MemoryS3();
  assert.deepEqual(await store(client).verify(), { ok: true, mode: "r2" });
  assert.equal(client.objects.size, 0);
});

test("transient R2 connection errors retry", async () => {
  const client = new MemoryS3();
  client.failNextGet = true;
  assert.deepEqual(await store(client).read("pickup-last.json"), { initialized: false, data: null });
});
