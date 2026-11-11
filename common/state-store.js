const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { NodeHttpHandler } = require("@smithy/node-http-handler");
const {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand
} = require("@aws-sdk/client-s3");

const REQUIRED_ENV = [
  "R2_ENDPOINT",
  "R2_BUCKET",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY"
];
const RETRIES = 3;
const REQUEST_TIMEOUT_MS = 8_000;
const INDEX_KEY = "meta/state-index.json";

class StateStoreError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = "StateStoreError";
    this.code = code;
    this.stateStoreError = true;
  }
}

function classify(error) {
  const names = [error?.name, error?.Code, error?.code].filter(Boolean);
  if (names.some(name => ["NoSuchKey", "NotFound"].includes(name)) || error?.$metadata?.httpStatusCode === 404) return "NOT_FOUND";
  if (names.includes("NoSuchBucket")) return "CONFIG";
  if (names.some(name => ["AccessDenied", "InvalidAccessKeyId", "SignatureDoesNotMatch", "AuthorizationHeaderMalformed"].includes(name)) || error?.$metadata?.httpStatusCode === 403) return "AUTH";
  if (names.some(name => ["AbortError", "TimeoutError", "RequestTimeout", "NetworkingError", "ETIMEDOUT", "ECONNRESET", "ENOTFOUND", "EAI_AGAIN"].includes(name))) return "NETWORK";
  if (error?.$metadata?.httpStatusCode >= 500 || error?.$retryable) return "TRANSIENT";
  return "UNKNOWN";
}

function safeError(error) {
  const code = classify(error);
  return new StateStoreError(`STATE_STORE_${code}`, `State store ${code.toLowerCase()}`, { cause: error });
}

async function withRetry(operation, label, logger = console) {
  let last;
  for (let attempt = 1; attempt <= RETRIES; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      last = error;
      const kind = classify(error);
      if (["AUTH", "CONFIG", "UNKNOWN", "NOT_FOUND"].includes(kind) || attempt === RETRIES) break;
      logger.warn?.(`R2 ${label} retry ${attempt}/${RETRIES - 1} (${kind.toLowerCase()})`);
      await new Promise(resolve => setTimeout(resolve, 100 * 2 ** (attempt - 1)));
    }
  }
  throw safeError(last);
}

function objectKey(key) {
  if (typeof key !== "string" || !/^[a-z0-9][a-z0-9/_-]*\.json$/i.test(key) || key.includes("..")) {
    throw new TypeError("Invalid state key");
  }
  return `state/${key}`;
}

function markerKey(key) {
  const { createHash } = require("node:crypto");
  return `meta/initialized/${createHash("sha256").update(key).digest("hex")}.json`;
}

function heavenStateKey(castName) {
  return `heaven-${Buffer.from(String(castName), "utf8").toString("hex")}.json`;
}

async function bodyToString(body) {
  if (typeof body?.transformToString === "function") return body.transformToString("utf-8");
  const chunks = [];
  for await (const chunk of body) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

class LocalStateStore {
  get mode() { return "local"; }

  async read(key, filePath) {
    try {
      const text = await fs.readFile(filePath, "utf8");
      let data;
      try { data = JSON.parse(text); }
      catch (cause) { throw new StateStoreError("STATE_STORE_CORRUPT", `Local state JSON is invalid for ${key}`, { cause }); }
      return { initialized: true, data };
    } catch (error) {
      if (error.code === "ENOENT") return { initialized: false, data: null };
      throw error;
    }
  }

  async write(key, filePath, data) {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const temporary = `${filePath}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`, { flag: "wx" });
      await fs.rename(temporary, filePath);
    } catch (error) {
      await fs.rm(temporary, { force: true }).catch(() => {});
      throw error;
    }
  }

  async verify() { return { ok: true, mode: "local" }; }
}

class R2StateStore {
  constructor({ client, bucket, env = process.env, logger = console } = {}) {
    this.env = env;
    this.bucket = bucket || process.env.R2_BUCKET;
    this.logger = logger;
    this.indexWrite = Promise.resolve();
    if (!this.bucket) throw new StateStoreError("STATE_STORE_CONFIG", "R2 bucket is not configured");
    this.client = client || new S3Client({
      region: "auto",
      endpoint: env.R2_ENDPOINT,
      credentials: {
        accessKeyId: env.R2_ACCESS_KEY_ID,
        secretAccessKey: env.R2_SECRET_ACCESS_KEY
      },
      maxAttempts: 1,
      requestHandler: new NodeHttpHandler({
        connectionTimeout: REQUEST_TIMEOUT_MS,
        requestTimeout: REQUEST_TIMEOUT_MS,
        socketTimeout: REQUEST_TIMEOUT_MS
      })
    });
  }

