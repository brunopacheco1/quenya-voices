// SPDX-FileCopyrightText: 2026 Bruno Pacheco (https://bruno.pacheco.lu)
// SPDX-License-Identifier: Apache-2.0

// Checks the token Cloudflare Access adds to every request it lets through, and returns the volunteer's e-mail.
// Access already blocks anyone not invited; checking the token again here means the API stays closed even if
// the Access application is switched off or misconfigured. See
// https://developers.cloudflare.com/cloudflare-one/identity/authorization-cookie/validating-json/

const KEYS_TTL_MS = 60 * 60 * 1000;
let cachedKeys = { domain: null, fetchedAt: 0, keys: [] };

function base64UrlBytes(text) {
  const base64 = text.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(text.length / 4) * 4, "=");
  return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
}

function base64UrlJson(text) {
  return JSON.parse(new TextDecoder().decode(base64UrlBytes(text)));
}

async function signingKeys(teamDomain, fetchImpl, refresh) {
  const fresh = cachedKeys.domain === teamDomain && Date.now() - cachedKeys.fetchedAt < KEYS_TTL_MS;
  if (!fresh || refresh) {
    const response = await fetchImpl(`https://${teamDomain}/cdn-cgi/access/certs`);
    if (!response.ok) throw new Error(`Access certs: HTTP ${response.status}`);
    cachedKeys = { domain: teamDomain, fetchedAt: Date.now(), keys: (await response.json()).keys || [] };
  }
  return cachedKeys.keys;
}

// Returns the token's claims if it is valid for this Access application, otherwise null.
export async function verifyAccessToken(token, { teamDomain, aud }, fetchImpl = fetch, nowSeconds = Date.now() / 1000) {
  const parts = (token || "").split(".");
  if (parts.length !== 3) return null;
  let header, claims;
  try {
    [header, claims] = [base64UrlJson(parts[0]), base64UrlJson(parts[1])];
  } catch {
    return null;
  }
  if (header.alg !== "RS256") return null;
  let jwk = (await signingKeys(teamDomain, fetchImpl, false)).find((key) => key.kid === header.kid);
  if (!jwk) jwk = (await signingKeys(teamDomain, fetchImpl, true)).find((key) => key.kid === header.kid);
  if (!jwk) return null;
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const signed = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
  if (!(await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, base64UrlBytes(parts[2]), signed))) return null;
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audiences.includes(aud)) return null;
  if (claims.iss !== `https://${teamDomain}`) return null;
  if (typeof claims.exp !== "number" || claims.exp < nowSeconds) return null;
  if (typeof claims.nbf === "number" && claims.nbf > nowSeconds + 60) return null;
  return claims;
}

function cookie(request, name) {
  for (const part of (request.headers.get("Cookie") || "").split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return value.join("=");
  }
  return null;
}

// The signed-in volunteer's e-mail (lower case), or null.
// Without ACCESS_TEAM_DOMAIN and ACCESS_AUD nobody gets in, except DEV_EMAIL on localhost (wrangler dev).
export async function volunteerEmail(request, env, fetchImpl = fetch) {
  if (env.ACCESS_TEAM_DOMAIN && env.ACCESS_AUD) {
    const token = request.headers.get("Cf-Access-Jwt-Assertion") || cookie(request, "CF_Authorization");
    const claims = await verifyAccessToken(token, { teamDomain: env.ACCESS_TEAM_DOMAIN, aud: env.ACCESS_AUD }, fetchImpl);
    return claims && typeof claims.email === "string" ? claims.email.toLowerCase() : null;
  }
  const host = new URL(request.url).hostname;
  if (env.DEV_EMAIL && (host === "localhost" || host === "127.0.0.1")) return env.DEV_EMAIL.toLowerCase();
  return null;
}
