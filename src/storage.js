// SPDX-FileCopyrightText: 2026 Bruno Pacheco (https://bruno.pacheco.lu)
// SPDX-License-Identifier: Apache-2.0

// Where the site keeps everything: an S3 bucket (Gcore object storage in Luxembourg), or a folder for local
// development. Both offer the small interface the API uses:
//   get(key)                                -> {key, size, body, customMetadata, json(), text()} or null
//   put(key, bytes | string, {customMetadata})
//   delete(key | [keys])
//   list({prefix, cursor, include})         -> {objects: [{key, size, customMetadata?}], truncated, cursor}
// Encrypted wraps either one: every object, and its metadata, is encrypted with AES-256-GCM before it leaves the
// server, with a key only the server and the training script have (STORAGE_KEY). The storage provider sees only
// the object names, which hold no e-mail addresses (see worker.js).

import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { AwsClient } from "aws4fetch";

const toBytes = (value) => typeof value === "string" ? new TextEncoder().encode(value) : new Uint8Array(value);

function stored(key, bytes, customMetadata) {
  return {
    key,
    size: bytes.byteLength,
    body: bytes,
    customMetadata,
    text: async () => new TextDecoder().decode(bytes),
    json: async () => JSON.parse(new TextDecoder().decode(bytes)),
  };
}

// Runs fn over items, at most limit at a time.
async function mapLimited(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return results;
}

const xmlValues = (xml, tag) => [...xml.matchAll(new RegExp(`<${tag}>([^<]*)</${tag}>`, "g"))].map((m) => m[1]);
const xmlText = (text) => text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
  .replace(/&apos;/g, "'").replace(/&amp;/g, "&");

// An S3 bucket, with path-style addressing. Metadata travels as x-amz-meta-* headers; S3 listings do not return
// it, so list({include: ["customMetadata"]}) fetches it with HEAD requests and keeps it in memory: this server is
// the only one writing metadata, so what it wrote or read stays true.
export class S3Bucket {
  constructor({ endpoint, region, bucket, accessKeyId, secretAccessKey }, fetchImpl = fetch) {
    this.base = `${endpoint.replace(/\/$/, "")}/${bucket}`;
    this.client = new AwsClient({ accessKeyId, secretAccessKey, region, service: "s3" });
    this.fetchImpl = fetchImpl;
    this.metadata = new Map();
  }

  url(key, query = "") {
    return `${this.base}/${key.split("/").map(encodeURIComponent).join("/")}${query}`;
  }

  async request(url, init = {}) {
    const response = await this.fetchImpl(await this.client.sign(url, init));
    if (!response.ok && response.status !== 404) {
      throw new Error(`storage: ${init.method || "GET"} failed with HTTP ${response.status}`);
    }
    return response;
  }

  static metadataOf(headers) {
    const meta = {};
    for (const [name, value] of headers) {
      if (name.toLowerCase().startsWith("x-amz-meta-")) meta[name.slice(11).toLowerCase()] = value;
    }
    return meta;
  }

  async get(key) {
    const response = await this.request(this.url(key));
    if (response.status === 404) return null;
    const customMetadata = S3Bucket.metadataOf(response.headers);
    this.metadata.set(key, customMetadata);
    return stored(key, new Uint8Array(await response.arrayBuffer()), customMetadata);
  }

  async put(key, value, { customMetadata = {} } = {}) {
    const headers = { "Content-Type": "application/octet-stream" };
    for (const [name, meta] of Object.entries(customMetadata)) headers[`x-amz-meta-${name.toLowerCase()}`] = meta;
    await this.request(this.url(key), { method: "PUT", headers, body: toBytes(value) });
    this.metadata.set(key, { ...customMetadata });
  }

  async delete(keys) {
    await mapLimited([keys].flat(), 16, async (key) => {
      await this.request(this.url(key), { method: "DELETE" });
      this.metadata.delete(key);
    });
  }

  async head(key) {
    if (!this.metadata.has(key)) {
      const response = await this.request(this.url(key), { method: "HEAD" });
      if (response.status === 404) return undefined;
      this.metadata.set(key, S3Bucket.metadataOf(response.headers));
    }
    return this.metadata.get(key);
  }

  async list({ prefix = "", cursor, include = [] } = {}) {
    const params = new URLSearchParams({ "list-type": "2", prefix });
    if (cursor) params.set("continuation-token", cursor);
    const xml = await (await this.request(`${this.base}?${params}`)).text();
    const keys = xmlValues(xml, "Key").map(xmlText);
    const sizes = xmlValues(xml, "Size").map(Number);
    const truncated = xmlValues(xml, "IsTruncated")[0] === "true";
    const objects = keys.map((key, i) => ({ key, size: sizes[i] }));
    if (include.includes("customMetadata")) {
      await mapLimited(objects, 16, async (object) => { object.customMetadata = await this.head(object.key); });
    }
    return { objects, truncated, cursor: truncated ? xmlText(xmlValues(xml, "NextContinuationToken")[0]) : undefined };
  }
}

