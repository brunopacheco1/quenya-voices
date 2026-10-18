// SPDX-FileCopyrightText: 2026 Bruno Pacheco (https://bruno.pacheco.lu)
// SPDX-License-Identifier: Apache-2.0

// The recording page. Licence first; then the volunteer's recordings (one session of the script each); a
// microphone check before recording; then each recording either line by line or from its summary of all lines.
// Every take is checked and uploaded as soon as it stops. A recording is submitted for review when the
// volunteer chooses, complete or not, and is then locked. A reviewer accepts it or sends named lines back with
// a reason; only those lines open again. Reviewers also see the queue of submissions and the accepted totals.

import { TAIL_SECONDS, encodeWav, stripStartup } from "./lib/audio.js";
import { checkMicrophone, checkTake, codes, hasErrors, peakAndClipped } from "./lib/quality.js";
import { parseScript, sessions } from "./lib/script.js";

const $ = (id) => document.getElementById(id);
const VIEWS = ["loading", "signed-out", "consent", "home", "mic-check", "summary", "studio", "review"];
const MIC_SENTENCE = "Elen síla lúmenn' omentielvo.";
const CHECK_NAMES = {
  quiet: "quiet", noisy: "noisy", cut_start: "start may be cut", cut_end: "end may be cut",
  long_pause: "long pause", too_short: "shorter than expected", too_slow: "longer than expected",
};

function show(id) {
  for (const view of VIEWS) $(view).hidden = view !== id;
  window.scrollTo(0, 0);
}

function setMessage(text, warning = false) {
  $("message").textContent = text || "";
  $("message").className = warning ? "warning" : "";
}

function element(tag, properties = {}, ...children) {
  const node = Object.assign(document.createElement(tag), properties);
  node.append(...children);
  return node;
}

function safeStorage(action) {
  try {
    return action(window.localStorage);
  } catch {
    return null;
  }
}

class SignedOut extends Error {}

async function api(path, options = {}) {
  let response;
  try {
    response = await fetch(path, { credentials: "same-origin", ...options });
  } catch {
    throw new Error("no connection, or your sign-in has expired: reload the page");
  }
  if (response.status === 401) {
    show("signed-out");
    throw new SignedOut();
  }
  return response;
}

async function errorText(response) {
  try {
    return (await response.json()).error || `HTTP ${response.status}`;
  } catch {
    return `HTTP ${response.status}`;
  }
}

async function apiJson(path, options) {
  const response = await api(path, options);
  if (!response.ok) throw new Error(await errorText(response));
  return response.json();
}

const date = (iso) => new Date(iso).toLocaleDateString();

function statusText(recording) {
  return {
    draft: "Draft",
    submitted: `Waiting for review (submitted ${date(recording.submitted_at)})`,
    redo: `The reviewer asked to redo ${recording.redo.length} lines`,
    accepted: `Accepted on ${date(recording.reviewed_at)}`,
  }[recording.status];
}

// Lines the volunteer may record now: all of a draft, only the sent-back lines after a review, else none.
function recordableIds(recording) {
  if (recording.status === "draft") return null; // null = all
  return recording.status === "redo" ? new Set(recording.redo) : new Set();
}

const describeChecks = (checks) => checks.split(" ").filter(Boolean).map((code) => CHECK_NAMES[code] || code).join(", ");

// ---- microphone ----

class Microphone {
  async open() {
    if (this.context) return;
    // No processing: echo cancellation, noise suppression and automatic gain all change the voice.
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, sampleRate: 48000, echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    try {
      this.context = new AudioContext({ sampleRate: 48000 });
      this.source = this.context.createMediaStreamSource(this.stream);
    } catch {
      // Firefox cannot connect a microphone running at another rate; record at the microphone's own rate.
      this.context?.close();
      this.context = new AudioContext();
      this.source = this.context.createMediaStreamSource(this.stream);
    }
    await this.context.audioWorklet.addModule("recorder-worklet.js");
    this.node = new AudioWorkletNode(this.context, "capture");
    const silent = this.context.createGain();
    silent.gain.value = 0;
    this.source.connect(this.node).connect(silent).connect(this.context.destination);
    this.node.port.onmessage = (event) => {
      if (event.data === "done") {
        this.finish?.();
      } else {
        this.chunks.push(event.data);
        this.onLevel?.(peakAndClipped(event.data).peak);
      }
    };
  }

