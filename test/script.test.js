// SPDX-FileCopyrightText: 2026 Bruno Pacheco (https://bruno.pacheco.lu)
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { parseScript, sessions } from "../public/lib/script.js";

test("reads the real recording script in sessions of 100", () => {
  const lines = parseScript(readFileSync(new URL("../../script.tsv", import.meta.url), "utf8"));
  assert.ok(lines.length > 2400);
  assert.deepEqual(lines[1], { id: "s01_002", text: "Á na márië!", gloss: "", ipa: "" });
  const grouped = sessions(lines);
  assert.equal(grouped.length, 25);
  assert.ok(grouped.slice(0, -1).every(([, group]) => group.length === 100));
  assert.equal(grouped[24][0], 25);
});
