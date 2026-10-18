// SPDX-FileCopyrightText: 2026 Bruno Pacheco (https://bruno.pacheco.lu)
// SPDX-License-Identifier: Apache-2.0

// The consent volunteers give before recording: kept as short as possible; the details are in the Privacy Notice
// and the Terms (legal/). Each volunteer's consent.json keeps the exact wording they accepted. The version is the
// date in site.json, so changing the legal pages (and that date) asks everyone to accept again.

import site from "../site.json" with { type: "json" };

export const CONSENT_VERSION = site.last_updated;

// How the volunteer's recordings are shared. The trained models are published openly either way.
export const LICENCES = {
  "training-only": {
    name: "Training only (recommended)",
    short: "used for training only",
    url: "terms.html",
    summary: "your recordings stay private and are only used to train open Quenya voices. Erasure removes them completely.",
  },
  "CC-BY-4.0": {
    name: "Also publish them under CC BY 4.0",
    short: "also published under CC BY 4.0",
    url: "https://creativecommons.org/licenses/by/4.0/",
    summary: "anyone may also download and reuse your recordings, crediting you. Published copies cannot be erased, "
      + "and make your voice easier to imitate.",
  },
};

// [label](link) is shown as a link.
export const INTRO = [
  "Accepted recordings are used to train open Quenya voices. You can download your data and ask for erasure at any "
    + "time under My data: we then delete it, also from backups, and leave it out of all future training.",
];

export const STATEMENTS = [
  "I am 18 or older, and the voice I record is my own.",
  "I agree that my submitted recordings are used to train speech models that are published openly, and shared as I "
    + "chose above. I accept the [Terms](terms.html) and have read the [Privacy Notice](privacy.html).",
];

// Checks a consent form ({licence, credit_name, agree}) and returns the record to store, or {error}.
// previous: the volunteer's earlier consent, if any; the licence of existing recordings cannot change.
export function consentRecord(form, email, previous = null, now = new Date()) {
  if (!form || !LICENCES[form.licence]) return { error: "Choose how your recordings are shared." };
  if (previous && previous.licence !== form.licence) {
    return { error: "Your recordings are already shared another way. Write to the contact in the Privacy Notice to change it." };
  }
  if (form.agree !== true) return { error: "Tick both statements to go on." };
  const creditName = cleanName(form.credit_name);
  if (creditName === undefined) return { error: "The name is too long (80 characters at most)." };
  if (form.licence === "CC-BY-4.0" && !creditName) return { error: "CC BY needs the name you want to be credited by." };
  return {
    email,
    credit_name: creditName || null,
    licence: form.licence,
    licence_url: LICENCES[form.licence].url,
    consent_version: CONSENT_VERSION,
    statements: [...INTRO, ...STATEMENTS],
    accepted_at: now.toISOString(),
    earlier: previous ? [...(previous.earlier || []), { consent_version: previous.consent_version, accepted_at: previous.accepted_at }] : [],
  };
}

// The trimmed name, "" for none, or undefined if it is too long.
export function cleanName(name) {
  const clean = typeof name === "string" ? name.trim().replace(/\s+/g, " ") : "";
  return clean.length > 80 ? undefined : clean;
}
