// SPDX-FileCopyrightText: 2026 Bruno Pacheco (https://bruno.pacheco.lu)
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { test } from "node:test";

import site from "../site.json" with { type: "json" };
import { duration, nextTarget, nextText } from "../public/lib/targets.js";

test("the goals in site.json start at the training minimum and grow", () => {
  const minutes = site.speech_targets.map((target) => target.minutes);
  assert.equal(minutes[0], site.minimum_training_minutes);
  assert.deepEqual(minutes, [...minutes].sort((a, b) => a - b));
  assert.equal(new Set(minutes).size, minutes.length);
  for (const target of site.speech_targets) assert.ok(target.name && target.about);
});

test("goals read as hours or minutes, and the next one is the first not reached", () => {
  assert.equal(duration(60), "1 hour");
  assert.equal(duration(600), "10 hours");
  assert.equal(duration(45), "45 min");
  const targets = [{ minutes: 60, name: "A" }, { minutes: 300, name: "B" }];
  assert.equal(nextTarget(targets, 0).name, "A");
  assert.equal(nextTarget(targets, 60).name, "B");
  assert.equal(nextTarget(targets, 300), null);
  assert.equal(nextText(targets, 12.5), "Next goal: A at 1 hour, 47.5 more minutes to go.");
  assert.match(nextText(targets, 400), /Every goal is reached/);
});
