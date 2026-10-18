// SPDX-FileCopyrightText: 2026 Bruno Pacheco (https://bruno.pacheco.lu)
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { test } from "node:test";

import worker from "../src/worker.js";
import { encodeWav } from "../public/lib/audio.js";
import { RATE, take } from "./signals.js";

// Just enough of an R2 bucket for the worker.
class FakeBucket {
  constructor() { this.objects = new Map(); }
  async put(key, value, options = {}) {
    const bytes = typeof value === "string" ? new TextEncoder().encode(value) : new Uint8Array(value);
    this.objects.set(key, { bytes, ...options });
  }
  async get(key) {
    const stored = this.objects.get(key);
    if (!stored) return null;
    return {
      size: stored.bytes.byteLength,
      body: stored.bytes,
      customMetadata: stored.customMetadata,
      json: async () => JSON.parse(new TextDecoder().decode(stored.bytes)),
    };
  }
  async delete(keys) {
    for (const key of [keys].flat()) this.objects.delete(key);
  }
  async list({ prefix, cursor }) {
    const keys = [...this.objects.keys()].filter((key) => key.startsWith(prefix)).sort();
    const start = Number(cursor || 0);
    const page = keys.slice(start, start + 2); // small pages, to test the cursor
    const truncated = start + 2 < keys.length;
    return {
      objects: page.map((key) => ({ key, customMetadata: this.objects.get(key).customMetadata })),
      truncated,
      cursor: truncated ? String(start + 2) : undefined,
    };
  }
}

const SCRIPT = "id\ttext\tsource\tgloss\n"
  + "s01_001\tAlla!\tbook\t\ns01_002\tAiya!\tbook\t\ns01_003\tNamárië!\tbook\t\ns02_001\tElen síla.\tbook\t\n";

function setup() {
  const env = {
    DEV_EMAIL: "ana@example.org",
    REVIEWERS: "Rev@Example.org, other@example.org",
    TAKES: new FakeBucket(),
    ASSETS: { fetch: async (request) => new URL(request.url).pathname === "/script.tsv"
      ? new Response(SCRIPT) : new Response("page") },
  };
  const as = (email) => (path, init = {}) => {
    env.DEV_EMAIL = email;
    if (init.json) init = { ...init, body: JSON.stringify(init.json), headers: { "Content-Type": "application/json" } };
    return worker.fetch(new Request(`http://localhost:8787${path}`, init), env);
  };
  return { env, ana: as("ana@example.org"), bea: as("bea@example.org"), rev: as("rev@example.org") };
}

const goodTake = () => encodeWav(take([[0.4, "silence"], [1, "speech"], [0.6, "silence"]]), RATE);
const body = async (response) => response.json();

async function startRecording(call, session = 1, licence = "training-only") {
  await call("/api/consent", { method: "POST", json: { licence, agree: true } });
  return body(await call("/api/recordings", { method: "POST", json: { session } }));
}

test("the page itself is served from the static assets", async () => {
  const { ana } = setup();
  assert.equal(await (await ana("/")).text(), "page");
});

test("nobody gets in without a signed-in volunteer", async () => {
  const { env } = setup();
  const response = await worker.fetch(new Request("https://x.workers.dev/api/me"), env);
  assert.equal(response.status, 401);
});

test("a licence is needed before recording, and is chosen once", async () => {
  const { ana } = setup();
  let me = await body(await ana("/api/me"));
  assert.equal(me.consent, null);
  assert.equal(me.reviewer, false);
  assert.equal((await ana("/api/recordings", { method: "POST", json: { session: 1 } })).status, 403);
  assert.equal((await ana("/api/consent", { method: "POST", json: { licence: "CC-BY-4.0", agree: true } })).status, 400);
  const consent = await ana("/api/consent", { method: "POST", json: { licence: "CC-BY-4.0", credit_name: " Ana  Silva ", agree: true } });
  assert.equal((await body(consent)).credit_name, "Ana Silva");
  assert.equal((await ana("/api/consent", { method: "POST", json: { licence: "training-only", agree: true } })).status, 409);
  me = await body(await ana("/api/me"));
  assert.equal(me.consent.licence, "CC-BY-4.0");
});