  get mode() { return "r2"; }

  async getText(key) {
    return withRetry(async () => {
      const response = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }), {
        abortSignal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      });
      return bodyToString(response.Body);
    }, "read", this.logger);
  }

  async putText(key, text, contentType = "application/json") {
    return withRetry(() => this.client.send(new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      Body: text,
      ContentType: contentType
    }), { abortSignal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }), "write", this.logger);
  }

  async exists(key) {
    try {
      await this.getText(key);
      return true;
    } catch (error) {
      if (error.code === "STATE_STORE_NOT_FOUND") return false;
      throw error;
    }
  }

  async readIndex() {
    try {
      const raw = await this.getText(INDEX_KEY);
      const index = JSON.parse(raw);
      if (index?.version !== 1 || !Array.isArray(index.initializedKeys) ||
          !index.initializedKeys.every(key => typeof key === "string")) {
        throw new StateStoreError("STATE_STORE_CORRUPT", "R2 state index has an invalid schema");
      }
      return index;
    } catch (error) {
      if (error.code === "STATE_STORE_NOT_FOUND") return null;
      if (error instanceof SyntaxError) throw new StateStoreError("STATE_STORE_CORRUPT", "R2 state index JSON is invalid", { cause: error });
      throw error;
    }
  }

  async addInitializedKey(key) {
    let release;
    const previous = this.indexWrite;
    this.indexWrite = new Promise(resolve => { release = resolve; });
    await previous;
    try {
      const index = await this.readIndex() || { version: 1, initializedKeys: [] };
      if (!index.initializedKeys.includes(key)) index.initializedKeys.push(key);
      await this.putText(INDEX_KEY, JSON.stringify(index));
    } finally {
      release();
    }
  }

  async read(key) {
    const stateKey = objectKey(key);
    const marker = markerKey(key);
    const index = await this.readIndex();
    let markerText;
    try { markerText = await this.getText(marker); }
    catch (error) {
      if (error.code === "STATE_STORE_NOT_FOUND") {
        if (index?.initializedKeys.includes(key)) {
          throw new StateStoreError("STATE_STORE_MISSING", `Initialized state marker is missing: ${key}`, { cause: error });
        }
        try { await this.getText(stateKey); }
        catch (stateError) {
          if (stateError.code === "STATE_STORE_NOT_FOUND") return { initialized: false, data: null };
          throw stateError;
        }
        throw new StateStoreError("STATE_STORE_MISSING", `State exists without an initialization marker: ${key}`);
      }
      throw error;
    }
    let markerData;
    try { markerData = JSON.parse(markerText); }
    catch (cause) { throw new StateStoreError("STATE_STORE_CORRUPT", `R2 state marker is invalid: ${key}`, { cause }); }
    if (markerData?.version !== 1 || !["initializing", "ready"].includes(markerData.status)) {
      throw new StateStoreError("STATE_STORE_CORRUPT", `R2 state marker has an invalid status: ${key}`);
    }
    if (markerData.status === "initializing") {
      if (!index?.initializedKeys.includes(key)) return { initialized: false, data: null };
      let raw;
      try { raw = await this.getText(stateKey); }
      catch (error) {
        if (error.code === "STATE_STORE_NOT_FOUND") throw new StateStoreError("STATE_STORE_MISSING", `Indexed state object is missing: ${key}`, { cause: error });
        throw error;
      }
      try { markerData = JSON.parse(markerText); }
      catch (cause) { throw new StateStoreError("STATE_STORE_CORRUPT", `R2 state marker is invalid: ${key}`, { cause }); }
      await this.putText(marker, JSON.stringify({ version: 1, status: "ready" }));
      try { return { initialized: true, data: JSON.parse(raw) }; }
      catch (cause) { throw new StateStoreError("STATE_STORE_CORRUPT", `R2 state JSON is invalid: ${key}`, { cause }); }
    }
    if (!index || !index.initializedKeys.includes(key)) {
      throw new StateStoreError("STATE_STORE_CORRUPT", `R2 state index is missing an initialized key: ${key}`);
    }

    let raw;
    try { raw = await this.getText(stateKey); }
    catch (error) {
      if (error.code === "STATE_STORE_NOT_FOUND") {
        throw new StateStoreError("STATE_STORE_MISSING", `Initialized state is missing: ${key}`, { cause: error });
      }
      throw error;
    }
    try {
      return { initialized: true, data: JSON.parse(raw) };
    } catch (cause) {
      throw new StateStoreError("STATE_STORE_CORRUPT", `R2 state JSON is invalid: ${key}`, { cause });
    }
  }

  async write(key, _filePath, data, { initialize = false } = {}) {
    const stateKey = objectKey(key);
    const marker = markerKey(key);
    if (initialize) {
      const index = await this.readIndex();
      let markerData = null;
      try { markerData = JSON.parse(await this.getText(marker)); }
      catch (error) { if (error.code !== "STATE_STORE_NOT_FOUND") throw error; }
      if (markerData?.status === "ready") {
        throw new StateStoreError("STATE_STORE_ALREADY_INITIALIZED", `State is already initialized: ${key}`);
      }
      if (markerData && (markerData.version !== 1 || markerData.status !== "initializing")) {
        throw new StateStoreError("STATE_STORE_CORRUPT", `R2 state marker has an invalid status: ${key}`);
      }
      if (!markerData && index?.initializedKeys.includes(key)) {
        throw new StateStoreError("STATE_STORE_MISSING", `Initialized state marker is missing: ${key}`);
      }
      // The in-progress marker makes an interrupted bootstrap retryable. Only
      // status=ready turns later object disappearance into a hard failure.
      if (!markerData) {
        let stateExists = false;
        try { await this.getText(stateKey); stateExists = true; }
        catch (error) {
          if (error.code !== "STATE_STORE_NOT_FOUND") throw error;
        }
        if (stateExists) throw new StateStoreError("STATE_STORE_MISSING", `State exists without an initialization marker: ${key}`);
        await this.putText(marker, JSON.stringify({ version: 1, status: "initializing" }));
      }
      await this.putText(stateKey, `${JSON.stringify(data, null, 2)}\n`);
      await this.addInitializedKey(key);
      await this.putText(marker, JSON.stringify({ version: 1, status: "ready" }));
      return;
    }
    let status;
    try { status = JSON.parse(await this.getText(marker)); }
    catch (error) {
      if (error.code === "STATE_STORE_NOT_FOUND") throw new StateStoreError("STATE_STORE_UNINITIALIZED", `State is not initialized: ${key}`, { cause: error });
      throw error;
    }
    if (status?.version !== 1 || status?.status !== "ready") {
      throw new StateStoreError("STATE_STORE_UNINITIALIZED", `State is not ready: ${key}`);
    }
    const index = await this.readIndex();
    if (!index?.initializedKeys.includes(key)) {
      throw new StateStoreError("STATE_STORE_CORRUPT", `R2 state index is missing an initialized key: ${key}`);
    }
    await this.putText(stateKey, `${JSON.stringify(data, null, 2)}\n`);
  }

  async verify() {
    const key = `diagnostics/r2-check-${randomUUID()}.json`;
    const expected = JSON.stringify({ ok: true, timestamp: new Date().toISOString() });
    try {
      await this.putText(key, expected);
      const actual = await this.getText(key);
      if (actual !== expected) throw new StateStoreError("STATE_STORE_VERIFY", "R2 test object did not match");
      await withRetry(() => this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }), {
        abortSignal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      }), "delete-test", this.logger);
      return { ok: true, mode: "r2" };
    } catch (error) {
      // Best effort cleanup only for this random diagnostic key.
      try { await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key })); } catch {}
      throw error;
    }
  }
}