  get sampleRate() { return this.context.sampleRate; }
  get settings() { return this.stream.getAudioTracks()[0]?.getSettings() || {}; }

  async start() {
    await this.open();
    await this.context.resume();
    this.chunks = [];
    this.node.port.postMessage("start");
  }

  // Waits `tail` seconds, stops, and returns the take as one Float32Array.
  async stop(tail = TAIL_SECONDS) {
    await new Promise((resolve) => setTimeout(resolve, tail * 1000));
    await new Promise((resolve) => {
      this.finish = resolve;
      this.node.port.postMessage("stop");
    });
    const wave = new Float32Array(this.chunks.reduce((n, chunk) => n + chunk.length, 0));
    let offset = 0;
    for (const chunk of this.chunks) {
      wave.set(chunk, offset);
      offset += chunk.length;
    }
    this.onLevel?.(0);
    return stripStartup(wave);
  }
}

// ---- the app ----

class App {
  constructor(me, lines) {
    this.me = me;
    this.lines = lines;
    this.sessions = sessions(lines);
    this.mic = new Microphone();
    this.micChecked = false;
    this.noiseFloor = null;
    this.audio = new Audio();
    this.state = "idle"; // idle | recording | finishing | saving
    this.recording = null; // {id, session, status, takes: Map(line id -> {checks, seconds}), lines}
    this.takeUrls = new Map(); // line id -> object URL of this visit's or a fetched take
    this.bind();
  }

  bind() {
    $("new-recording").onclick = () => this.startRecording(Number($("new-session").value));
    $("summary-home").onclick = () => this.home();
    $("summary-record").onclick = () => this.openStudio(this.firstToRecord());
    $("summary-submit").onclick = () => this.submit();
    $("summary-delete").onclick = () => this.deleteDraft();
    $("review-home").onclick = () => this.home();
    $("review-accept").onclick = () => this.sendReview("accept");
    $("review-redo").onclick = () => this.sendReview("redo");
    $("studio-summary").onclick = () => this.openSummary();
    $("record").onclick = () => this.toggleRecording();
    $("play").onclick = () => this.playTake(this.line.id);
    $("listen").onclick = () => this.listen(this.line.id);
    $("previous").onclick = () => this.move(-1);
    $("next").onclick = () => this.move(1);
    $("recheck").onclick = () => this.micCheck(() => this.openStudio(this.lineIndex));
    $("check-back").onclick = () => (this.recording ? this.openSummary() : this.home());
    const autoNext = safeStorage((s) => s.getItem("autoNext"));
    if (autoNext !== null) $("auto-next").checked = autoNext === "1";
    $("auto-next").onchange = () => safeStorage((s) => s.setItem("autoNext", $("auto-next").checked ? "1" : "0"));
    document.addEventListener("keydown", (event) => this.key(event));
    window.addEventListener("beforeunload", (event) => {
      if (this.state !== "idle") event.preventDefault();
    });
    this.mic.onLevel = (level) => {
      for (const id of ["meter-level", "check-meter"]) {
        $(id).style.width = `${Math.min(100, level * 100)}%`;
        $(id).classList.toggle("loud", level >= 0.99);
      }
    };
  }

  // -- recordings list --