test("a volunteer records a draft, plays it back, and submits it incomplete only when they confirm", async () => {
  const { ana, env } = setup();
  const recording = await startRecording(ana);
  assert.equal(recording.status, "draft");
  assert.deepEqual(await body(await ana("/api/recordings", { method: "POST", json: { session: 1 } })), recording, "reopens the draft");

  assert.equal((await ana(`/api/recordings/${recording.id}/submit`, { method: "POST", json: {} })).status, 400, "nothing recorded");
  for (const line of ["s01_001", "s01_002"]) {
    assert.equal((await ana(`/api/recordings/${recording.id}/takes/${line}`, { method: "PUT", body: goodTake() })).status, 201);
  }
  const stored = [...env.TAKES.objects.entries()].find(([key]) => key.endsWith("/s01_002.wav"))[1];
  assert.equal(stored.customMetadata.licence, "training-only");
  assert.equal(stored.customMetadata.checks, "");
  const back = await ana(`/api/recordings/${recording.id}/takes/s01_002`);
  assert.equal(back.headers.get("Content-Type"), "audio/wav");

  const view = await body(await ana(`/api/recordings/${recording.id}`));
  assert.deepEqual(view.takes.map((t) => t.id), ["s01_001", "s01_002"]);

  const incomplete = await ana(`/api/recordings/${recording.id}/submit`, { method: "POST", json: {} });
  assert.equal(incomplete.status, 409);
  assert.deepEqual((await body(incomplete)).missing, ["s01_003"]);
  const submitted = await body(await ana(`/api/recordings/${recording.id}/submit`, { method: "POST", json: { incomplete_ok: true } }));
  assert.equal(submitted.status, "submitted");
  assert.equal(submitted.round, 1);

  assert.equal((await ana(`/api/recordings/${recording.id}/takes/s01_003`, { method: "PUT", body: goodTake() })).status, 409, "locked");
  assert.equal((await ana(`/api/recordings/${recording.id}`, { method: "DELETE" })).status, 409);
  const again = await body(await ana("/api/recordings", { method: "POST", json: { session: 1 } }));
  assert.notEqual(again.id, recording.id, "a new recording of the same session is a separate submission");
  const list = await body(await ana("/api/recordings"));
  assert.deepEqual(list.recordings.map((r) => [r.status, r.recorded]).sort(), [["draft", 0], ["submitted", 2]]);
});

test("a draft can be deleted with its takes", async () => {
  const { ana, env } = setup();
  const recording = await startRecording(ana);
  await ana(`/api/recordings/${recording.id}/takes/s01_001`, { method: "PUT", body: goodTake() });
  assert.equal((await ana(`/api/recordings/${recording.id}`, { method: "DELETE" })).status, 200);
  assert.equal([...env.TAKES.objects.keys()].filter((key) => key.startsWith("recordings/")).length, 0);
});

test("takes are checked: bad files and failing takes are refused, warnings are kept", async () => {
  const { ana } = setup();
  const recording = await startRecording(ana);
  const put = (line, data, headers = {}) => ana(`/api/recordings/${recording.id}/takes/${line}`, { method: "PUT", body: data, headers });
  assert.equal((await put("s02_001", goodTake())).status, 404, "not in this session");
  assert.equal((await put("..%2Fx", goodTake())).status, 404);
  assert.equal((await put("s01_001", "hello, not audio, but long enough to have a header..")).status, 400);
  const silent = await put("s01_001", encodeWav(new Float32Array(RATE), RATE));
  assert.equal(silent.status, 422);
  assert.match((await body(silent)).error, /Almost nothing/);
  const clipped = encodeWav(take([[0.4, "silence"], [1, "speech", 2], [0.6, "silence"]]).map((x) => Math.max(-1, Math.min(1, x))), RATE);
  assert.equal((await put("s01_001", clipped)).status, 422);
  const flagged = await put("s01_001", goodTake(), { "X-Take-Checks": "cut_end <script> noisy cut_end" });
  assert.equal((await body(flagged)).checks, "cut_end noisy");
});

test("volunteers only see their own recordings; only reviewers review", async () => {
  const { ana, bea } = setup();
  const recording = await startRecording(ana);
  await ana(`/api/recordings/${recording.id}/takes/s01_001`, { method: "PUT", body: goodTake() });
  assert.deepEqual((await body(await bea("/api/recordings"))).recordings, []);
  assert.equal((await bea(`/api/recordings/${recording.id}`)).status, 404);
  assert.equal((await bea(`/api/recordings/${recording.id}/takes/s01_001`)).status, 404);
  assert.equal((await bea("/api/review")).status, 403);
});

