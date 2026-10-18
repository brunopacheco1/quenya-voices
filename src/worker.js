// SPDX-FileCopyrightText: 2026 Bruno Pacheco (https://bruno.pacheco.lu)
// SPDX-License-Identifier: Apache-2.0

// API of the recording site. The page itself is static (public/); Cloudflare Access protects both.
//
// A volunteer records one session of the script (100 lines) at a time as a "recording". While it is a draft
// they can record, play back and redo any line. When they submit it, it is locked and waits for review; a
// later recording of the same session is a new, separate submission. Volunteers only ever see their own audio.
// Reviewers (the e-mails in REVIEWERS) hear submitted recordings and either accept them or send named lines
// back with a reason; only those lines open again for the volunteer (see public/lib/review.js).
//
// Storage (R2 bucket bound as TAKES):
//   volunteers/<volunteer>/consent.json                  licence and statements the volunteer accepted
//   volunteers/<volunteer>/mic-checks/<time>.json        results of each microphone check
//   recordings/<volunteer>/<recording>/recording.json   session, status (draft/submitted), dates
//   recordings/<volunteer>/<recording>/<line id>.wav    the latest take of each line (a redo replaces it)
//   reference/<line id>.wav                              TTS reading of a line for Listen (quenya_tts.volunteers)
//   queue/<volunteer>/<recording>                        marker: submitted and waiting for a reviewer
//   accepted/<volunteer>/<recording>                     marker: accepted, with its seconds of speech
// <volunteer> is derived from the e-mail, so the e-mail itself appears only inside consent.json.
//
//   GET  /api/me                                    who is signed in, their consent (or null), the consent text
//   POST /api/consent                               accept a licence: {licence, credit_name, agree}
//   POST /api/mic-check                             store a microphone check: {problems, metrics}
//   GET  /api/recordings                            the volunteer's recordings, newest first
//   POST /api/recordings                            start a recording: {session}; returns the open draft if any
//   GET  /api/recordings/<recording>                the recording and its takes (with their check codes)
//   DELETE /api/recordings/<recording>              throw away a draft and its takes
//   POST /api/recordings/<recording>/submit         submit for review: {incomplete_ok} needed if lines are missing
//   PUT  /api/recordings/<recording>/takes/<line>   upload a take (WAV body; X-Take-Checks: the page's codes)
//   GET  /api/recordings/<recording>/takes/<line>   play back your own take
//   GET  /api/reference/<line>                      the TTS reading of a line, if there is one
// Reviewers only:
//   GET  /api/review                                waiting submissions, oldest first, and accepted totals
//   GET  /api/review/<volunteer>/<recording>        a submission, its takes and the volunteer's licence
//   GET  /api/review/<volunteer>/<recording>/takes/<line>   a take
//   POST /api/review/<volunteer>/<recording>        {decision: "accept" | "redo", redo: {line: {reason, note}}}

import { volunteerEmail } from "./access.js";
import { CONSENT_VERSION, INTRO, LICENCES, STATEMENTS, consentRecord } from "./consent.js";
import { decodeWav, readWavHeader, wavProblem } from "../public/lib/audio.js";
import { checkTake } from "../public/lib/quality.js";
import { REASONS, checkReview } from "../public/lib/review.js";
import { LINE_ID, parseScript, sessionOf } from "../public/lib/script.js";

const MAX_UPLOAD_BYTES = 12 * 1024 * 1024;
// Problems the server checks again itself and refuses; the others are only recorded with the take, because
// the page knows the room noise from the microphone check and judges them better.
const REFUSED = new Set(["empty", "too_long", "clipped", "silent"]);
const CHECK_CODE = /^[a-z_]{1,20}$/;
const RECORDING_ID = /^r[0-9a-z]{6,20}$/;
const VOLUNTEER_ID = /^[0-9a-f]{16}$/;

function isReviewer(email, env) {
  return (env.REVIEWERS || "").split(",").map((entry) => entry.trim().toLowerCase()).includes(email);
}

// Whether the volunteer may (re)record this line now.
function canRecord(recording, lineId) {
  return recording.status === "draft" || (recording.status === "redo" && recording.redo.includes(lineId));
}

