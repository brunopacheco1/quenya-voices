// SPDX-FileCopyrightText: 2026 Bruno Pacheco (https://bruno.pacheco.lu)
// SPDX-License-Identifier: Apache-2.0

// Passes the raw microphone samples to the page while recording. "stop" is answered with "done" after the
// last samples, so the page knows it has them all.
class Capture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.recording = false;
    this.port.onmessage = (event) => {
      this.recording = event.data === "start";
      if (event.data === "stop") this.port.postMessage("done");
    };
  }

  process(inputs) {
    const samples = inputs[0] && inputs[0][0];
    if (this.recording && samples) this.port.postMessage(samples.slice(0));
    return true;
  }
}

registerProcessor("capture", Capture);
