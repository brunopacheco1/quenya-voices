// SPDX-FileCopyrightText: 2026 Bruno Pacheco (https://bruno.pacheco.lu)
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { Encrypted, FileBucket, OVERHEAD, S3Bucket, importKey, seal, unseal } from "../src/storage.js";

const KEY = Buffer.alloc(32, 3).toString("base64");

async function folder(t) {
  const path = await mkdtemp(join(tmpdir(), "qv-store-"));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

test("the key must be 32 bytes", async () => {
  await assert.rejects(importKey(""), /STORAGE_KEY/);
  await assert.rejects(importKey(Buffer.alloc(16).toString("base64")), /STORAGE_KEY/);
});

test("sealed bytes open with the same key only, and any change is detected", async () => {
  const key = await importKey(KEY);
  const sealed = await seal(key, new TextEncoder().encode("Elen síla"));
  assert.equal(sealed.byteLength, OVERHEAD + new TextEncoder().encode("Elen síla").byteLength);
  assert.equal(new TextDecoder().decode(await unseal(key, sealed)), "Elen síla");
  const other = await importKey(Buffer.alloc(32, 4).toString("base64"));
  await assert.rejects(unseal(other, sealed));
  sealed[sealed.length - 1] ^= 1;
  await assert.rejects(unseal(key, sealed));
});

test("what reaches the storage is encrypted, data and metadata", async (t) => {
  const path = await folder(t);
  const bucket = new Encrypted(new FileBucket(path), await importKey(KEY));
  await bucket.put("volunteers/0123456789abcdef/consent.json", '{"email":"ana@example.org"}',
    { customMetadata: { name: "Ána" } });
  const onDisk = await readFile(join(path, "volunteers", "0123456789abcdef", "consent.json"));
  assert.ok(!onDisk.includes("ana@example.org"));
  assert.ok(!(await readFile(join(path, ".meta", "volunteers", "0123456789abcdef", "consent.json"), "utf8")).includes("Ána"));

  const object = await bucket.get("volunteers/0123456789abcdef/consent.json");
  assert.equal((await object.json()).email, "ana@example.org");
  assert.deepEqual(object.customMetadata, { name: "Ána" });
  const { objects } = await bucket.list({ prefix: "volunteers/", include: ["customMetadata"] });
  assert.deepEqual(objects, [{ key: "volunteers/0123456789abcdef/consent.json", size: 27, customMetadata: { name: "Ána" } }]);
  await bucket.delete(["volunteers/0123456789abcdef/consent.json"]);
  assert.equal(await bucket.get("volunteers/0123456789abcdef/consent.json"), null);
});

test("the folder bucket refuses keys that leave its folder", async (t) => {
  const bucket = new FileBucket(await folder(t));
  await assert.rejects(bucket.put("../outside", "x"), /bad key/);
});

test("S3: signed requests, metadata headers, paged listings", async () => {
  const requests = [];
  const objects = new Map();
  const fakeFetch = async (request) => {
    requests.push(request);
    const url = new URL(request.url);
    const key = decodeURIComponent(url.pathname.replace(/^\/quenya-recordings\/?/, ""));
    if (request.method === "PUT") {
      const meta = [...request.headers].filter(([name]) => name.startsWith("x-amz-meta-"));
      objects.set(key, { body: new Uint8Array(await request.arrayBuffer()), meta });
      return new Response(null, { status: 200 });
    }
    if (request.method === "HEAD" || (request.method === "GET" && key)) {
      const object = objects.get(key);
      if (!object) return new Response(null, { status: 404 });
      return new Response(request.method === "HEAD" ? null : object.body, { headers: object.meta });
    }
    if (request.method === "DELETE") {
      objects.delete(key);
      return new Response(null, { status: 204 });
    }
    // ListObjectsV2, one key per page
    const all = [...objects.keys()].filter((k) => k.startsWith(url.searchParams.get("prefix"))).sort();
    const start = Number(url.searchParams.get("continuation-token") || 0);
    const more = start + 1 < all.length;
    return new Response(`<?xml version="1.0"?><ListBucketResult>${all.slice(start, start + 1)
      .map((k) => `<Contents><Key>${k.replace(/&/g, "&amp;")}</Key><Size>${objects.get(k).body.length}</Size></Contents>`).join("")}`
      + `<IsTruncated>${more}</IsTruncated>${more ? `<NextContinuationToken>${start + 1}</NextContinuationToken>` : ""}</ListBucketResult>`);
  };
  const bucket = new S3Bucket({
    endpoint: "https://luxembourg-2.storage.gcore.dev/", region: "s-ed1", bucket: "quenya-recordings",
    accessKeyId: "id", secretAccessKey: "secret",
  }, fakeFetch);

  await bucket.put("queue/a&b/r1", "x", { customMetadata: { submitted_at: "2026-10-18" } });
  await bucket.put("queue/c/two", "yy");
  assert.equal(requests[0].url, "https://luxembourg-2.storage.gcore.dev/quenya-recordings/queue/a%26b/r1");
  assert.match(requests[0].headers.get("authorization"), /^AWS4-HMAC-SHA256 Credential=id\/\d{8}\/s-ed1\/s3\/aws4_request/);
  assert.equal(requests[0].headers.get("x-amz-meta-submitted_at"), "2026-10-18");

  const first = await new S3Bucket({ endpoint: "https://luxembourg-2.storage.gcore.dev", region: "s-ed1",
    bucket: "quenya-recordings", accessKeyId: "id", secretAccessKey: "secret" }, fakeFetch)
    .list({ prefix: "queue/", include: ["customMetadata"] });
  assert.deepEqual(first.objects, [{ key: "queue/a&b/r1", size: 1, customMetadata: { submitted_at: "2026-10-18" } }]);
  assert.equal(first.truncated, true);
  const second = await bucket.list({ prefix: "queue/", cursor: first.cursor });
  assert.deepEqual(second.objects, [{ key: "queue/c/two", size: 2 }]);

  assert.equal(await (await bucket.get("queue/c/two")).text(), "yy");
  assert.equal(await bucket.get("queue/none"), null);
  await bucket.delete("queue/c/two");
  assert.equal(objects.has("queue/c/two"), false);
});