function createStateStore({ env = process.env, client, logger = console } = {}) {
  const configured = REQUIRED_ENV.filter(name => typeof env[name] === "string" && env[name].length > 0);
  if (!configured.length) return new LocalStateStore();
  if (configured.length !== REQUIRED_ENV.length) {
    throw new StateStoreError("STATE_STORE_CONFIG", `R2 configuration is incomplete (${configured.length}/${REQUIRED_ENV.length} values present)`);
  }
  try {
    const endpoint = new URL(env.R2_ENDPOINT);
    if (endpoint.protocol !== "https:" || !/^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.r2\.cloudflarestorage\.com$/i.test(endpoint.hostname) ||
        endpoint.username || endpoint.password || endpoint.search || endpoint.hash || !["", "/"].includes(endpoint.pathname)) {
      throw new Error("invalid Cloudflare R2 endpoint");
    }
  } catch (cause) {
    throw new StateStoreError("STATE_STORE_CONFIG", "R2 endpoint is invalid", { cause });
  }
  return new R2StateStore({ client, bucket: env.R2_BUCKET, env, logger });
}

let defaultStore;
function getStateStore() {
  if (!defaultStore) defaultStore = createStateStore();
  return defaultStore;
}
function setStateStoreForTests(store) { defaultStore = store; }
function readState(key, filePath) { return getStateStore().read(key, filePath); }
function writeState(key, filePath, data, options) { return getStateStore().write(key, filePath, data, options); }

module.exports = {
  StateStoreError,
  LocalStateStore,
  R2StateStore,
  createStateStore,
  getStateStore,
  setStateStoreForTests,
  readState,
  writeState,
  classify,
  heavenStateKey
};
