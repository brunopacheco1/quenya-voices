// SPDX-FileCopyrightText: 2026 Bruno Pacheco (https://bruno.pacheco.lu)
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { parseScript, sessions } from "../public/lib/script.js";

// public/script.tsv is written by build.py (npm test runs it first).
test("reads the real recording script in sessions of 100", () => {
  const lines = parseScript(readFileSync(new URL("../public/script.tsv", import.meta.url), "utf8"));
  assert.ok(lines.length > 2400);
  assert.equal(lines[1].id, "s01_002");
  assert.equal(lines[1].text, "Á na márië!");
  assert.ok(lines.every((line) => line.ipa), "every line has a pronunciation hint");
  const grouped = sessions(lines);
  assert.equal(grouped.length, 25);
  assert.ok(grouped.slice(0, -1).every(([, group]) => group.length === 100));
  assert.equal(grouped[24][0], 25);
});
