// SPDX-FileCopyrightText: 2026 Bruno Pacheco (https://bruno.pacheco.lu)
// SPDX-License-Identifier: Apache-2.0

// Reviews of submitted recordings. Shared by the page and the worker.
//
// A reviewer either accepts a recording, or asks for some lines to be recorded again. Each such line needs a
// reason and a note that says what to change, so the volunteer knows what to fix. Every recorded line that
// is not sent back counts as good and is locked: the volunteer can only redo the lines the reviewer named.
//
// Recording status: draft -> submitted -> accepted
//                                      -> redo -> submitted -> ...

export const REASONS = {
  pronunciation: "Pronunciation: a sound, the stress or a vowel length is wrong",
  wrong_words: "Wrong, missing or extra words",
  noise: "Background noise, other voices or clicks",
  distorted: "Distorted, clipped or too quiet",
  cut_off: "Cut off at the start or the end",
  delivery: "Delivery: too fast, hesitant, chanted or a different voice",
  other: "Other",
};

export const MIN_NOTE_LENGTH = 10;

// Checks a review ({decision: "accept" | "redo", redo: {line id: {reason, note}}}) of a recording against
// its recorded lines. Returns {lines: {id: {status, reason?, note?}}, redo: [ids]} or {error}.
export function checkReview(form, recordedIds, reviewableIds = recordedIds) {
  if (!form || !["accept", "redo"].includes(form.decision)) return { error: "Choose to accept the recording or to ask for lines to be redone." };
  const redo = form.redo && typeof form.redo === "object" ? form.redo : {};
  const ids = Object.keys(redo);
  if (form.decision === "accept" && ids.length) return { error: "An accepted recording cannot have lines to redo." };
  if (form.decision === "redo" && !ids.length) return { error: "Choose at least one line to redo." };
  const recorded = new Set(recordedIds);
  const reviewable = new Set(reviewableIds);
  const lines = {};
  for (const id of ids) {
    if (!recorded.has(id)) return { error: `Line ${id} has no recording in this submission.` };
    if (!reviewable.has(id)) return { error: `Line ${id} was already accepted in an earlier review.` };
    const { reason } = redo[id] || {};
    const note = typeof redo[id]?.note === "string" ? redo[id].note.trim().replace(/\s+/g, " ") : "";
    if (!REASONS[reason]) return { error: `Line ${id}: choose a reason.` };
    if (note.length < MIN_NOTE_LENGTH) return { error: `Line ${id}: say in a few words what to change (at least ${MIN_NOTE_LENGTH} characters).` };
    if (note.length > 500) return { error: `Line ${id}: the note is too long (500 characters at most).` };
    lines[id] = { status: "redo", reason, note };
  }
  for (const id of reviewableIds) {
    if (recorded.has(id) && !lines[id]) lines[id] = { status: "good" };
  }
  return { lines, redo: ids.sort() };
}
