// SPDX-FileCopyrightText: 2026 Bruno Pacheco (https://bruno.pacheco.lu)
// SPDX-License-Identifier: Apache-2.0

// An Access signing key and token, made the way Cloudflare Access makes them, for tests.

const base64Url = (bytes) => Buffer.from(bytes).toString("base64url");

export async function accessKey(kid = "key-1") {
  const pair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true, ["sign", "verify"]);
  const jwk = { ...(await crypto.subtle.exportKey("jwk", pair.publicKey)), kid, alg: "RS256" };
  const sign = async (claims) => {
    const head = base64Url(new TextEncoder().encode(JSON.stringify({ alg: "RS256", kid, typ: "JWT" })));
    const body = base64Url(new TextEncoder().encode(JSON.stringify(claims)));
    const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", pair.privateKey, new TextEncoder().encode(`${head}.${body}`));
    return `${head}.${body}.${base64Url(new Uint8Array(signature))}`;
  };
  const fetchCerts = async () => new Response(JSON.stringify({ keys: [jwk] }));
  return { sign, fetchCerts };
}
