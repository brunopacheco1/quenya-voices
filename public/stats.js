// SPDX-FileCopyrightText: 2026 Bruno Pacheco (https://bruno.pacheco.lu)
// SPDX-License-Identifier: Apache-2.0

// The public progress page: totals only, no names.

import { duration, nextTarget, nextText } from "./lib/targets.js";

const $ = (id) => document.getElementById(id);

function element(tag, properties = {}, ...children) {
  const node = Object.assign(document.createElement(tag), properties);
  node.append(...children);
  return node;
}

function showTargets(stats) {
  $("targets").replaceChildren(...(stats.targets || []).map((target) => {
    const reached = stats.accepted_minutes >= target.minutes;
    return element("li", { className: reached ? "reached" : "" },
      element("b", { textContent: `${duration(target.minutes)}: ${target.name}` }),
      element("span", { className: "muted", textContent: reached ? " · reached" : ` · ${(target.minutes - stats.accepted_minutes).toFixed(1)} min to go` }),
      element("br"),
      target.about);
  }));
}

export function trainingText(stats, now = new Date()) {
  // how much is still missing is in the next goal, just above
  if (!stats.minimum_reached_at) return "No training yet: it waits for the first goal. Nothing has been used for training.";
  const earliest = new Date(stats.earliest_training_at);
  const reached = new Date(stats.minimum_reached_at).toLocaleDateString();
  return earliest > now
    ? `The minimum was reached on ${reached}. The first training starts no earlier than ${earliest.toLocaleDateString()}.`
    : `The minimum was reached on ${reached}. Training may start whenever needed.`;
}

async function main() {
  try {
    const response = await fetch("/api/public/stats");
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const stats = await response.json();
    $("minutes").textContent = stats.accepted_minutes.toFixed(1);
    const goal = nextTarget(stats.targets, stats.accepted_minutes) || stats.targets?.at(-1);
    $("progress").max = goal?.minutes || stats.minimum_minutes;
    $("progress").value = Math.min(stats.accepted_minutes, $("progress").max);
    $("next").textContent = nextText(stats.targets, stats.accepted_minutes);
    showTargets(stats);
    $("volunteers").textContent = `${stats.volunteers} volunteer${stats.volunteers === 1 ? "" : "s"} with accepted recordings.`;
    $("training").textContent = trainingText(stats);
  } catch (err) {
    $("training").textContent = `The totals could not be loaded (${err.message}).`;
  }
}

if (typeof document !== "undefined") main();
