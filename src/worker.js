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
//   mic-checks/<volunteer>/<time>.json                   results of each microphone check (an R2 lifecycle rule
//                                                        deletes them after the time in the Privacy Notice)
//   recordings/<volunteer>/<recording>/recording.json   session, status (draft/submitted), dates
//   recordings/<volunteer>/<recording>/<line id>.wav    the latest take of each line (a redo replaces it)
//   reference/<line id>.wav                              TTS reading of a line for Listen (quenya_tts.volunteers)
//   queue/<volunteer>/<recording>                        marker: submitted and waiting for a reviewer
//   accepted/<volunteer>/<recording>                     marker: accepted, with its seconds of speech
//   erasures/<volunteer>.json                            a volunteer deleted their account: drop their local copies
//   stats/milestones.json                                when the accepted speech first reached the training minimum
// <volunteer> is derived from the e-mail, so the e-mail itself appears only inside consent.json.
//
// Public (no sign-in; the Access application must bypass /api/public/*, see README.md):
//   GET  /api/public/stats                          accepted minutes, volunteers, minimum and earliest training date
// Volunteers:
//   GET  /api/me                                    who is signed in, their consent (or null), the consent text
//   GET  /api/me/contribution                       the volunteer's accepted, waiting and draft minutes
//   POST /api/consent                               accept a licence: {licence, credit_name, agree}
//   POST /api/me/name                               change the name to be credited by: {credit_name}
//   GET  /api/me/export                             all data kept about the volunteer (audio: the takes URLs)
//   DELETE /api/me                                  {confirm: "delete"}: erase the account and every recording
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
// Admins only (the e-mails in ADMINS):
//   GET  /api/admin/invites                         invited e-mails (the Access group)
//   POST /api/admin/invites                         {email}: invite
//   DELETE /api/admin/invites                       {email}: remove the invitation

import { volunteerEmail } from "./access.js";
import site from "../site.json" with { type: "json" };
import { CONSENT_VERSION, INTRO, LICENCES, STATEMENTS, cleanName, consentRecord } from "./consent.js";
import { changeInvite, invitesConfigured, listInvites, validEmail } from "./invites.js";
import { decodeWav, readWavHeader, wavProblem } from "../public/lib/audio.js";
import { LIMITS, peakAndClipped } from "../public/lib/quality.js";
import { REASONS, checkReview } from "../public/lib/review.js";
import { LINE_ID, parseScript, sessionOf } from "../public/lib/script.js";

const MAX_UPLOAD_BYTES = 12 * 1024 * 1024;
// The server checks again only what is cheap and certain (empty, too long, clipped, silent): the free Workers
// plan allows 10 ms of CPU per request. The page runs all checks (quality.js) and sends its warning codes.
const CHECK_CODE = /^[a-z_]{1,20}$/;
const RECORDING_ID = /^r[0-9a-z]{6,20}$/;
const VOLUNTEER_ID = /^[0-9a-f]{16}$/;

