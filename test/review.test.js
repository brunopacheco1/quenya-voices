// SPDX-FileCopyrightText: 2026 Bruno Pacheco (https://bruno.pacheco.lu)
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { test } from "node:test";

import { checkReview } from "../public/lib/review.js";

const recorded = ["s01_001", "s01_002", "s01_003"];
const note = "Stress the first syllable.";

test("accepting marks every recorded line good", () => {
  const result = checkReview({ decision: "accept" }, recorded);
  assert.deepEqual(result.redo, []);
  assert.deepEqual(Object.values(result.lines).map((line) => line.status), ["good", "good", "good"]);
});

test("a redo names lines with a reason and a note; the rest is good", () => {
  const result = checkReview({ decision: "redo", redo: { s01_002: { reason: "pronunciation", note: `  ${note} ` } } }, recorded);
  assert.deepEqual(result.redo, ["s01_002"]);
  assert.deepEqual(result.lines.s01_002, { status: "redo", reason: "pronunciation", note });
  assert.equal(result.lines.s01_001.status, "good");
});

test("refuses reviews without the minimum details", () => {
  assert.match(checkReview({}, recorded).error, /accept/);
  assert.match(checkReview({ decision: "redo", redo: {} }, recorded).error, /at least one/);
  assert.match(checkReview({ decision: "accept", redo: { s01_001: { reason: "noise", note } } }, recorded).error, /cannot/);
  assert.match(checkReview({ decision: "redo", redo: { s01_001: { reason: "boring", note } } }, recorded).error, /reason/);
  assert.match(checkReview({ decision: "redo", redo: { s01_001: { reason: "noise", note: "noise" } } }, recorded).error, /what to change/);
  assert.match(checkReview({ decision: "redo", redo: { s01_009: { reason: "noise", note } } }, recorded).error, /no recording/);
  assert.match(checkReview({ decision: "redo", redo: { s01_001: { reason: "noise", note } } }, recorded, ["s01_002"]).error, /earlier/);
});