  async home() {
    this.stopAudio();
    this.recording = null;
    setMessage("");
    const { recordings } = await apiJson("/api/recordings");
    const body = $("recordings").tBodies[0];
    body.replaceChildren(...recordings.map((recording) => {
      const status = statusText(recording);
      const open = element("button", { type: "button", textContent: ["draft", "redo"].includes(recording.status) ? "Continue" : "View" });
      open.onclick = () => this.openRecording(recording.id);
      return element("tr", {},
        element("td", { textContent: recording.session }),
        element("td", { textContent: status }),
        element("td", { textContent: `${recording.recorded} of ${recording.lines}` }),
        element("td", { textContent: new Date(recording.created_at).toLocaleDateString() }),
        element("td", {}, open));
    }));
    $("recordings").hidden = recordings.length === 0;
    $("no-recordings").hidden = recordings.length > 0;
    const submittedCount = (session) => recordings.filter((r) => r.session === session && r.status === "submitted").length;
    const drafts = new Set(recordings.filter((r) => r.status === "draft").map((r) => r.session));
    $("new-session").replaceChildren(...this.sessions.map(([session]) => {
      const notes = [drafts.has(session) ? "draft open" : "", submittedCount(session) ? `submitted ${submittedCount(session)}×` : ""];
      const note = notes.filter(Boolean).join(", ");
      return new Option(note ? `${session} (${note})` : String(session), session);
    }));
    const next = this.sessions.find(([session]) => !drafts.has(session) && !submittedCount(session));
    if (next) $("new-session").value = next[0];
    $("reviewer-home").hidden = !this.me.reviewer;
    if (this.me.reviewer) await this.reviewerHome();
    show("home");
  }

  async reviewerHome() {
    const { waiting, accepted } = await apiJson("/api/review");
    const who = (entry) => entry.name || `volunteer ${entry.volunteer.slice(0, 6)}`;
    $("queue").tBodies[0].replaceChildren(...waiting.map((entry) => {
      const open = element("button", { type: "button", textContent: "Review" });
      open.onclick = () => this.openReview(entry.volunteer, entry.id);
      return element("tr", {},
        element("td", { textContent: who(entry) }),
        element("td", { textContent: entry.session }),
        element("td", { textContent: entry.round }),
        element("td", { textContent: `${entry.recorded} of ${entry.lines}` }),
        element("td", { textContent: date(entry.submitted_at) }),
        element("td", {}, open));
    }));
    $("queue").hidden = waiting.length === 0;
    $("queue-empty").hidden = waiting.length > 0;
    const minutes = (seconds) => (seconds / 60).toFixed(1);
    const total = accepted.reduce((sum, entry) => sum + entry.seconds, 0);
    $("accepted-total").textContent = `${minutes(total)} minutes of accepted speech from ${accepted.length} volunteers.`;
    $("accepted").tBodies[0].replaceChildren(...accepted.map((entry) => element("tr", {},
      element("td", { textContent: who(entry) }),
      element("td", { textContent: entry.recordings }),
      element("td", { textContent: minutes(entry.seconds) }))));
    $("accepted").hidden = accepted.length === 0;
  }

