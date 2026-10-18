// SPDX-FileCopyrightText: 2026 Bruno Pacheco (https://bruno.pacheco.lu)
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import worker, { removeOld } from "../src/worker.js";
import { Encrypted, FileBucket, importKey } from "../src/storage.js";

const SITE = "https://voices.example.org";

async function setup(t) {
  const folder = await mkdtemp(join(tmpdir(), "qv-auth-"));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const env = {
    ADMINS: "admin@example.org",
    TAKES: new Encrypted(new FileBucket(folder), await importKey(Buffer.alloc(32, 7).toString("base64"))),
    mails: [],
    sendMail: async (mail) => { env.mails.push(mail); },
    ASSETS: { fetch: async () => new Response("page") },
  };
  const call = (path, { json, cookie } = {}) => worker.fetch(new Request(`${SITE}${path}`, {
    method: json ? "POST" : "GET",
    headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
    body: json && JSON.stringify(json),
  }), env);
  const lastCode = () => /(\d{6})\./.exec(env.mails.at(-1).text)[1];
  // Signs in and returns the session cookie ("name=value").
  const signIn = async (email) => {
    await call("/api/auth/start", { json: { email } });
    const response = await call("/api/auth/verify", { json: { email, code: lastCode() } });
    assert.equal(response.status, 200);
    return response.headers.get("Set-Cookie").split(";")[0];
  };
  return { env, folder, call, lastCode, signIn };
}

test("an invited address gets a code by e-mail and signs in with it", async (t) => {
  const { env, call, lastCode } = await setup(t);
  await env.TAKES.put("config/invites.json", JSON.stringify({ emails: ["ana@example.org"] }));
  assert.equal((await call("/api/me")).status, 401);

  assert.equal((await call("/api/auth/start", { json: { email: " Ana@Example.org " } })).status, 200);
  assert.equal(env.mails.length, 1);
  assert.equal(env.mails[0].to, "ana@example.org");
  const response = await call("/api/auth/verify", { json: { email: "ana@example.org", code: lastCode() } });
  assert.equal(response.status, 200);
  const setCookie = response.headers.get("Set-Cookie");
  assert.match(setCookie, /^qv_session=[\w-]{43}; Path=\/; HttpOnly; SameSite=Lax; Max-Age=2592000; Secure$/);

  const me = await (await call("/api/me", { cookie: setCookie.split(";")[0] })).json();
  assert.equal(me.email, "ana@example.org");
});

test("strangers get the same answer but no e-mail", async (t) => {
  const { env, call } = await setup(t);
  const response = await call("/api/auth/start", { json: { email: "stranger@example.org" } });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { sent: true });
  assert.equal(env.mails.length, 0);
  assert.equal((await call("/api/auth/start", { json: { email: "not an address" } })).status, 400);
});

test("a code works once, for 5 tries at most, and codes are limited to 3 an hour", async (t) => {
  const { call, lastCode } = await setup(t);
  const email = "admin@example.org"; // admins are always invited
  await call("/api/auth/start", { json: { email } });
  const code = lastCode();
  const wrong = String((Number(code) + 1) % 1000000).padStart(6, "0");
  for (let i = 0; i < 5; i++) assert.equal((await call("/api/auth/verify", { json: { email, code: wrong } })).status, 400);
  assert.equal((await call("/api/auth/verify", { json: { email, code } })).status, 400, "locked after 5 wrong tries");

  await call("/api/auth/start", { json: { email } });
  assert.equal((await call("/api/auth/verify", { json: { email, code: lastCode() } })).status, 200);
  assert.equal((await call("/api/auth/verify", { json: { email, code: lastCode() } })).status, 400, "used up");
  assert.equal((await call("/api/auth/start", { json: { email } })).status, 200, "third code in an hour");
  assert.equal((await call("/api/auth/start", { json: { email } })).status, 429, "fourth code in an hour");
});

test("signing out, removing the invitation, or erasing the account ends the session", async (t) => {
  const { env, call, signIn } = await setup(t);
  const admin = await signIn("admin@example.org");
  await call("/api/admin/invites", { json: { email: "bea@example.org" }, cookie: admin });

  const bea = await signIn("bea@example.org");
  assert.equal((await call("/api/me", { cookie: bea })).status, 200);
  const out = await call("/api/auth/signout", { json: {}, cookie: bea });
  assert.match(out.headers.get("Set-Cookie"), /^qv_session=; .*Max-Age=0/);
  assert.equal((await call("/api/me", { cookie: bea })).status, 401);

  const again = await signIn("bea@example.org");
  await worker.fetch(new Request(`${SITE}/api/admin/invites`, {
    method: "DELETE", headers: { Cookie: admin }, body: JSON.stringify({ email: "bea@example.org" }),
  }), env);
  assert.equal((await call("/api/me", { cookie: again })).status, 401, "invitation removed");

  await call("/api/admin/invites", { json: { email: "bea@example.org" }, cookie: admin });
  const third = await signIn("bea@example.org");
  const erased = await worker.fetch(new Request(`${SITE}/api/me`, {
    method: "DELETE", headers: { Cookie: third }, body: JSON.stringify({ confirm: "delete" }),
  }), env);
  assert.equal((await erased.json()).invitation, "removed");
  assert.equal((await call("/api/me", { cookie: third })).status, 401);
  assert.deepEqual((await (await call("/api/admin/invites", { cookie: admin })).json()).invites, []);
});

test("old microphone checks and expired sessions are deleted", async (t) => {
  const { env, signIn } = await setup(t);
  const cookie = await signIn("admin@example.org");
  await env.TAKES.put("mic-checks/0123456789abcdef/2025-01-01T10:00:00.000Z.json", "{}");
  await env.TAKES.put("mic-checks/0123456789abcdef/2026-10-01T10:00:00.000Z.json", "{}");
  const now = Date.parse("2026-10-18T12:00:00Z");
  assert.equal(await removeOld(env, now), 1);
  const keys = async (prefix) => (await env.TAKES.list({ prefix })).objects.map((o) => o.key);
  assert.deepEqual(await keys("mic-checks/"), ["mic-checks/0123456789abcdef/2026-10-01T10:00:00.000Z.json"]);
  assert.equal((await keys("auth/sessions/")).length, 1, "the session is still valid");
  await removeOld(env, Date.now() + 31 * 24 * 3600 * 1000);
  assert.deepEqual(await keys("auth/sessions/"), []);
  assert.deepEqual(await keys("auth/codes/"), []);
  assert.ok(cookie);
});
