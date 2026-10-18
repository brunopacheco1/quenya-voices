// SPDX-FileCopyrightText: 2026 Bruno Pacheco (https://bruno.pacheco.lu)
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { test } from "node:test";

import { verifyAccessToken, volunteerEmail } from "../src/access.js";
import { accessKey } from "./helpers.js";

const TEAM = "quenya.cloudflareaccess.com";
const AUD = "aud-tag";
const now = Math.floor(Date.now() / 1000);
const claims = { aud: [AUD], email: "Ana@Example.org", iss: `https://${TEAM}`, exp: now + 600, iat: now };

test("accepts a token signed by Access for this application", async () => {
  const { sign, fetchCerts } = await accessKey("good");
  const result = await verifyAccessToken(await sign(claims), { teamDomain: TEAM, aud: AUD }, fetchCerts);
  assert.equal(result.email, "Ana@Example.org");
});

test("refuses wrong audience, issuer, expired, tampered and foreign-key tokens", async () => {
  const { sign, fetchCerts } = await accessKey("k2");
  const options = { teamDomain: TEAM, aud: AUD };
  assert.equal(await verifyAccessToken(await sign({ ...claims, aud: ["other"] }), options, fetchCerts), null);
  assert.equal(await verifyAccessToken(await sign({ ...claims, iss: "https://evil.example" }), options, fetchCerts), null);
  assert.equal(await verifyAccessToken(await sign({ ...claims, exp: now - 10 }), options, fetchCerts), null);
  const [head, , signature] = (await sign(claims)).split(".");
  const forged = Buffer.from(JSON.stringify({ ...claims, email: "eve@example.org" })).toString("base64url");
  assert.equal(await verifyAccessToken(`${head}.${forged}.${signature}`, options, fetchCerts), null);
  const stranger = await accessKey("k2");
  assert.equal(await verifyAccessToken(await stranger.sign(claims), options, fetchCerts), null);
  assert.equal(await verifyAccessToken("not.a.token", options, fetchCerts), null);
  assert.equal(await verifyAccessToken(null, options, fetchCerts), null);
});

test("without Access settings only DEV_EMAIL on localhost gets in", async () => {
  const dev = { DEV_EMAIL: "Me@Example.org" };
  assert.equal(await volunteerEmail(new Request("http://localhost:8787/api/me"), dev), "me@example.org");
  assert.equal(await volunteerEmail(new Request("https://quenya-recorder.example.workers.dev/api/me"), dev), null);
  assert.equal(await volunteerEmail(new Request("http://localhost:8787/api/me"), {}), null);
});

test("with Access settings the token is required, also on localhost", async () => {
  const { sign, fetchCerts } = await accessKey("k3");
  const env = { ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD, DEV_EMAIL: "me@example.org" };
  assert.equal(await volunteerEmail(new Request("http://localhost:8787/api/me"), env, fetchCerts), null);
  const request = new Request("https://x.workers.dev/api/me", { headers: { "Cf-Access-Jwt-Assertion": await sign(claims) } });
  assert.equal(await volunteerEmail(request, env, fetchCerts), "ana@example.org");
  const viaCookie = new Request("https://x.workers.dev/api/me", { headers: { Cookie: `a=b; CF_Authorization=${await sign(claims)}` } });
  assert.equal(await volunteerEmail(viaCookie, env, fetchCerts), "ana@example.org");
});
