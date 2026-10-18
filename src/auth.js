// SPDX-FileCopyrightText: 2026 Bruno Pacheco (https://bruno.pacheco.lu)
// SPDX-License-Identifier: Apache-2.0

// Sign-in with a one-time code sent by e-mail, for invited people only (see invites.js).
//
// 1. POST /api/auth/start {email}: if the address is invited, a 6-digit code is e-mailed to it. The answer is the
//    same whether it is invited or not, so the site does not tell strangers who takes part.
// 2. POST /api/auth/verify {email, code}: a right code (within 15 minutes, at most 5 tries) starts a session: a
//    random token in an HttpOnly, Secure, SameSite=Lax cookie, valid for 30 days.
// 3. POST /api/auth/signout ends it.
// Every request checks the session and that the address is still invited, so removing an invitation (or erasing
// an account) signs that person out everywhere.
//
// Storage (encrypted, like everything else):
//   auth/codes/<email hash>.json      {code_hash, expires_at, attempts, sent: [times]}
//   auth/sessions/<token hash>.json   {email, created_at, expires_at}
// Only hashes of the codes and tokens are stored.

import { isInvited, validEmail } from "./invites.js";

export const SESSION_COOKIE = "qv_session";
const CODE_MINUTES = 15;
const MAX_ATTEMPTS = 5;
const CODES_PER_HOUR = 3;
const SESSION_DAYS = 30;
const HOUR_MS = 60 * 60 * 1000;

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

async function sha256(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function randomCode() {
  // 6 digits, without modulo bias
  const limit = Math.floor(0xffffffff / 1000000) * 1000000;
  let value;
  do value = crypto.getRandomValues(new Uint32Array(1))[0]; while (value >= limit);
  return String(value % 1000000).padStart(6, "0");
}

function randomToken() {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
}

function sameText(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function cookie(request, name) {
  for (const part of (request.headers.get("Cookie") || "").split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return value.join("=");
  }
  return null;
}

const readJson = async (env, key) => (await (await env.TAKES.get(key))?.json()) ?? null;
const writeJson = (env, key, value) => env.TAKES.put(key, JSON.stringify(value));

export function sessionCookie(token, request, maxAgeSeconds) {
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure}`;
}

const normalize = (email) => (typeof email === "string" ? email.trim().toLowerCase() : "");

// The e-mail of the signed-in person (lower case), or null. On localhost, DEV_EMAIL signs in without a code.
export async function volunteerEmail(request, env, now = Date.now()) {
  if (env.DEV_EMAIL && LOCAL_HOSTS.has(new URL(request.url).hostname)) return env.DEV_EMAIL.toLowerCase();
  const token = cookie(request, SESSION_COOKIE);
  if (!token || token.length > 100) return null;
  const session = await readJson(env, `auth/sessions/${await sha256(token)}.json`);
  if (!session || Date.parse(session.expires_at) < now) return null;
  return (await isInvited(env, session.email)) ? session.email : null;
}

// Sends a code to an invited address. Returns {status, body}.
export async function startSignIn(env, form, now = Date.now()) {
  const email = normalize(form?.email);
  if (!validEmail(email)) return { status: 400, body: { error: "That is not an e-mail address." } };
  const answer = { status: 200, body: { sent: true } };
  if (!(await isInvited(env, email))) return answer;
  const key = `auth/codes/${await sha256(email)}.json`;
  const previous = await readJson(env, key);
  const sent = (previous?.sent || []).filter((time) => now - Date.parse(time) < HOUR_MS);
  if (sent.length >= CODES_PER_HOUR) {
    return { status: 429, body: { error: "Too many codes were sent to this address. Please wait an hour and try again." } };
  }
  const code = randomCode();
  await writeJson(env, key, {
    code_hash: await sha256(`${email}:${code}`),
    expires_at: new Date(now + CODE_MINUTES * 60 * 1000).toISOString(),
    attempts: 0,
    sent: [...sent, new Date(now).toISOString()],
  });
  await env.sendMail({
    to: email,
    subject: `Your Quenya Voices sign-in code: ${code}`,
    text: [
      `Your sign-in code for Quenya Voices is ${code}.`,
      "",
      `It works for ${CODE_MINUTES} minutes. If you did not ask for it, you can ignore this e-mail.`,
    ].join("\n"),
  });
  return answer;
}

// Checks a code and starts a session. Returns {status, body, cookie?}.
export async function verifySignIn(env, form, request, now = Date.now()) {
  const email = normalize(form?.email);
  const code = typeof form?.code === "string" ? form.code.replace(/\s/g, "") : "";
  const wrong = { status: 400, body: { error: "The code is wrong or has expired. Ask for a new one." } };
  if (!validEmail(email) || !/^\d{6}$/.test(code)) return wrong;
  const key = `auth/codes/${await sha256(email)}.json`;
  const stored = await readJson(env, key);
  if (!stored || !stored.code_hash || Date.parse(stored.expires_at) < now || stored.attempts >= MAX_ATTEMPTS) return wrong;
  if (!sameText(await sha256(`${email}:${code}`), stored.code_hash)) {
    await writeJson(env, key, { ...stored, attempts: stored.attempts + 1 });
    return wrong;
  }
  // used up, but the sending times stay for the hourly limit
  await writeJson(env, key, { sent: stored.sent });
  if (!(await isInvited(env, email))) return wrong;
  const token = randomToken();
  await writeJson(env, `auth/sessions/${await sha256(token)}.json`, {
    email,
    created_at: new Date(now).toISOString(),
    expires_at: new Date(now + SESSION_DAYS * 24 * HOUR_MS).toISOString(),
  });
  return { status: 200, body: { signed_in: true }, cookie: sessionCookie(token, request, SESSION_DAYS * 24 * 3600) };
}

export async function signOut(env, request) {
  const token = cookie(request, SESSION_COOKIE);
  if (token && token.length <= 100) await env.TAKES.delete(`auth/sessions/${await sha256(token)}.json`);
  return { status: 200, body: { signed_out: true }, cookie: sessionCookie("", request, 0) };
}

// Deletes expired codes and sessions (run daily by server.js).
export async function removeExpired(env, now = Date.now()) {
  for (const prefix of ["auth/codes/", "auth/sessions/"]) {
    let cursor;
    do {
      const page = await env.TAKES.list({ prefix, cursor });
      for (const object of page.objects) {
        const record = await readJson(env, object.key);
        const expired = prefix === "auth/codes/"
          ? (record?.sent || []).every((time) => now - Date.parse(time) > HOUR_MS)
            && !(record?.expires_at && Date.parse(record.expires_at) > now)
          : !record || Date.parse(record.expires_at) < now;
        if (expired) await env.TAKES.delete(object.key);
      }
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
  }
}