test("review: redo needs reasons, opens only the named lines, and acceptance locks everything", async () => {
  const { ana, rev } = setup();
  assert.equal((await body(await rev("/api/me"))).reviewer, true);
  const recording = await startRecording(ana, 1, "CC-BY-4.0");
  assert.equal(recording.status, undefined, "CC BY needs a name");
  await ana("/api/consent", { method: "POST", json: { licence: "CC-BY-4.0", credit_name: "Ana", agree: true } });
  const draft = await body(await ana("/api/recordings", { method: "POST", json: { session: 1 } }));
  for (const line of ["s01_001", "s01_002", "s01_003"]) {
    await ana(`/api/recordings/${draft.id}/takes/${line}`, { method: "PUT", body: goodTake() });
  }
  const me = await body(await ana("/api/me"));
  assert.equal((await rev(`/api/review/${me.volunteer}/${draft.id}`)).status, 404, "drafts are private");
  await ana(`/api/recordings/${draft.id}/submit`, { method: "POST", json: {} });

  const queue = await body(await rev("/api/review"));
  assert.deepEqual(queue.waiting.map((w) => [w.name, w.session, w.recorded]), [["Ana", 1, 3]]);
  const path = `/api/review/${me.volunteer}/${draft.id}`;
  const submission = await body(await rev(path));
  assert.equal(submission.licence, "CC-BY-4.0");
  assert.equal(submission.email, undefined);
  assert.equal((await rev(`${path}/takes/s01_002`)).headers.get("Content-Type"), "audio/wav");

  const noNote = await rev(path, { method: "POST", json: { decision: "redo", redo: { s01_002: { reason: "pronunciation", note: "bad" } } } });
  assert.equal(noNote.status, 400);
  const redo = await body(await rev(path, { method: "POST",
    json: { decision: "redo", redo: { s01_002: { reason: "pronunciation", note: "Stress the first syllable: AIya." } } } }));
  assert.equal(redo.status, "redo");
  assert.deepEqual(redo.redo, ["s01_002"]);
  assert.equal(redo.review.s01_001.status, "good");
  assert.deepEqual((await body(await rev("/api/review"))).waiting, []);

  const view = await body(await ana(`/api/recordings/${draft.id}`));
  assert.equal(view.review.s01_002.note, "Stress the first syllable: AIya.");
  assert.ok(view.history.every((event) => event.by === undefined), "reviewers stay anonymous");
  assert.equal((await ana(`/api/recordings/${draft.id}/takes/s01_001`, { method: "PUT", body: goodTake() })).status, 409, "accepted lines are locked");
  assert.equal((await ana(`/api/recordings/${draft.id}/submit`, { method: "POST", json: {} })).status, 409, "the redo line is not done yet");
  assert.equal((await ana(`/api/recordings/${draft.id}/takes/s01_002`, { method: "PUT", body: goodTake() })).status, 201);
  const second = await body(await ana(`/api/recordings/${draft.id}/submit`, { method: "POST", json: {} }));
  assert.equal(second.round, 2);

  const lateRedo = await rev(path, { method: "POST", json: { decision: "redo", redo: { s01_001: { reason: "noise", note: "A door closes at the end." } } } });
  assert.equal(lateRedo.status, 400, "lines accepted in round 1 cannot be sent back");
  const accepted = await body(await rev(path, { method: "POST", json: { decision: "accept" } }));
  assert.equal(accepted.status, "accepted");
  assert.equal((await ana(`/api/recordings/${draft.id}/takes/s01_002`, { method: "PUT", body: goodTake() })).status, 409);
  const totals = (await body(await rev("/api/review"))).accepted;
  assert.equal(totals.length, 1);
  assert.equal(totals[0].name, "Ana");
  assert.ok(Math.abs(totals[0].seconds - 6) < 0.5);
});

test("my data: rename, export, and delete everything", async () => {
  const { ana, env } = setup();
  const recording = await startRecording(ana, 1, "training-only");
  await ana(`/api/recordings/${recording.id}/takes/s01_001`, { method: "PUT", body: goodTake() });
  await ana("/api/mic-check", { method: "POST", json: { problems: [], metrics: { roomDb: -70 } } });

  assert.equal((await body(await ana("/api/me/name", { method: "POST", json: { credit_name: "Ana S." } }))).credit_name, "Ana S.");
  const exported = await ana("/api/me/export");
  assert.match(exported.headers.get("Content-Disposition"), /attachment/);
  const data = await body(exported);
  assert.equal(data.email, "ana@example.org");
  assert.equal(data.consent.credit_name, "Ana S.");
  assert.equal(data.recordings[0].takes[0].url, `/api/recordings/${recording.id}/takes/s01_001`);
  assert.equal(data.mic_checks[0].metrics.roomDb, -70);

  assert.equal((await ana("/api/me", { method: "DELETE", json: {} })).status, 400);
  const deleted = await body(await ana("/api/me", { method: "DELETE", json: { confirm: "delete" } }));
  assert.equal(deleted.invitation, "not configured");
  const left = [...env.TAKES.objects.keys()];
  assert.equal(left.length, 1);
  assert.match(left[0], /^erasures\/[0-9a-f]{16}\.json$/);
  assert.equal((await body(await ana("/api/me"))).consent, null);
});