// What a volunteer sees of their recording: reviewers stay anonymous.
function forVolunteer(recording) {
  return { ...recording, history: (recording.history || []).map(({ by, ...event }) => event) };
}

let script = null;

// {texts: Map(line id -> text), sessions: Map(session -> [line ids])} of the recording script.
async function loadScript(env) {
  if (!script) {
    const response = await env.ASSETS.fetch(new Request("https://assets.local/script.tsv"));
    if (!response.ok) throw new Error("script.tsv is missing from the static assets (see README: build step)");
    const lines = parseScript(await response.text());
    const sessions = new Map();
    for (const line of lines) {
      const session = sessionOf(line.id);
      if (!sessions.has(session)) sessions.set(session, []);
      sessions.get(session).push(line.id);
    }
    script = { texts: new Map(lines.map((line) => [line.id, line.text])), sessions };
  }
  return script;
}

export async function volunteerId(email) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(email));
  return [...new Uint8Array(digest).slice(0, 8)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

const error = (status, message, extra = {}) => json({ error: message, ...extra }, status);

async function readJson(env, key) {
  const object = await env.TAKES.get(key);
  return object ? object.json() : null;
}

function writeJson(env, key, value) {
  return env.TAKES.put(key, JSON.stringify(value, null, 2), { httpMetadata: { contentType: "application/json" } });
}

async function requestJson(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

async function listAll(env, prefix, options = {}) {
  const objects = [];
  let cursor;
  do {
    const page = await env.TAKES.list({ prefix, cursor, ...options });
    objects.push(...page.objects);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return objects;
}

// Takes of one recording: [{id, checks, seconds}], by line id.
async function takesOf(env, volunteer, recordingId) {
  const prefix = `recordings/${volunteer}/${recordingId}/`;
  const objects = await listAll(env, prefix, { include: ["customMetadata"] });
  return objects.filter((object) => object.key.endsWith(".wav")).map((object) => ({
    id: object.key.slice(prefix.length, -4),
    checks: object.customMetadata?.checks || "",
    seconds: Number(object.customMetadata?.seconds || 0),
  })).sort((a, b) => a.id.localeCompare(b.id));
}

async function recordingsOf(env, volunteer) {
  const keys = (await listAll(env, `recordings/${volunteer}/`)).map((object) => object.key)
    .filter((key) => key.endsWith("/recording.json"));
  const recordings = await Promise.all(keys.map((key) => readJson(env, key)));
  return recordings.filter(Boolean).sort((a, b) => b.created_at.localeCompare(a.created_at));
}

function newRecordingId() {
  const random = crypto.getRandomValues(new Uint8Array(3));
  return `r${Date.now().toString(36)}${[...random].map((b) => b.toString(36).padStart(2, "0")).join("")}`;
}

function audio(object) {
  return new Response(object.body, {
    headers: { "Content-Type": "audio/wav", "Content-Length": String(object.size), "Cache-Control": "private, no-cache" },
  });
}

async function putTake(request, env, volunteer, recording, lineId) {
  const consent = await readJson(env, `volunteers/${volunteer}/consent.json`);
  if (!consent) return error(403, "Choose a licence before recording.");
  if (!canRecord(recording, lineId)) {
    return error(409, recording.status === "redo"
      ? "Only the lines the reviewer sent back can be recorded again."
      : "This recording was submitted, so it can no longer change. Start a new recording to record again.");
  }
  const length = Number(request.headers.get("Content-Length") || 0);
  if (length > MAX_UPLOAD_BYTES) return error(413, "The take is too large.");
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > MAX_UPLOAD_BYTES) return error(413, "The take is too large.");
  const header = readWavHeader(bytes);
  const problem = wavProblem(header);
  if (problem) return error(400, `The take was refused: ${problem}.`);
  const { texts } = await loadScript(env);
  const { problems, metrics } = checkTake(decodeWav(bytes, header), header.sampleRate, { text: texts.get(lineId) });
  const refused = problems.find((p) => p.level === "error" && REFUSED.has(p.code));
  if (refused) return error(422, refused.message, { problems });
  const pageCodes = (request.headers.get("X-Take-Checks") || "").split(/\s+/).filter((code) => CHECK_CODE.test(code));
  const checks = [...new Set([...pageCodes, ...problems.map((p) => p.code)])].join(" ");
  await env.TAKES.put(`recordings/${volunteer}/${recording.id}/${lineId}.wav`, bytes, {
    httpMetadata: { contentType: "audio/wav" },
    customMetadata: {
      licence: consent.licence,
      consent_version: consent.consent_version,
      sample_rate: String(header.sampleRate),
      seconds: metrics.seconds.toFixed(2),
      peak: metrics.peak.toFixed(3),
      snr_db: Number.isFinite(metrics.snrDb) ? metrics.snrDb.toFixed(1) : "",
      checks,
      recorded_at: new Date().toISOString(),
    },
  });
  if (recording.status === "redo" && !recording.redone.includes(lineId)) {
    recording.redone = [...recording.redone, lineId].sort();
    await writeJson(env, `recordings/${volunteer}/${recording.id}/recording.json`, recording);
  }
  return json({ id: lineId, bytes: bytes.byteLength, checks }, 201);
}

async function handleRecording(request, env, volunteer, recordingId, rest) {
  const method = request.method;
  if (!RECORDING_ID.test(recordingId)) return error(404, "No such recording.");
  const key = `recordings/${volunteer}/${recordingId}/recording.json`;
  const recording = await readJson(env, key);
  if (!recording) return error(404, "No such recording.");

  if (rest === "" && method === "GET") {
    return json({ ...forVolunteer(recording), takes: await takesOf(env, volunteer, recordingId) });
  }

  if (rest === "" && method === "DELETE") {
    if (recording.status !== "draft") return error(409, "Only drafts can be deleted; submitted recordings stay for the review.");
    const objects = await listAll(env, `recordings/${volunteer}/${recordingId}/`);
    for (let i = 0; i < objects.length; i += 1000) await env.TAKES.delete(objects.slice(i, i + 1000).map((o) => o.key));
    return json({ deleted: true });
  }

  if (rest === "/submit" && method === "POST") {
    if (!["draft", "redo"].includes(recording.status)) return error(409, "This recording was already submitted.");
    const { sessions } = await loadScript(env);
    const recorded = new Set((await takesOf(env, volunteer, recordingId)).map((take) => take.id));
    if (recorded.size === 0) return error(400, "Record at least one line before submitting.");
    const missing = recording.status === "redo"
      ? recording.redo.filter((id) => !recording.redone.includes(id))
      : sessions.get(recording.session).filter((id) => !recorded.has(id));
    const form = (await requestJson(request)) || {};
    if (missing.length && form.incomplete_ok !== true) {
      return error(409, `${missing.length} lines have no ${recording.status === "redo" ? "new " : ""}recording yet.`, { missing });
    }
    const now = new Date().toISOString();
    const submitted = {
      ...recording,
      status: "submitted",
      submitted_at: now,
      round: (recording.round || 0) + 1,
      recorded: recorded.size,
      missing: sessions.get(recording.session).filter((id) => !recorded.has(id)),
      history: [...(recording.history || []), { event: "submitted", at: now, not_redone: recording.status === "redo" ? missing : undefined }],
    };
    await writeJson(env, key, submitted);
    await env.TAKES.put(`queue/${volunteer}/${recordingId}`, "", { customMetadata: { submitted_at: now } });
    return json(forVolunteer(submitted));
  }

  const take = /^\/takes\/([^/]+)$/.exec(rest);
  if (take) {
    const lineId = take[1];
    const { sessions } = await loadScript(env);
    if (!LINE_ID.test(lineId) || !sessions.get(recording.session).includes(lineId)) {
      return error(404, "This line is not part of this recording's session.");
    }
    if (method === "PUT") return putTake(request, env, volunteer, recording, lineId);
    if (method === "GET") {
      const object = await env.TAKES.get(`recordings/${volunteer}/${recordingId}/${lineId}.wav`);
      return object ? audio(object) : error(404, "Not recorded yet.");
    }
  }
  return error(405, "Method not allowed.");
}

async function handleReview(request, env, reviewer, rest) {
  const method = request.method;
  if (rest === "" && method === "GET") {
    const markers = await listAll(env, "queue/", { include: ["customMetadata"] });
    const waiting = await Promise.all(markers.map(async (marker) => {
      const [, volunteer, recordingId] = marker.key.split("/");
      const recording = await readJson(env, `recordings/${volunteer}/${recordingId}/recording.json`);
      const consent = await readJson(env, `volunteers/${volunteer}/consent.json`);
      return recording && recording.status === "submitted" && {
        volunteer,
        name: consent?.credit_name || null,
        id: recording.id,
        session: recording.session,
        round: recording.round,
        recorded: recording.recorded,
        lines: recording.lines,
        submitted_at: recording.submitted_at,
      };
    }));
    const totals = {};
    for (const marker of await listAll(env, "accepted/", { include: ["customMetadata"] })) {
      const [, volunteer] = marker.key.split("/");
      totals[volunteer] ??= { volunteer, name: marker.customMetadata?.name || null, recordings: 0, seconds: 0 };
      totals[volunteer].recordings += 1;
      totals[volunteer].seconds += Number(marker.customMetadata?.seconds || 0);
    }
    return json({
      waiting: waiting.filter(Boolean).sort((a, b) => a.submitted_at.localeCompare(b.submitted_at)),
      accepted: Object.values(totals).sort((a, b) => b.seconds - a.seconds),
    });
  }

  const match = /^\/([^/]+)\/([^/]+)(\/takes\/([^/]+))?$/.exec(rest);
  if (!match || !VOLUNTEER_ID.test(match[1]) || !RECORDING_ID.test(match[2])) return error(404, "Not found.");
  const [, volunteer, recordingId, , lineId] = match;
  const key = `recordings/${volunteer}/${recordingId}/recording.json`;
  const recording = await readJson(env, key);
  if (!recording || recording.status === "draft") return error(404, "No such submission.");

  if (lineId && method === "GET") {
    if (!LINE_ID.test(lineId)) return error(404, "Not found.");
    const object = await env.TAKES.get(`recordings/${volunteer}/${recordingId}/${lineId}.wav`);
    return object ? audio(object) : error(404, "Not recorded.");
  }
  if (lineId) return error(405, "Method not allowed.");

  const takes = await takesOf(env, volunteer, recordingId);
  if (method === "GET") {
    const consent = await readJson(env, `volunteers/${volunteer}/consent.json`);
    return json({
      ...recording,
      volunteer,
      name: consent?.credit_name || null,
      licence: consent?.licence || null,
      takes,
    });
  }
  if (method !== "POST") return error(405, "Method not allowed.");
  if (recording.status !== "submitted") return error(409, "This submission is not waiting for a review.");
  // Lines already accepted in an earlier round stay accepted; only the rest is reviewed now.
  const reviewable = takes.map((take) => take.id).filter((id) => recording.review?.[id]?.status !== "good");
  const result = checkReview(await requestJson(request), takes.map((take) => take.id), reviewable);
  if (result.error) return error(400, result.error);
  const now = new Date().toISOString();
  const accepted = result.redo.length === 0;
  const reviewed = {
    ...recording,
    status: accepted ? "accepted" : "redo",
    review: { ...(recording.review || {}), ...result.lines },
    redo: result.redo,
    redone: [],
    reviewed_at: now,
    history: [...(recording.history || []), { event: accepted ? "accepted" : "redo_requested", at: now, by: reviewer, lines: accepted ? undefined : result.redo }],
  };
  await writeJson(env, key, reviewed);
  await env.TAKES.delete(`queue/${volunteer}/${recordingId}`);
  if (accepted) {
    const consent = await readJson(env, `volunteers/${volunteer}/consent.json`);
    const seconds = takes.filter((take) => reviewed.review[take.id]?.status === "good").reduce((sum, take) => sum + take.seconds, 0);
    await env.TAKES.put(`accepted/${volunteer}/${recordingId}`, "", {
      customMetadata: { seconds: seconds.toFixed(1), session: String(recording.session), name: consent?.credit_name || "" },
    });
  }
  return json(reviewed);
}

async function handleApi(request, env) {
  const email = await volunteerEmail(request, env);
  if (!email) return error(401, "Not signed in. Open the site from your invitation link.");
  const volunteer = await volunteerId(email);
  const path = new URL(request.url).pathname;
  const method = request.method;
  const consentKey = `volunteers/${volunteer}/consent.json`;

  if (path === "/api/me" && method === "GET") {
    return json({
      email,
      volunteer,
      reviewer: isReviewer(email, env),
      reasons: REASONS,
      consent: await readJson(env, consentKey),
      terms: { version: CONSENT_VERSION, intro: INTRO, licences: LICENCES, statements: STATEMENTS },
    });
  }

  if (path === "/api/consent" && method === "POST") {
    if (await readJson(env, consentKey)) {
      return error(409, "You already chose a licence. To change it, write to the project coordinator.");
    }
    const record = consentRecord(await requestJson(request), email);
    if (record.error) return error(400, record.error);
    await writeJson(env, consentKey, record);
    return json(record, 201);
  }

  if (path === "/api/mic-check" && method === "POST") {
    const result = (await requestJson(request)) || {};
    const stored = { checked_at: new Date().toISOString(), problems: result.problems, metrics: result.metrics };
    if (JSON.stringify(stored).length > 20000) return error(413, "Too large.");
    await writeJson(env, `volunteers/${volunteer}/mic-checks/${stored.checked_at}.json`, stored);
    return json({ stored: true }, 201);
  }

  if (path === "/api/recordings" && method === "GET") {
    const recordings = await recordingsOf(env, volunteer);
    const withCounts = await Promise.all(recordings.map(async (recording) => ({
      ...recording,
      recorded: (await takesOf(env, volunteer, recording.id)).length,
    })));
    return json({ recordings: withCounts });
  }

  if (path === "/api/recordings" && method === "POST") {
    if (!(await readJson(env, consentKey))) return error(403, "Choose a licence before recording.");
    const session = Number(((await requestJson(request)) || {}).session);
    const { sessions } = await loadScript(env);
    if (!sessions.has(session)) return error(400, "No such session in the script.");
    const open = (await recordingsOf(env, volunteer)).find((r) => r.session === session && r.status === "draft");
    if (open) return json(open);
    const recording = {
      id: newRecordingId(),
      session,
      status: "draft",
      lines: sessions.get(session).length,
      created_at: new Date().toISOString(),
      submitted_at: null,
      round: 0,
      review: {}, // line id -> {status: "good" | "redo", reason, note}
      redo: [], // lines sent back by the reviewer, open to record again
      redone: [], // of those, the ones recorded again
      history: [],
    };
    await writeJson(env, `recordings/${volunteer}/${recording.id}/recording.json`, recording);
    return json(recording, 201);
  }

  if (path === "/api/review" || path.startsWith("/api/review/")) {
    if (!isReviewer(email, env)) return error(403, "Only reviewers can do this.");
    return handleReview(request, env, email, path.slice("/api/review".length));
  }

  const recording = /^\/api\/recordings\/([^/]+)(\/.*)?$/.exec(path);
  if (recording) return handleRecording(request, env, volunteer, recording[1], recording[2] || "");

  const reference = /^\/api\/reference\/([^/]+)$/.exec(path);
  if (reference && method === "GET") {
    const { texts } = await loadScript(env);
    if (!LINE_ID.test(reference[1]) || !texts.has(reference[1])) return error(404, "No such line in the script.");
    const object = await env.TAKES.get(`reference/${reference[1]}.wav`);
    return object ? audio(object) : error(404, "No reference reading for this line yet.");
  }

  return error(404, "Not found.");
}

export default {
  async fetch(request, env) {
    if (new URL(request.url).pathname.startsWith("/api/")) {
      try {
        return await handleApi(request, env);
      } catch (err) {
        console.error(err);
        return error(500, "Something went wrong on the server. Please try again.");
      }
    }
    return env.ASSETS.fetch(request);
  },
};