// A folder on disk, for local development (npm run dev): <folder>/<key>, with metadata in <folder>/.meta/<key>.
export class FileBucket {
  constructor(folder) {
    this.folder = folder;
  }

  path(key, meta = false) {
    if (key.split("/").some((part) => part === ".." || part === "")) throw new Error(`bad key: ${key}`);
    return join(this.folder, ...(meta ? [".meta"] : []), ...key.split("/"));
  }

  async get(key) {
    try {
      const bytes = new Uint8Array(await readFile(this.path(key)));
      const meta = JSON.parse(await readFile(this.path(key, true), "utf8").catch(() => "{}"));
      return stored(key, bytes, meta);
    } catch (err) {
      if (err.code === "ENOENT") return null;
      throw err;
    }
  }

  async put(key, value, { customMetadata = {} } = {}) {
    for (const [path, data] of [[this.path(key), toBytes(value)], [this.path(key, true), JSON.stringify(customMetadata)]]) {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, data);
    }
  }

  async delete(keys) {
    for (const key of [keys].flat()) {
      await rm(this.path(key), { force: true });
      await rm(this.path(key, true), { force: true });
    }
  }

  async list({ prefix = "", include = [] } = {}) {
    const entries = await readdir(this.folder, { recursive: true, withFileTypes: true }).catch(() => []);
    const keys = entries.filter((entry) => entry.isFile())
      .map((entry) => relative(this.folder, join(entry.parentPath, entry.name)).split(sep).join("/"))
      .filter((key) => !key.startsWith(".meta/") && key.startsWith(prefix)).sort();
    const objects = await Promise.all(keys.map(async (key) => {
      const object = await this.get(key);
      return { key, size: object.size, ...(include.includes("customMetadata") ? { customMetadata: object.customMetadata } : {}) };
    }));
    return { objects, truncated: false };
  }
}

// Format of an encrypted object: "QVE1", a 12-byte random IV, then the AES-256-GCM ciphertext with its 16-byte tag.
// Metadata is sealed the same way into one base64 value. quenya_tts/volunteers.py reads the same format.
const MAGIC = new TextEncoder().encode("QVE1");
export const OVERHEAD = MAGIC.length + 12 + 16;

export async function importKey(base64) {
  const raw = Uint8Array.from(Buffer.from(base64 || "", "base64"));
  if (raw.byteLength !== 32) throw new Error("STORAGE_KEY must be 32 random bytes, base64-encoded (openssl rand -base64 32)");
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function seal(key, bytes) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, bytes));
  const out = new Uint8Array(OVERHEAD - 16 + ciphertext.byteLength);
  out.set(MAGIC);
  out.set(iv, MAGIC.length);
  out.set(ciphertext, MAGIC.length + 12);
  return out;
}

export async function unseal(key, bytes) {
  if (bytes.byteLength < OVERHEAD || MAGIC.some((byte, i) => bytes[i] !== byte)) throw new Error("not an encrypted object");
  const iv = bytes.subarray(MAGIC.length, MAGIC.length + 12);
  return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, bytes.subarray(MAGIC.length + 12)));
}

export class Encrypted {
  constructor(inner, key) {
    this.inner = inner;
    this.key = key;
  }

  async openMetadata(meta) {
    if (!meta?.sealed) return {};
    return JSON.parse(new TextDecoder().decode(await unseal(this.key, Buffer.from(meta.sealed, "base64"))));
  }

  async get(key) {
    const object = await this.inner.get(key);
    if (!object) return null;
    return stored(key, await unseal(this.key, object.body), await this.openMetadata(object.customMetadata));
  }

  async put(key, value, { customMetadata = {} } = {}) {
    const sealed = Buffer.from(await seal(this.key, toBytes(JSON.stringify(customMetadata)))).toString("base64");
    await this.inner.put(key, await seal(this.key, toBytes(value)), { customMetadata: { sealed } });
  }

  delete(keys) {
    return this.inner.delete(keys);
  }

  async list(options = {}) {
    const page = await this.inner.list(options);
    const objects = await Promise.all(page.objects.map(async (object) => ({
      key: object.key,
      size: object.size - OVERHEAD,
      ...("customMetadata" in object ? { customMetadata: await this.openMetadata(object.customMetadata) } : {}),
    })));
    return { ...page, objects };
  }
}

// The bucket from the environment: Gcore object storage when STORAGE_ENDPOINT is set, otherwise a local folder
// (STORAGE_DIR, default .data/). Always encrypted with STORAGE_KEY.
export async function bucketFromEnvironment(env) {
  const inner = env.STORAGE_ENDPOINT
    ? new S3Bucket({
      endpoint: env.STORAGE_ENDPOINT,
      region: env.STORAGE_REGION,
      bucket: env.STORAGE_BUCKET || "quenya-recordings",
      accessKeyId: env.STORAGE_ACCESS_KEY_ID,
      secretAccessKey: env.STORAGE_SECRET_ACCESS_KEY,
    })
    : new FileBucket(env.STORAGE_DIR || ".data");
  return new Encrypted(inner, await importKey(env.STORAGE_KEY));
}
