<!--
SPDX-FileCopyrightText: 2026 Bruno Pacheco (https://bruno.pacheco.lu)

SPDX-License-Identifier: CC-BY-4.0
-->

# Quenya Voices

A website where invited volunteers record their voice reading Quenya, Tolkien's High-elven, in the browser,
with nothing to install. The recordings train open Quenya text-to-speech voices in
[Quenya-TTS](https://github.com/brunopacheco1/Quenya-TTS) and give audio to the community book
[*Ma Quetilyë Quenya?*](https://github.com/brunopacheco1/ma-quetilye-quenya).

It runs on Gcore, in Luxembourg: a small Node.js server behind Caddy serves the page and its API, and Gcore's
object storage keeps the recordings, encrypted by the server before they are stored.

## Want to record?

Recording is by invitation. Say hello in the book's
[Volunteer voices](https://github.com/brunopacheco1/ma-quetilye-quenya/issues/38) issue.

## Related projects

- [Quenya-TTS](https://github.com/brunopacheco1/Quenya-TTS): the recording script, the pronunciation rules
  (`quenya_g2p`) and the training code. It downloads the accepted recordings with `python -m quenya_tts.volunteers`.
- [*Ma Quetilyë Quenya?*](https://github.com/brunopacheco1/ma-quetilye-quenya): the book that uses the voices.

## The recording site

### What it does

- **Sign-in by invitation.** Only invited e-mail addresses get in, with a one-time code the site e-mails them.
  Admins invite people on the site's *Invitations* page; removing an invitation signs that person out.
- **Consent first.** Recordings are used only to train open voices and are never published; volunteers can
  download their own and publish them themselves. Before recording, volunteers confirm they are 18 or older, that a
  trained model may still sound somewhat like them, and accept the
  [Terms](legal/terms.html) and [Privacy Notice](legal/privacy.html). When those pages change, everyone accepts
  again before recording.
- **Microphone check** at each visit. Three seconds of silence and one sentence measure the room noise and the
  voice level. The check also notices a Bluetooth-like microphone that cuts high sounds, and a browser that still
  applies noise suppression.
- **Recordings.** One session of the script (100 lines) is one recording. Volunteers record line by line (Space
  to record and stop), or pick lines from a summary of all lines. Every take is checked as soon as it stops. A
  take that is empty, clipped or almost silent is refused. Noise, a cut-off start or end, long pauses, and a length
  that does not fit the text are kept, flagged, and shown. Each take is uploaded as an uncompressed 48 kHz WAV,
  recorded with echo cancellation, noise suppression and automatic gain switched off. Volunteers can play every
  take back, redo it, stop, and go on later. Under each line there is a pronunciation hint in IPA from
  Quenya-TTS's `quenya_g2p`, and *Listen* plays a computer reading if one was uploaded.
- **Submissions.** A recording can be submitted complete or not; the page warns about missing lines. A submitted
  recording is locked. Recording the same session again starts a new, separate submission.
- **Review.** Reviewers (the `REVIEWERS` e-mails) see a queue of submissions. They accept a recording, or send
  named lines back with a reason and a short note on what to change. Only those lines open again for the
  volunteer; every other line is accepted and locked. Volunteers never see each other's recordings, and do not
  see who reviewed theirs.
- **Transparency.** Each volunteer sees their accepted, waiting and draft minutes. The public
  [progress page](legal/stats.html) shows the total accepted minutes against the training minimum, and the earliest
  first-training date.
- **GDPR self-service** under *My data*: download everything as JSON, download all recordings as a ZIP, correct
  the credited name, and delete the account. Deleting removes everything from the storage and ends the
  invitation. It also leaves a marker without the e-mail address, so that Quenya-TTS's `quenya_tts.volunteers download` deletes
  local copies too.

Training rules, as promised on the site: recordings are used only if a reviewer accepted them. Training waits
until all accepted speech together reaches `minimum_training_minutes` (60 by default, in `site.json`). The first
training then waits `training_wait_days` more (30). `python -m quenya_tts.volunteers download --for-training`
refuses to run before then.

### What it costs

Prices from Gcore's pricing pages on 2026-10-18; check them again before relying on them.

| Part | Price | Here |
|---|---|---|
| Virtual machine (1 vCPU, 2 GB, Luxembourg) | about €2–5 a month with its disk and IP | runs the site |
| Object storage, S3 Standard Luxembourg-2 | €0.04 per GB a month, €0.03 per 10,000 requests, €0.02 per GB downloaded | 48 kHz 16-bit mono WAV is about 345 MB per hour of speech: 30 hours cost about €0.40 a month |
| Sign-in e-mails | your mailbox's SMTP | a few e-mails per volunteer |

### Setting it up (once)

You need a Gcore account, a mailbox that can send through SMTP, and a domain name (for example
`voices.tolkien.lu`).

1. **Storage**: in Gcore, *Cloud → Object Storage → Create storage*, type S3, location **Luxembourg-2**. Create a
   bucket `quenya-recordings` in it, keep it private, and note the access key and secret key.
2. **Machine**: *Cloud → Virtual Instances → Create*, region **Luxembourg**, Ubuntu 24.04, the smallest shared
   flavor (1 vCPU, 2 GB), a public IP, and your SSH key. In its security group, allow ports 80 and 443 from
   everywhere, and 22 from your own address only.
3. **DNS**: an `A` record from the site's address to the machine's IP (for `tolkien.lu`, at dns.lu).
4. **Install**: on the machine,

   ```
   curl -fsSLO https://raw.githubusercontent.com/brunopacheco1/quenya-voices/main/deploy/setup.sh
   sudo bash setup.sh voices.tolkien.lu
   ```

   It installs Node.js, Caddy and the site, and starts them. Caddy gets the HTTPS certificate by itself.
5. **Settings**: fill in `/etc/quenya-voices.env` (`sudo nano /etc/quenya-voices.env`; the template explains
   each line), then `sudo systemctl restart quenya-voices`. Make the encryption key with
   `openssl rand -base64 32` and keep a copy in your password manager: without it nobody can read the recordings,
   not even for training.
6. **Legal details**: fill in `site.json`, especially `contact_email`, and check the texts in `legal/`. They are a
   careful draft, not legal advice.

Updating later: `sudo bash /opt/quenya-voices/deploy/setup.sh voices.tolkien.lu` pulls the latest code and
restarts the site; the settings stay. Logs: `journalctl -u quenya-voices`.

The machine keeps no data of its own (everything is in the object storage), so it needs no backups: a new machine
with the same settings is the same site. Microphone checks older than `mic_check_retention_months` and expired
sign-in codes and sessions are deleted every day.

### Running it

- **Invite**: *Invitations* on the site (admins), then send the invitation text it shows. The site itself
  only sends sign-in codes.
The commands with `python -m quenya_tts` run in a [Quenya-TTS](https://github.com/brunopacheco1/Quenya-TTS)
checkout, inside its `.venv`.

- **Listen button**: generate and upload computer readings, one session at a time, on a machine with the reader:
  `python -m quenya_tts.volunteers references --session 1 -o ~/references --upload`. This needs the storage
  settings below.
- **Training data**: the storage settings from `/etc/quenya-voices.env`, then:

  ```
  export STORAGE_ENDPOINT=... STORAGE_REGION=... STORAGE_ACCESS_KEY_ID=... STORAGE_SECRET_ACCESS_KEY=... STORAGE_KEY=...
  python -m quenya_tts.volunteers download -o ~/volunteers --for-training
  ```

  It prints a `prepare_corpus` command for each accepted recording. Run the download before every training,
  because it also deletes the local copies of volunteers who asked for erasure. Treat that folder as the only
  copy outside the storage: any other backup must be refreshed the same way, to keep the erasure promise.

  The recommended way is `python -m quenya_tts.gcore train` in Quenya-TTS: it creates a Gcore GPU machine in the
  EU for one training, fetches the recordings there with this token, and deletes the machine afterwards.
  Recordings never go to Kaggle, which is for development on public data only. If you download them elsewhere,
  keep the folder on an encrypted disk (FileVault on macOS, BitLocker or LUKS elsewhere) and delete it after
  training: the Privacy Notice promises temporary, encrypted copies only.
- **Changing the legal texts**: edit `legal/`, set `last_updated` in `site.json` to the new date, and deploy.
  Everyone is asked to accept again before recording.

### Developing

```
cp .env.example .env   # add a STORAGE_KEY; DEV_EMAIL signs you in on localhost without a code
npm install
npm run dev            # http://localhost:8787; recordings go to .data/, encrypted
npm test               # unit tests of the checks, the reviews, the sign-in, the storage and the API
```

Empty `DEV_EMAIL` to try the sign-in itself: the codes are printed in the terminal instead of e-mailed.

Layout: `public/` is the page (`app.js`; `lib/` is shared with the server: script parsing, WAV encoding, quality
checks, review rules, ZIP). `server.js` serves it and the API; `src/` holds the API (`worker.js`), sign-in
(`auth.js`, `invites.js`, `mail.js`), storage and encryption (`storage.js`) and the consent text (`consent.js`).
`deploy/` has the machine's setup. `legal/` holds the legal pages and the progress page. `build.py` writes `public/script.tsv`
(with IPA) and the filled-in legal pages.

#### The recording script

The lines come from Quenya-TTS (`recording/script.tsv`), and the IPA hints from its `quenya_g2p`. `build.py`
downloads both from the commit named in `QUENYA_TTS_REF` and keeps them in `.cache/`. To build from a local
Quenya-TTS checkout instead, set `QUENYA_TTS_DIR=/path/to/Quenya-TTS`. Update `QUENYA_TTS_REF` with care: once
volunteers have recorded, a line id must keep meaning the same text.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) and the [Code of Conduct](CODE_OF_CONDUCT.md). To report a security or
privacy problem, see [SECURITY.md](SECURITY.md).

## Licence

The code is under the [Apache License 2.0](LICENSE). Documentation and the texts of the site's pages are under
[CC BY 4.0](LICENSES/CC-BY-4.0.txt). Every file states its licence in an SPDX header or in
[REUSE.toml](REUSE.toml), following the [REUSE](https://reuse.software/) specification.

The volunteers' recordings are not part of this repository, and the site never publishes them: they are used only
for training. Published models speak with an artificial voice, are licensed to forbid imitating real people, and
watermark everything they produce (see Quenya-TTS).
