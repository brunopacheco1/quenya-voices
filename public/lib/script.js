// SPDX-FileCopyrightText: 2026 Bruno Pacheco (https://bruno.pacheco.lu)
// SPDX-License-Identifier: Apache-2.0

// Reads recording/script.tsv (columns id, text, source, gloss and, in the site's copy, ipa; ids like s01_001).
// Shared by the page and the worker.

export const LINE_ID = /^s(\d{2})_(\d{3})$/;

export function parseScript(tsv) {
  const rows = tsv.replace(/\r/g, "").split("\n").filter((row) => row.length > 0);
  const header = rows.shift().split("\t");
  const column = (name) => header.indexOf(name);
  const [id, text, gloss, ipa] = [column("id"), column("text"), column("gloss"), column("ipa")];
  return rows.map((row) => {
    const cells = row.split("\t");
    return { id: cells[id], text: cells[text], gloss: gloss >= 0 ? cells[gloss] || "" : "", ipa: ipa >= 0 ? cells[ipa] || "" : "" };
  }).filter((line) => LINE_ID.test(line.id));
}

export function sessionOf(lineId) {
  return Number(LINE_ID.exec(lineId)[1]);
}

// Returns [[session number, [lines]], ...] in script order.
export function sessions(lines) {
  const bySession = new Map();
  for (const line of lines) {
    const session = sessionOf(line.id);
    if (!bySession.has(session)) bySession.set(session, []);
    bySession.get(session).push(line);
  }
  return [...bySession.entries()];
}
