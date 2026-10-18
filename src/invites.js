// SPDX-FileCopyrightText: 2026 Bruno Pacheco (https://bruno.pacheco.lu)
// SPDX-License-Identifier: Apache-2.0

// Invitations: the e-mail addresses in one Cloudflare Access group, which the Access policy of the site allows in.
// Needs CF_ACCOUNT_ID, ACCESS_GROUP_ID and the secret CF_API_TOKEN (permission: Access: Organizations, Identity
// Providers, and Groups: Edit). See README.md.

const EMAIL = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]+$/;

export function invitesConfigured(env) {
  return Boolean(env.CF_ACCOUNT_ID && env.ACCESS_GROUP_ID && env.CF_API_TOKEN);
}

export function validEmail(email) {
  return typeof email === "string" && email.length <= 254 && EMAIL.test(email.trim());
}

async function groupRequest(env, fetchImpl, method, body) {
  const url = `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/access/groups/${env.ACCESS_GROUP_ID}`;
  const response = await fetchImpl(url, {
    method,
    headers: { Authorization: `Bearer ${env.CF_API_TOKEN}`, "Content-Type": "application/json" },
    body: body && JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.success === false) {
    const reason = (data.errors || []).map((e) => e.message).join("; ") || `HTTP ${response.status}`;
    throw new Error(`Cloudflare API: ${reason}`);
  }
  return data.result;
}

const emailsOf = (group) => (group.include || []).filter((rule) => rule.email).map((rule) => rule.email.email.toLowerCase());

export async function listInvites(env, fetchImpl = fetch) {
  return emailsOf(await groupRequest(env, fetchImpl, "GET")).sort();
}

// Adds (add = true) or removes an e-mail from the group; returns the new list.
export async function changeInvite(env, email, add, fetchImpl = fetch) {
  const group = await groupRequest(env, fetchImpl, "GET");
  const target = email.trim().toLowerCase();
  const others = (group.include || []).filter((rule) => !(rule.email && rule.email.email.toLowerCase() === target));
  const include = add ? [...others, { email: { email: target } }] : others;
  const updated = await groupRequest(env, fetchImpl, "PUT", {
    name: group.name,
    include,
    exclude: group.exclude || [],
    require: group.require || [],
  });
  return emailsOf(updated).sort();
}
