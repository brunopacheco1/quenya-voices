// SPDX-FileCopyrightText: 2026 Bruno Pacheco (https://bruno.pacheco.lu)
// SPDX-License-Identifier: Apache-2.0

// The consent volunteers give before recording: kept as short as possible; the details are in the Privacy Notice
// and the Terms (legal/). Each volunteer's consent.json keeps the exact wording they accepted. The version is the
// date in site.json, so changing the legal pages (and that date) asks everyone to accept again.

import site from "../site.json" with { type: "json" };

export const CONSENT_VERSION = site.last_updated;

// Recordings are only ever used for training; the site never publishes them. Volunteers can download their own
// recordings and publish them themselves. Kept in each consent record, which the training download reads.
export const USE = "training-only";

// [label](link) is shown as a link.
export const INTRO = [
  "Your recordings stay private: we use the ones a reviewer accepts only to train open Quenya voices, and never "
    + "publish them. The published voice is an artificial one, and its licence forbids imitating real people.",
  "You can download your recordings (and publish them yourself if you like) and ask for erasure at any time under "
    + "My data: we then delete them, also from backups, and leave them out of all future training.",
];

export const STATEMENTS = [
  "I am 18 or older, and the voice I record is my own.",
  "I agree that my submitted recordings are used to train speech models that are published openly, and I "
    + "understand that a trained model may still produce speech that sounds like me. I accept the "
    + "[Terms](terms.html) and have read the [Privacy Notice](privacy.html).",
];

// Checks a consent form ({credit_name, agree}) and returns the record to store, or {error}.
// previous: the volunteer's earlier consent, if any (the terms changed since).
export function consentRecord(form, email, previous = null, now = new Date()) {
  if (!form || form.agree !== true) return { error: "Tick both statements to go on." };
  const creditName = cleanName(form.credit_name);
  if (creditName === undefined) return { error: "The name is too long (80 characters at most)." };
  return {
    email,
    credit_name: creditName || null,
    licence: USE,
    consent_version: CONSENT_VERSION,
    statements: [...INTRO, ...STATEMENTS],
    accepted_at: now.toISOString(),
    earlier: previous ? [...(previous.earlier || []), { consent_version: previous.consent_version, licence: previous.licence, accepted_at: previous.accepted_at }] : [],
  };
}

// Whether a stored consent covers recording now: the current terms, for training only.
export function consentCurrent(consent) {
  return Boolean(consent) && consent.consent_version === CONSENT_VERSION && consent.licence === USE;
}

// The trimmed name, "" for none, or undefined if it is too long.
export function cleanName(name) {
  const clean = typeof name === "string" ? name.trim().replace(/\s+/g, " ") : "";
  return clean.length > 80 ? undefined : clean;
}
