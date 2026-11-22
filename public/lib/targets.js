// SPDX-FileCopyrightText: 2026 Bruno Pacheco (https://bruno.pacheco.lu)
// SPDX-License-Identifier: Apache-2.0

// The speech goals of site.json (speech_targets), for the Progress page and the volunteer's home.

// "1 hour", "5 hours", or "45 min".
export function duration(minutes) {
  if (minutes >= 60 && minutes % 60 === 0) return `${minutes / 60} hour${minutes === 60 ? "" : "s"}`;
  return `${Math.round(minutes)} min`;
}

// The first goal not reached yet, or null when all are.
export function nextTarget(targets, acceptedMinutes) {
  return (targets || []).find((target) => acceptedMinutes < target.minutes) || null;
}

// One sentence about the next goal.
export function nextText(targets, acceptedMinutes) {
  const next = nextTarget(targets, acceptedMinutes);
  if (!next) return "Every goal is reached. More speech still makes the voices better.";
  const left = next.minutes - acceptedMinutes;
  return `Next goal: ${next.name} at ${duration(next.minutes)}, ${left.toFixed(1)} more minutes to go.`;
}
