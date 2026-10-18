// SPDX-FileCopyrightText: 2026 Bruno Pacheco (https://bruno.pacheco.lu)
// SPDX-License-Identifier: Apache-2.0

// What volunteers agree to before recording. The page shows this text, and each volunteer's consent.json keeps
// the exact wording they accepted. Change CONSENT_VERSION whenever the wording changes.

export const CONSENT_VERSION = "2026-10-18";

export const LICENCES = {
  "CC-BY-4.0": {
    name: "CC BY 4.0",
    url: "https://creativecommons.org/licenses/by/4.0/",
    summary: "Anyone may use, share and adapt your recordings, also commercially, as long as they credit you by the name you give.",
  },
  "CC0-1.0": {
    name: "CC0 1.0",
    url: "https://creativecommons.org/publicdomain/zero/1.0/",
    summary: "You give up all your rights in your recordings, as far as the law allows. Nobody has to credit you.",
  },
};

export const INTRO = [
  "On this site you read aloud the lines of the Quenya-TTS recording script. The recordings train an open "
    + "text-to-speech voice for Quenya. The recordings and the voice trained on them will be published so that "
    + "anyone can use them, for example for the audio of the book Ma Quetilyë Quenya?.",
  "Choose the licence for your recordings. It applies to every recording you make on this site.",
];

export const STATEMENTS = [
  "I am the person speaking in these recordings, and I am at least 18 years old.",
  "I share every recording I make on this site under the licence I chose. I understand that copies already "
    + "published cannot be taken back, but I can ask for my recordings to be left out of future releases.",
  "My e-mail address is used only to let me sign in and to contact me about my recordings. It is not published.",
];

// Checks a consent form ({licence, credit_name, agree}) and returns the record to store, or {error}.
export function consentRecord(form, email, now = new Date()) {
  if (!form || !LICENCES[form.licence]) return { error: "Choose a licence." };
  if (form.agree !== true) return { error: "Tick every statement to go on." };
  const creditName = typeof form.credit_name === "string" ? form.credit_name.trim().replace(/\s+/g, " ") : "";
  if (creditName.length > 80) return { error: "The name is too long (80 characters at most)." };
  if (form.licence === "CC-BY-4.0" && !creditName) return { error: "CC BY needs the name you want to be credited by." };
  return {
    email,
    credit_name: creditName || null,
    licence: form.licence,
    licence_url: LICENCES[form.licence].url,
    consent_version: CONSENT_VERSION,
    statements: STATEMENTS,
    accepted_at: now.toISOString(),
  };
}
