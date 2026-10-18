// SPDX-FileCopyrightText: 2026 Bruno Pacheco (https://bruno.pacheco.lu)
// SPDX-License-Identifier: Apache-2.0

// The public progress page: totals only, no names.

const $ = (id) => document.getElementById(id);

export function trainingText(stats, now = new Date()) {
  if (!stats.minimum_reached_at) {
    const left = Math.max(0, stats.minimum_minutes - stats.accepted_minutes);
    return `${left.toFixed(1)} more minutes are needed before any training. Nothing has been used for training yet.`;
  }
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
    $("progress").value = Math.min(stats.accepted_minutes, stats.minimum_minutes);
    $("volunteers").textContent = `${stats.volunteers} volunteer${stats.volunteers === 1 ? "" : "s"} with accepted recordings.`;
    $("training").textContent = trainingText(stats);
  } catch (err) {
    $("training").textContent = `The totals could not be loaded (${err.message}).`;
  }
}

if (typeof document !== "undefined") main();
