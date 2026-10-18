// SPDX-FileCopyrightText: 2026 Bruno Pacheco (https://bruno.pacheco.lu)
// SPDX-License-Identifier: Apache-2.0

// The web server: the static page (public/) and the API (src/worker.js), on 127.0.0.1:PORT behind Caddy, which
// adds HTTPS (deploy/Caddyfile). For local development: npm run dev, then open http://localhost:8787.
//
// Settings come from the environment (on the server: /etc/quenya-voices.env, see README.md).

import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";

import worker, { removeOld } from "./src/worker.js";
import { bucketFromEnvironment } from "./src/storage.js";
import { mailerFromEnvironment } from "./src/mail.js";

const PUBLIC = fileURLToPath(new URL("./public/", import.meta.url));
const MAX_BODY = 13 * 1024 * 1024;
const DAY_MS = 24 * 60 * 60 * 1000;
const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json", ".tsv": "text/tab-separated-values; charset=utf-8", ".svg": "image/svg+xml",
  ".png": "image/png", ".ico": "image/x-icon", ".woff2": "font/woff2", ".txt": "text/plain; charset=utf-8",
};

// Static files from public/, as a fetch-style handler (the API reads script.tsv through it too).
export async function serveStatic(request) {
  let path = decodeURIComponent(new URL(request.url).pathname);
  if (path.endsWith("/")) path += "index.html";
  const file = normalize(join(PUBLIC, path));
  if (!file.startsWith(PUBLIC) || file.split(sep).some((part) => part.startsWith(".") && part.length > 1)) {
    return new Response("Not found", { status: 404 });
  }
  try {
    if (!(await stat(file)).isFile()) throw new Error("not a file");
    return new Response(await readFile(file), {
      headers: { "Content-Type": TYPES[extname(file)] || "application/octet-stream", "Cache-Control": "no-cache" },
    });
  } catch {
    return new Response("Not found", { status: 404 });
  }
}

// Node's request -> a fetch Request. Caddy keeps the Host header and says in X-Forwarded-Proto that the visitor
// used HTTPS.
async function toRequest(req) {
  const proto = req.headers["x-forwarded-proto"] === "https" ? "https" : "http";
  const host = req.headers.host || "localhost";
  const chunks = [];
  let size = 0;
  if (req.method !== "GET" && req.method !== "HEAD") {
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_BODY) throw Object.assign(new Error("too large"), { status: 413 });
      chunks.push(chunk);
    }
  }
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) headers.set(name, [value].flat().join(", "));
  return new Request(`${proto}://${host}${req.url}`, {
    method: req.method,
    headers,
    body: chunks.length ? Buffer.concat(chunks) : undefined,
  });
}

async function send(res, response) {
  const headers = {};
  response.headers.forEach((value, name) => { headers[name] = value; });
  const cookies = response.headers.getSetCookie();
  if (cookies.length) headers["set-cookie"] = cookies;
  res.writeHead(response.status, headers);
  res.end(response.body ? Buffer.from(await response.arrayBuffer()) : undefined);
}

export async function makeEnv(environment = process.env) {
  const settings = { ...environment };
  // signing in without a code is for local development only
  if (settings.NODE_ENV === "production") delete settings.DEV_EMAIL;
  return {
    ...settings,
    TAKES: await bucketFromEnvironment(environment),
    ASSETS: { fetch: serveStatic },
    sendMail: mailerFromEnvironment(environment),
  };
}

async function main() {
  const env = await makeEnv();
  const port = Number(env.PORT || 8787);
  const host = env.HOST || "127.0.0.1";
  createServer(async (req, res) => {
    try {
      await send(res, await worker.fetch(await toRequest(req), env));
    } catch (err) {
      if (err.status !== 413) console.error(err);
      res.writeHead(err.status || 500, { "Content-Type": "text/plain" }).end(err.status ? "Too large" : "Server error");
    }
  }).listen(port, host, () => console.log(`Quenya Voices on http://${host}:${port}`));

  const tidy = () => removeOld(env).then((n) => n && console.log(`deleted ${n} old microphone checks`))
    .catch((err) => console.error("daily clean-up failed:", err));
  tidy();
  setInterval(tidy, DAY_MS).unref();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
