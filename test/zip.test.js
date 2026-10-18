// SPDX-FileCopyrightText: 2026 Bruno Pacheco (https://bruno.pacheco.lu)
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { crc32, zip } from "../public/lib/zip.js";

test("crc32 matches the standard check value", () => {
  assert.equal(crc32(new TextEncoder().encode("123456789")), 0xcbf43926);
});

test("writes an archive Python's zipfile reads back", async () => {
  const dir = mkdtempSync(join(tmpdir(), "zip-test-"));
  const path = join(dir, "test.zip");
  const blob = zip([
    { name: "s01/s01_001.wav", bytes: new Uint8Array([1, 2, 3]) },
    { name: "my-data.json", bytes: new TextEncoder().encode('{"ä": 1}') },
  ]);
  writeFileSync(path, new Uint8Array(await blob.arrayBuffer()));
  const listing = execFileSync("python3", ["-c",
    "import sys, zipfile; z = zipfile.ZipFile(sys.argv[1]); z.testzip(); print([(i.filename, z.read(i).hex()) for i in z.infolist()])",
    path]).toString();
  assert.match(listing, /'s01\/s01_001.wav', '010203'/);
  assert.match(listing, /'my-data.json'/);
  assert.ok(readFileSync(path).length > 0);
});