const listed = (list, email) => (list || "").split(",").map((entry) => entry.trim().toLowerCase()).includes(email);
const isReviewer = (email, env) => listed(env.REVIEWERS, email);
const isAdmin = (email, env) => listed(env.ADMINS, email);
const consentCurrent = (consent) => consent?.consent_version === CONSENT_VERSION;

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
  if (!consentCurrent(consent)) return error(403, "Accept the terms before recording.");
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
  const wave = decodeWav(bytes, header);
  const seconds = wave.length / header.sampleRate;
  const { peak, clipped } = peakAndClipped(wave);
  if (seconds < LIMITS.minSeconds) return error(422, "Nothing was recorded. Record the line again.");
  if (clipped > 0) return error(422, "Too loud: it clipped. Move back from the microphone or turn the input level down, then record again.");
  if (peak < LIMITS.silentPeak) return error(422, "Almost nothing was heard. Check the microphone, then record again.");
  const checks = [...new Set((request.headers.get("X-Take-Checks") || "").split(/\s+/).filter((code) => CHECK_CODE.test(code)))].join(" ");
  await env.TAKES.put(`recordings/${volunteer}/${recording.id}/${lineId}.wav`, bytes, {
    httpMetadata: { contentType: "audio/wav" },
    customMetadata: {
      licence: consent.licence,
      consent_version: consent.consent_version,
      sample_rate: String(header.sampleRate),
      seconds: seconds.toFixed(2),
      peak: peak.toFixed(3),
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
    if (!consentCurrent(await readJson(env, `volunteers/${volunteer}/consent.json`))) {
      return error(403, "Accept the terms before submitting.");
    }
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
    const totals = await acceptedTotals(env);
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
    await updateMilestones(env);
  }
  return json(reviewed);
}

// Accepted speech per volunteer, from the accepted/ markers: {volunteer: {recordings, seconds, name}}.
async function acceptedTotals(env) {
  const totals = {};
  for (const marker of await listAll(env, "accepted/", { include: ["customMetadata"] })) {
    const [, volunteer] = marker.key.split("/");
    totals[volunteer] ??= { volunteer, name: marker.customMetadata?.name || null, recordings: 0, seconds: 0 };
    totals[volunteer].recordings += 1;
    totals[volunteer].seconds += Number(marker.customMetadata?.seconds || 0);
  }
  return totals;
}

const DAY_MS = 24 * 60 * 60 * 1000;

async function publicStats(env) {
  const totals = Object.values(await acceptedTotals(env));
  const seconds = totals.reduce((sum, entry) => sum + entry.seconds, 0);
  const milestones = (await readJson(env, "stats/milestones.json")) || {};
  const reached = milestones.minimum_reached_at || null;
  return {
    accepted_minutes: Math.round(seconds / 0.6) / 100,
    volunteers: totals.length,
    minimum_minutes: site.minimum_training_minutes,
    minimum_reached_at: reached,
    earliest_training_at: reached ? new Date(Date.parse(reached) + site.training_wait_days * DAY_MS).toISOString() : null,
    training_wait_days: site.training_wait_days,
  };
}

// Records the first time the accepted speech reaches the training minimum (the waiting month starts then).
async function updateMilestones(env) {
  const stats = await publicStats(env);
  if (!stats.minimum_reached_at && stats.accepted_minutes >= stats.minimum_minutes) {
    await writeJson(env, "stats/milestones.json", { minimum_reached_at: new Date().toISOString(), minimum_minutes: stats.minimum_minutes });
  }
}

async function handleApi(request, env) {
  if (new URL(request.url).pathname === "/api/public/stats" && request.method === "GET") {
    return json(await publicStats(env));
  }
  const email = await volunteerEmail(request, env);
  if (!email) return error(401, "Not signed in. Open the site from your invitation link.");
  const volunteer = await volunteerId(email);
  const path = new URL(request.url).pathname;
  const method = request.method;
  const consentKey = `volunteers/${volunteer}/consent.json`;

  if (path === "/api/me" && method === "GET") {
    const consent = await readJson(env, consentKey);
    return json({
      email,
      volunteer,
      reviewer: isReviewer(email, env),
      admin: isAdmin(email, env),
      reasons: REASONS,
      consent,
      consent_current: consentCurrent(consent),
      terms: { version: CONSENT_VERSION, intro: INTRO, licences: LICENCES, statements: STATEMENTS },
    });
  }

  if (path === "/api/consent" && method === "POST") {
    const previous = await readJson(env, consentKey);
    if (consentCurrent(previous)) return error(409, "You already accepted the current terms.");
    const record = consentRecord(await requestJson(request), email, previous);
    if (record.error) return error(400, record.error);
    await writeJson(env, consentKey, record);
    return json(record, 201);
  }

  if (path === "/api/me/contribution" && method === "GET") {
    const mine = (await acceptedTotals(env))[volunteer] || { recordings: 0, seconds: 0 };
    let waiting = 0;
    let drafts = 0;
    for (const recording of await recordingsOf(env, volunteer)) {
      if (recording.status === "accepted") continue;
      const seconds = (await takesOf(env, volunteer, recording.id)).reduce((sum, take) => sum + take.seconds, 0);
      if (recording.status === "draft") drafts += seconds;
      else waiting += seconds;
    }
    return json({
      accepted_minutes: Math.round(mine.seconds / 0.6) / 100,
      accepted_recordings: mine.recordings,
      waiting_minutes: Math.round(waiting / 0.6) / 100,
      draft_minutes: Math.round(drafts / 0.6) / 100,
      all: await publicStats(env),
    });
  }

  if (path === "/api/me/name" && method === "POST") {
    const consent = await readJson(env, consentKey);
    if (!consent) return error(403, "Choose a licence first.");
    const name = cleanName(((await requestJson(request)) || {}).credit_name);
    if (name === undefined) return error(400, "The name is too long (80 characters at most).");
    if (!name && consent.licence === "CC-BY-4.0") return error(400, "CC BY needs a name to credit you by.");
    const updated = { ...consent, credit_name: name || null, name_changed_at: new Date().toISOString() };
    await writeJson(env, consentKey, updated);
    return json(updated);
  }

  if (path === "/api/me/export" && method === "GET") {
    const recordings = await Promise.all((await recordingsOf(env, volunteer)).map(async (recording) => ({
      ...forVolunteer(recording),
      takes: (await takesOf(env, volunteer, recording.id)).map((take) => ({
        ...take, url: `/api/recordings/${recording.id}/takes/${take.id}`,
      })),
    })));
    const micChecks = await Promise.all((await listAll(env, `mic-checks/${volunteer}/`)).map((o) => readJson(env, o.key)));
    return new Response(JSON.stringify({
      exported_at: new Date().toISOString(),
      email,
      consent: await readJson(env, consentKey),
      recordings,
      mic_checks: micChecks,
    }, null, 2), {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": 'attachment; filename="quenya-voices-my-data.json"',
        "Cache-Control": "no-store",
      },
    });
  }

  if (path === "/api/me" && method === "DELETE") {
    if (((await requestJson(request)) || {}).confirm !== "delete") return error(400, "Confirm with the word delete.");
    for (const prefix of [`volunteers/${volunteer}/`, `recordings/${volunteer}/`, `mic-checks/${volunteer}/`,
      `queue/${volunteer}/`, `accepted/${volunteer}/`]) {
      const keys = (await listAll(env, prefix)).map((object) => object.key);
      for (let i = 0; i < keys.length; i += 1000) await env.TAKES.delete(keys.slice(i, i + 1000));
    }
    // No e-mail here: only the id, so copies already downloaded for training can be found and deleted.
    await writeJson(env, `erasures/${volunteer}.json`, { volunteer, erased_at: new Date().toISOString() });
    let invitation = "not configured";
    if (invitesConfigured(env)) {
      try {
        await changeInvite(env, email, false);
        invitation = "removed";
      } catch (err) {
        console.error(err);
        invitation = "failed";
      }
    }
    return json({ deleted: true, invitation });
  }

  if (path === "/api/mic-check" && method === "POST") {
    const result = (await requestJson(request)) || {};
    const stored = { checked_at: new Date().toISOString(), problems: result.problems, metrics: result.metrics };
    if (JSON.stringify(stored).length > 20000) return error(413, "Too large.");
    await writeJson(env, `mic-checks/${volunteer}/${stored.checked_at}.json`, stored);
    return json({ stored: true }, 201);
  }

  if (path === "/api/admin/invites") {
    if (!isAdmin(email, env)) return error(403, "Only admins can do this.");
    if (!invitesConfigured(env)) return error(501, "Invitations are not set up: see README.md (CF_ACCOUNT_ID, ACCESS_GROUP_ID, CF_API_TOKEN).");
    if (method === "GET") return json({ invites: await listInvites(env) });
    if (method === "POST" || method === "DELETE") {
      const target = ((await requestJson(request)) || {}).email;
      if (!validEmail(target)) return error(400, "That is not an e-mail address.");
      return json({ invites: await changeInvite(env, target, method === "POST") });
    }
    return error(405, "Method not allowed.");
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
    if (!consentCurrent(await readJson(env, consentKey))) return error(403, "Accept the terms before recording.");
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
