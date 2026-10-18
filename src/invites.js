// SPDX-FileCopyrightText: 2026 Bruno Pacheco (https://bruno.pacheco.lu)
// SPDX-License-Identifier: Apache-2.0

// Invitations: who may sign in. Admins manage the list on the site (Invitations); it is kept, encrypted, in
// config/invites.json. The e-mails in ADMINS and REVIEWERS are always invited.

const EMAIL = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]+$/;
const KEY = "config/invites.json";

export function validEmail(email) {
  return typeof email === "string" && email.length <= 254 && EMAIL.test(email.trim());
}

const listed = (list) => (list || "").split(",").map((entry) => entry.trim().toLowerCase()).filter(Boolean);

export async function listInvites(env) {
  const object = await env.TAKES.get(KEY);
  return object ? (await object.json()).emails : [];
}

export async function isInvited(env, email) {
  const target = email.trim().toLowerCase();
  return listed(env.ADMINS).includes(target) || listed(env.REVIEWERS).includes(target)
    || (await listInvites(env)).includes(target);
}

// Adds (add = true) or removes an e-mail; returns the new list.
export async function changeInvite(env, email, add) {
  const target = email.trim().toLowerCase();
  const current = await listInvites(env);
  const others = current.filter((entry) => entry !== target);
  const emails = (add ? [...others, target] : others).sort();
  if (emails.join() !== current.join()) await env.TAKES.put(KEY, JSON.stringify({ emails }));
  return emails;
}