test("when the terms change, volunteers accept again with the same licence before recording", async () => {
  const { ana, env } = setup();
  const recording = await startRecording(ana, 1, "training-only");
  const key = [...env.TAKES.objects.keys()].find((k) => k.endsWith("consent.json"));
  const old = JSON.parse(new TextDecoder().decode(env.TAKES.objects.get(key).bytes));
  await env.TAKES.put(key, JSON.stringify({ ...old, consent_version: "2000-01-01" }));
  assert.equal((await body(await ana("/api/me"))).consent_current, false);
  assert.equal((await ana(`/api/recordings/${recording.id}/takes/s01_001`, { method: "PUT", body: goodTake() })).status, 403);
  assert.equal((await ana("/api/consent", { method: "POST", json: { licence: "CC-BY-4.0", credit_name: "Ana", agree: true } })).status, 400);
  const renewed = await body(await ana("/api/consent", { method: "POST", json: { licence: "training-only", agree: true } }));
  assert.equal(renewed.earlier[0].consent_version, "2000-01-01");
  assert.equal((await ana(`/api/recordings/${recording.id}/takes/s01_001`, { method: "PUT", body: goodTake() })).status, 201);
});

test("admins manage invitations in the Access group", async (t) => {
  const { ana, env } = setup();
  env.ADMINS = "ana@example.org";
  assert.equal((await ana("/api/admin/invites")).status, 501);
  Object.assign(env, { CF_ACCOUNT_ID: "acc", ACCESS_GROUP_ID: "grp", CF_API_TOKEN: "token" });
  let group = { name: "Volunteers", include: [{ email: { email: "ana@example.org" } }], exclude: [], require: [] };
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    calls.push([init.method, url, init.headers.Authorization]);
    if (init.method === "PUT") group = JSON.parse(init.body);
    return new Response(JSON.stringify({ success: true, result: group }));
  });
  assert.deepEqual((await body(await ana("/api/admin/invites"))).invites, ["ana@example.org"]);
  assert.equal((await ana("/api/admin/invites", { method: "POST", json: { email: "not an email" } })).status, 400);
  assert.deepEqual((await body(await ana("/api/admin/invites", { method: "POST", json: { email: " Bea@Example.org" } }))).invites,
    ["ana@example.org", "bea@example.org"]);
  assert.deepEqual((await body(await ana("/api/admin/invites", { method: "DELETE", json: { email: "bea@example.org" } }))).invites,
    ["ana@example.org"]);
  assert.equal(calls[0][1], "https://api.cloudflare.com/client/v4/accounts/acc/access/groups/grp");
  assert.equal(calls[0][2], "Bearer token");
  env.ADMINS = "";
  assert.equal((await ana("/api/admin/invites")).status, 403);
});

test("public totals need no sign-in; the training minimum starts the waiting month once", async () => {
  const { ana, rev, env } = setup();
  const stats = async () => body(await worker.fetch(new Request("https://x.workers.dev/api/public/stats"), env));
  assert.deepEqual(await stats(), {
    accepted_minutes: 0, volunteers: 0, minimum_minutes: 60, minimum_reached_at: null, earliest_training_at: null, training_wait_days: 30,
  });
  await env.TAKES.put("accepted/0123456789abcdef/rold000001", "", { customMetadata: { seconds: "3598", name: "" } });
  assert.equal((await stats()).minimum_reached_at, null);

  const recording = await startRecording(ana);
  await ana(`/api/recordings/${recording.id}/takes/s01_001`, { method: "PUT", body: goodTake() });
  await ana(`/api/recordings/${recording.id}/submit`, { method: "POST", json: { incomplete_ok: true } });
  const me = await body(await ana("/api/me"));
  await rev(`/api/review/${me.volunteer}/${recording.id}`, { method: "POST", json: { decision: "accept" } });

  const after = await stats();
  assert.equal(after.volunteers, 2);
  assert.ok(after.accepted_minutes >= 60);
  assert.ok(after.minimum_reached_at);
  assert.equal(Date.parse(after.earliest_training_at) - Date.parse(after.minimum_reached_at), 30 * 24 * 3600 * 1000);
  const mine = await body(await ana("/api/me/contribution"));
  assert.ok(mine.accepted_minutes > 0 && mine.accepted_minutes < 1);
  assert.equal(mine.all.volunteers, 2);
});