  async startRecording(session) {
    const recording = await apiJson("/api/recordings", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ session }),
    });
    await this.openRecording(recording.id);
  }

  async openRecording(id) {
    const recording = await apiJson(`/api/recordings/${id}`);
    for (const url of this.takeUrls.values()) URL.revokeObjectURL(url);
    this.takeUrls.clear();
    const lines = this.sessions.find(([session]) => session === recording.session)[1];
    const recordable = recordableIds(recording);
    this.recording = {
      ...recording,
      takes: new Map(recording.takes.map((take) => [take.id, take])),
      lines,
      studioLines: recordable ? lines.filter((line) => recordable.has(line.id)) : lines,
    };
    this.openSummary();
  }

  get draft() { return this.recording?.status === "draft"; }
  get open() { return ["draft", "redo"].includes(this.recording?.status); }

  async deleteDraft() {
    const count = this.recording.takes.size;
    if (!window.confirm(`Delete this draft${count ? ` and its ${count} takes` : ""}? This cannot be undone.`)) return;
    const response = await api(`/api/recordings/${this.recording.id}`, { method: "DELETE" });
    if (!response.ok) return setMessage(await errorText(response), true);
    await this.home();
    setMessage("The draft was deleted.");
  }

  // -- summary of all lines --

  openSummary() {
    this.stopAudio();
    const { recording } = this;
    const recorded = recording.lines.filter((line) => recording.takes.has(line.id));
    const flagged = recorded.filter((line) => recording.takes.get(line.id).checks);
    const redone = recording.status === "redo" ? recording.redo.filter((id) => recording.redone.includes(id)).length : 0;
    $("summary-title").textContent = `Session ${recording.session}: ${statusText(recording).toLowerCase()}`;
    $("summary-counts").textContent = `${recorded.length} of ${recording.lines.length} lines recorded`
      + (flagged.length ? `, ${flagged.length} with warnings.` : ".")
      + {
        draft: "",
        redo: ` ${redone} of the ${recording.redo.length} lines sent back are recorded again. Only those lines can change; submit again when they are done.`,
        submitted: " This submission is locked while it waits for review. To record the session again, start a new recording.",
        accepted: " Thank you! This recording is accepted and locked.",
      }[recording.status];
    $("summary-record").hidden = !this.open;
    $("summary-record").textContent = recording.status === "redo" ? "Redo the lines sent back" : "Record line by line";
    $("summary-submit").hidden = !this.open;
    $("summary-submit").textContent = recording.status === "redo" ? "Submit again for review" : "Submit for review";
    $("summary-submit").disabled = recorded.length === 0;
    $("summary-delete").hidden = !this.draft;
    const studioIndex = new Map(recording.studioLines.map((line, index) => [line.id, index]));
    const body = $("lines").tBodies[0];
    body.replaceChildren(...recording.lines.map((line) => {
      const take = recording.takes.get(line.id);
      const review = recording.review?.[line.id];
      const state = element("td", {}, !take ? element("span", { className: "muted", textContent: "not recorded" })
        : take.checks ? element("span", { className: "warning", textContent: `${take.seconds.toFixed(1)} s · ${describeChecks(take.checks)}` })
          : element("span", { className: "ok", textContent: `${take.seconds.toFixed(1)} s · ok` }));
      if (review?.status === "good") state.append(element("span", { className: "ok note", textContent: "accepted by the reviewer" }));
      if (review?.status === "redo" && recording.status === "redo") {
        state.append(element("span", { className: "warning note",
          textContent: `Redo: ${this.me.reasons[review.reason]}. “${review.note}”${recording.redone.includes(line.id) ? " (recorded again)" : ""}` }));
      }
      const actions = element("td", { className: "actions" });
      if (take) {
        const play = element("button", { type: "button", textContent: "Play" });
        play.setAttribute("aria-label", `Play line ${line.id}`);
        play.onclick = () => this.playTake(line.id);
        actions.append(play);
      }
      if (studioIndex.has(line.id) && this.open) {
        const record = element("button", { type: "button", textContent: take ? "Redo" : "Record" });
        record.setAttribute("aria-label", `${take ? "Record again" : "Record"} line ${line.id}`);
        record.onclick = () => this.openStudio(studioIndex.get(line.id));
        actions.append(record);
      }
      return element("tr", {},
        element("td", { textContent: line.id }),
        element("td", {}, element("span", { lang: "qya", textContent: line.text }),
          line.gloss ? element("span", { className: "muted gloss", textContent: line.gloss }) : ""),
        state,
        actions);
    }));
    show("summary");
  }

  async submit() {
    const { recording } = this;
    const warnings = [];
    if (recording.status === "redo") {
      const missing = recording.redo.filter((id) => !recording.redone.includes(id)).length;
      if (missing) warnings.push(`${missing} of the ${recording.redo.length} lines the reviewer sent back are not recorded again yet. The reviewer will hear the old takes.`);
    } else {
      const missing = recording.lines.length - recording.lines.filter((line) => recording.takes.has(line.id)).length;
      if (missing) warnings.push(`${missing} of the ${recording.lines.length} lines have no recording yet. They will stay missing in this submission: to record them later you would start a new recording.`);
    }
    const flagged = [...recording.takes.values()].filter((take) => take.checks).length;
    if (flagged) warnings.push(`${flagged} takes have warnings from the automatic checks; the reviewer may send them back.`);
    const question = [...warnings, "Submit this recording for review? It is locked while it waits for the review."].join("\n\n");
    if (!window.confirm(question)) return;
    const response = await api(`/api/recordings/${recording.id}/submit`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ incomplete_ok: true }),
    });
    if (!response.ok) return setMessage(`Not submitted: ${await errorText(response)}`, true);
    await this.openRecording(recording.id);
    setMessage("Thank you! Your recording was submitted for review.");
  }

  // Index in studioLines of the first line still to record (or record again, after a review).
  firstToRecord() {
    const { recording } = this;
    const todo = recording.status === "redo"
      ? (line) => !recording.redone.includes(line.id)
      : (line) => !recording.takes.has(line.id);
    return Math.max(0, recording.studioLines.findIndex(todo));
  }

  // -- microphone check --

  micCheck(then) {
    this.stopAudio();
    $("check-results").replaceChildren();
    $("check-step").textContent = "";
    $("check-continue").hidden = true;
    $("check-start").disabled = false;
    $("check-start").textContent = "Start the check";
    let phase = "ready";
    $("check-start").onclick = async () => {
      if (phase === "ready") {
        $("check-start").disabled = true;
        $("check-results").replaceChildren();
        $("check-continue").hidden = true;
        try {
          await this.mic.start();
        } catch (err) {
          $("check-step").textContent = `The microphone could not be opened (${err.message}). Allow microphone access for this site and try again.`;
          $("check-start").disabled = false;
          return;
        }
        $("check-step").textContent = "Stay quiet… measuring the room.";
        const silence = await this.mic.stop(3);
        await this.mic.start();
        phase = "speaking";
        $("check-step").textContent = `Now read aloud: ${MIC_SENTENCE} Then press Stop.`;
        $("check-start").textContent = "Stop";
        $("check-start").disabled = false;
        this.silence = silence;
      } else if (phase === "speaking") {
        phase = "ready";
        $("check-start").disabled = true;
        const sentence = await this.mic.stop();
        const result = checkMicrophone(this.silence, sentence, this.mic.sampleRate, { text: MIC_SENTENCE, settings: this.mic.settings });
        api("/api/mic-check", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(result) })
          .catch(() => {});
        this.showCheck(result, then);
      }
    };
    show("mic-check");
  }

  showCheck({ problems, metrics }, then) {
    const items = problems.map((problem) => element("li", { className: problem.level,
      textContent: `${problem.level === "error" ? "Problem" : "Note"}: ${problem.message}` }));
    if (!problems.length) items.push(element("li", { className: "ok", textContent: "Everything sounds fine." }));
    items.push(element("li", { className: "muted",
      textContent: `Room noise ${metrics.roomDb.toFixed(0)} dB, voice ${Number.isFinite(metrics.snrDb) ? metrics.snrDb.toFixed(0) : "?"} dB above it.` }));
    $("check-results").replaceChildren(...items);
    $("check-start").textContent = "Check again";
    $("check-start").disabled = false;
    const go = () => {
      this.micChecked = true;
      this.noiseFloor = 10 ** (metrics.roomDb / 20);
      then();
    };
    if (hasErrors(problems)) {
      $("check-step").textContent = "Please fix the problem above and check again before recording.";
    } else if (problems.length) {
      $("check-step").textContent = "You can record, but fixing the notes above will make your recordings better.";
      $("check-continue").hidden = false;
      $("check-continue").onclick = go;
    } else {
      $("check-step").textContent = "";
      go();
    }
  }

  // -- line by line --

  get line() { return this.recording.studioLines[this.lineIndex]; }

  openStudio(index) {
    if (!this.micChecked) return this.micCheck(() => this.openStudio(index));
    this.lineIndex = index;
    setMessage("");
    show("studio");
    this.render();
  }

  render() {
    const { recording, line } = this;
    const lines = recording.studioLines;
    const redo = recording.status === "redo";
    const done = lines.filter((l) => (redo ? recording.redone.includes(l.id) : recording.takes.has(l.id))).length;
    const take = recording.takes.get(line.id);
    $("session-progress").max = lines.length;
    $("session-progress").value = done;
    $("session-count").textContent = redo
      ? `Session ${recording.session}: ${done} of the ${lines.length} lines sent back recorded again`
      : `Session ${recording.session}: ${done} of ${lines.length} recorded`;
    $("line-position").textContent = `${redo ? "Sent-back line" : "Line"} ${this.lineIndex + 1} of ${lines.length}`;
    $("line-id").textContent = line.id;
    $("line-state").textContent = !take ? "not recorded yet" : take.checks ? `recorded, ${describeChecks(take.checks)}` : "recorded";
    $("line-state").className = take ? (take.checks ? "warning" : "ok") : "";
    $("line-text").textContent = line.text;
    $("line-gloss").textContent = line.gloss ? `(${line.gloss})` : "";
    $("line-ipa").textContent = line.ipa ? `[${line.ipa}]` : "";
    const review = redo && recording.review?.[line.id];
    $("line-redo").textContent = review ? `Reviewer: ${this.me.reasons[review.reason]}. “${review.note}”` : "";
    const busy = this.state !== "idle";
    $("record").textContent = { recording: "Stop", finishing: "Finishing…", saving: "Checking…" }[this.state]
      || (take ? "Record again" : "Record");
    $("record").classList.toggle("recording", this.state === "recording");
    $("record").classList.toggle("primary", this.state !== "recording");
    $("record").disabled = this.state === "finishing" || this.state === "saving";
    $("play").disabled = busy || !take;
    $("listen").disabled = busy;
    $("previous").disabled = busy || this.lineIndex === 0;
    $("next").disabled = busy || this.lineIndex === lines.length - 1;
    $("studio-summary").disabled = busy;
    $("recheck").disabled = busy;
  }

  move(step) {
    if (this.state !== "idle") return;
    const index = this.lineIndex + step;
    if (index < 0 || index >= this.recording.studioLines.length) return;
    this.lineIndex = index;
    this.stopAudio();
    setMessage("");
    this.render();
  }

  async toggleRecording() {
    if (this.state === "idle") {
      this.stopAudio();
      try {
        await this.mic.start();
      } catch (err) {
        setMessage(`The microphone could not be opened (${err.message}). Allow microphone access for this site and try again.`, true);
        return;
      }
      this.state = "recording";
      setMessage("Recording… read the line, then press Stop (or Space).");
      this.render();
    } else if (this.state === "recording") {
      this.state = "finishing";
      this.render();
      const wave = await this.mic.stop();
      await this.save(this.line, wave, this.mic.sampleRate);
    }
  }

  async save(line, wave, sampleRate) {
    this.state = "saving";
    this.render();
    const { problems, metrics } = checkTake(wave, sampleRate, { text: line.text, noiseFloor: this.noiseFloor });
    const seconds = metrics.seconds.toFixed(1);
    const done = (text, warning) => {
      this.state = "idle";
      setMessage(text, warning);
      this.render();
    };
    if (hasErrors(problems)) {
      return done(`Not kept (${seconds} s): ${problems.filter((p) => p.level === "error").map((p) => p.message).join(" ")}`, true);
    }
    const wav = encodeWav(wave, sampleRate);
    let response;
    try {
      response = await api(`/api/recordings/${this.recording.id}/takes/${line.id}`, {
        method: "PUT", headers: { "Content-Type": "audio/wav", "X-Take-Checks": codes(problems) }, body: wav,
      });
    } catch (err) {
      if (err instanceof SignedOut) return;
      return done(`The take was NOT saved (${err.message}). Record it again.`, true);
    }
    if (!response.ok) return done(`The take was NOT saved: ${await errorText(response)} Record it again.`, true);
    const saved = await response.json();
    this.recording.takes.set(line.id, { id: line.id, checks: saved.checks, seconds: metrics.seconds });
    if (this.recording.status === "redo" && !this.recording.redone.includes(line.id)) this.recording.redone.push(line.id);
    this.setTakeUrl(line.id, new Blob([wav], { type: "audio/wav" }));
    if (problems.length) {
      return done(`Saved (${seconds} s), but: ${problems.map((p) => p.message).join(" ")}`, true);
    }
    this.state = "idle";
    if ($("auto-next").checked && line === this.line && this.lineIndex < this.recording.studioLines.length - 1) this.move(1);
    else this.render();
    setMessage(`Saved ${line.id} (${seconds} s).`);
  }

  // -- reviewing --

  async openReview(volunteer, id) {
    this.stopAudio();
    setMessage("");
    const submission = await apiJson(`/api/review/${volunteer}/${id}`);
    const takes = new Map(submission.takes.map((take) => [take.id, take]));
    const lines = this.sessions.find(([session]) => session === submission.session)[1];
    this.reviewing = { volunteer, id, decisions: new Map() };
    const licence = this.me.terms.licences[submission.licence]?.name || "no licence";
    $("review-title").textContent = `Session ${submission.session} by ${submission.name || `volunteer ${volunteer.slice(0, 6)}`}`;
    $("review-info").textContent = `Round ${submission.round}, submitted ${date(submission.submitted_at)}, `
      + `${takes.size} of ${lines.length} lines recorded, shared under ${licence}.`;
    $("review-error").textContent = "";
    const reasons = Object.entries(this.me.reasons);
    $("review-lines").tBodies[0].replaceChildren(...lines.map((line) => {
      const take = takes.get(line.id);
      const earlier = submission.review?.[line.id]?.status === "good";
      const takeCell = element("td", {});
      if (take) {
        const play = element("button", { type: "button", textContent: "Play" });
        play.setAttribute("aria-label", `Play line ${line.id}`);
        play.onclick = () => this.play(`/api/review/${volunteer}/${id}/takes/${line.id}`);
        takeCell.append(play, element("span", { className: take.checks ? "warning note" : "muted note",
          textContent: `${take.seconds.toFixed(1)} s${take.checks ? ` · ${describeChecks(take.checks)}` : ""}` }));
      } else {
        takeCell.append(element("span", { className: "muted", textContent: "not recorded" }));
      }
      const decision = element("td", { className: "decision" });
      if (earlier) {
        decision.append(element("span", { className: "ok", textContent: "accepted in an earlier round" }));
      } else if (take) {
        const name = `decision-${line.id}`;
        const good = element("input", { type: "radio", name, value: "good", checked: true });
        const redo = element("input", { type: "radio", name, value: "redo" });
        const reason = element("select", {}, new Option("Reason…", ""), ...reasons.map(([key, text]) => new Option(text, key)));
        const note = element("textarea", { rows: 2, maxLength: 500, placeholder: "What should change? e.g. stress on the first syllable" });
        reason.setAttribute("aria-label", `Reason to redo line ${line.id}`);
        note.setAttribute("aria-label", `What to change in line ${line.id}`);
        const details = element("div", { hidden: true }, reason, note);
        const update = () => {
          details.hidden = !redo.checked;
          if (redo.checked) this.reviewing.decisions.set(line.id, { reason, note });
          else this.reviewing.decisions.delete(line.id);
          this.updateReviewButtons();
        };
        good.onchange = update;
        redo.onchange = update;
        decision.append(element("label", {}, good, "Good"), element("label", {}, redo, "Redo"), details);
      }
      if (take && submission.status === "submitted" && submission.history?.length) {
        const last = [...submission.history].reverse().find((event) => event.event === "redo_requested");
        if (last?.lines?.includes(line.id)) decision.prepend(element("span", { className: "muted note", textContent: "sent back last round" }));
      }
      return element("tr", {},
        element("td", { textContent: line.id }),
        element("td", {}, element("span", { lang: "qya", textContent: line.text }),
          line.ipa ? element("span", { className: "muted ipa", textContent: `[${line.ipa}]` }) : "",
          line.gloss ? element("span", { className: "muted gloss", textContent: line.gloss }) : ""),
        takeCell,
        decision);
    }));
    this.updateReviewButtons();
    show("review");
  }

  updateReviewButtons() {
    const count = this.reviewing.decisions.size;
    $("review-accept").disabled = count > 0;
    $("review-redo").disabled = count === 0;
    $("review-redo").textContent = count ? `Send ${count} line${count === 1 ? "" : "s"} back for redo` : "Send lines back for redo";
  }

  async sendReview(decision) {
    const redo = {};
    for (const [id, { reason, note }] of this.reviewing.decisions) redo[id] = { reason: reason.value, note: note.value };
    const question = decision === "accept"
      ? "Accept this recording? All its takes will be used for training."
      : `Send ${Object.keys(redo).length} lines back to the volunteer? All other lines are accepted and locked.`;
    if (!window.confirm(question)) return;
    const { volunteer, id } = this.reviewing;
    const response = await api(`/api/review/${volunteer}/${id}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ decision, redo }),
    });
    if (!response.ok) {
      $("review-error").textContent = await errorText(response);
      return;
    }
    await this.home();
    setMessage(decision === "accept" ? "Recording accepted." : "Lines sent back to the volunteer.");
  }

  // -- playing --

  stopAudio() {
    this.audio.pause();
  }

  setTakeUrl(id, blob) {
    if (this.takeUrls.has(id)) URL.revokeObjectURL(this.takeUrls.get(id));
    this.takeUrls.set(id, URL.createObjectURL(blob));
  }

  async play(url) {
    this.stopAudio();
    this.audio = new Audio(url);
    try {
      await this.audio.play();
    } catch (err) {
      setMessage(`Could not play the audio (${err.message}).`, true);
    }
  }

  async playTake(id) {
    if (!this.takeUrls.has(id)) {
      const response = await api(`/api/recordings/${this.recording.id}/takes/${id}`);
      if (!response.ok) return setMessage(await errorText(response), true);
      this.setTakeUrl(id, await response.blob());
    }
    await this.play(this.takeUrls.get(id));
  }

  async listen(id) {
    const response = await api(`/api/reference/${id}`);
    if (!response.ok) return setMessage(`${await errorText(response)} Follow the pronunciation notes under "How to read".`);
    await this.play(URL.createObjectURL(await response.blob()));
  }

  key(event) {
    if ($("studio").hidden) return;
    if (event.target.closest("input, select, textarea") || event.ctrlKey || event.metaKey || event.altKey) return;
    const actions = {
      " ": () => !$("record").disabled && this.toggleRecording(),
      p: () => !$("play").disabled && this.playTake(this.line.id),
      l: () => !$("listen").disabled && this.listen(this.line.id),
      ArrowLeft: () => this.move(-1),
      ArrowRight: () => this.move(1),
    };
    const action = actions[event.key.length === 1 ? event.key.toLowerCase() : event.key];
    if (action) {
      event.preventDefault();
      action();
    }
  }
}

// ---- licence ----

function askConsent(me) {
  return new Promise((resolve) => {
    const { intro, licences, statements } = me.terms;
    $("consent-intro").replaceChildren(...intro.map((text) => element("p", { textContent: text })));
    $("licences").replaceChildren(...Object.entries(licences).map(([id, licence]) => element("label", {},
      element("input", { type: "radio", name: "licence", value: id, required: true }),
      element("span", {}, element("a", { href: licence.url, textContent: licence.name, target: "_blank", rel: "noopener" }),
        `: ${licence.summary}`))));
    $("statements").replaceChildren(...statements.map((statement) => element("label", {},
      element("input", { type: "checkbox", required: true }), statement)));
    const updateHint = () => {
      const byName = $("consent").elements.licence.value === "CC-BY-4.0";
      $("credit-hint").textContent = byName ? "(needed for CC BY; it will be published)" : "(optional, to thank you)";
      $("credit-name").required = byName;
    };
    $("licences").addEventListener("change", updateHint);
    updateHint();
    $("consent").onsubmit = async (event) => {
      event.preventDefault();
      const response = await api("/api/consent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ licence: $("consent").elements.licence.value, credit_name: $("credit-name").value, agree: true }),
      });
      if (!response.ok) {
        $("consent-error").textContent = await errorText(response);
        return;
      }
      resolve(await response.json());
    };
    show("consent");
  });
}

// ---- start ----

window.addEventListener("unhandledrejection", (event) => {
  if (!(event.reason instanceof SignedOut)) setMessage(`Something went wrong: ${event.reason?.message || event.reason}`, true);
});

async function main() {
  try {
    const me = await apiJson("/api/me");
    if (!me.consent) me.consent = await askConsent(me);
    const credit = me.consent.credit_name ? `, credited as ${me.consent.credit_name}` : "";
    $("who").textContent = `Signed in as ${me.email} · your recordings are shared under `
      + `${me.terms.licences[me.consent.licence].name}${credit}.`;
    show("loading");
    const lines = parseScript(await (await fetch("script.tsv")).text());
    await new App(me, lines).home();
  } catch (err) {
    if (err instanceof SignedOut) return;
    show("signed-out");
    $("signed-out-text").textContent = `The site could not load (${err.message}). Please try again later.`;
  }
}

main();
