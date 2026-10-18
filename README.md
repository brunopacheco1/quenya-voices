<!--
SPDX-FileCopyrightText: 2026 Bruno Pacheco (https://bruno.pacheco.lu)

SPDX-License-Identifier: CC-BY-4.0
-->

# Quenya Voices

A website where invited volunteers record their voice reading Quenya, Tolkien's High-elven, in the browser,
with nothing to install. The recordings train open Quenya text-to-speech voices in
[Quenya-TTS](https://github.com/brunopacheco1/Quenya-TTS) and give audio to the community book
[*Ma Quetilyë Quenya?*](https://github.com/brunopacheco1/ma-quetilye-quenya).

It runs on Cloudflare: a Worker serves the page and its API, Cloudflare Access handles invitations and sign-in,
and R2 stores the recordings in the EU.

## Want to record?

Recording is by invitation. Say hello in the book's
[Volunteer voices](https://github.com/brunopacheco1/ma-quetilye-quenya/issues/38) issue.

## Related projects

- [Quenya-TTS](https://github.com/brunopacheco1/Quenya-TTS): the recording script, the pronunciation rules
  (`quenya_g2p`) and the training code. It downloads the accepted recordings with `python -m quenya_tts.volunteers`.
- [*Ma Quetilyë Quenya?*](https://github.com/brunopacheco1/ma-quetilye-quenya): the book that uses the voices.

## The recording site

### What it does

- **Sign-in by invitation.** Only invited e-mail addresses get in. Admins invite people on the site's
  *Invitations* page, or in the Cloudflare dashboard.
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
  the credited name, and delete the account. Deleting removes everything from the bucket and ends the
  invitation. It also leaves a marker without the e-mail address, so that Quenya-TTS's `quenya_tts.volunteers download` deletes
  local copies too.

Training rules, as promised on the site: recordings are used only if a reviewer accepted them. Training waits
until all accepted speech together reaches `minimum_training_minutes` (60 by default, in `site.json`). The first
training then waits `training_wait_days` more (30). `python -m quenya_tts.volunteers download --for-training`
refuses to run before then.

### Free plan limits

R2 checked on 2026-10-18 on Cloudflare's pricing page; the Access and Workers numbers are from Cloudflare's plan pages, so check them again before relying on them:

| Service | Free allowance | What it means here |
|---|---|---|
| R2 storage | 10 GB-month, 1 million writes and 10 million reads a month, no egress fees | 48 kHz 16-bit mono WAV is about 345 MB per hour of speech, so about 29 hours fit |
| Zero Trust (Access) | up to 50 users | 50 volunteers, reviewers and admins together |
| Workers | 100,000 requests a day, 10 ms CPU per request | the server only checks takes cheaply; the page does the heavy checks |

Activating R2 (and sometimes Zero Trust) asks for a payment method even on the free plan. Nothing is charged
while you stay within the allowances above.

### Setting it up (once)

You need a Cloudflare account, Node.js 22 or newer (Wrangler needs it), and Python 3 for the build step. From a clone of this
repository:

```
npm install
npx wrangler login
```

1. **Bucket**, in the EU:

   ```
   npx wrangler r2 bucket create quenya-recordings --jurisdiction eu
   ```

   In the dashboard (R2 → quenya-recordings → Settings → Object lifecycle rules), add a rule that deletes
   objects with the prefix `mic-checks/` after 365 days. That matches `mic_check_retention_months` in `site.json`.

2. **Legal details**: fill in `site.json`, especially `contact_email`, and check the texts in `legal/`. They are
   a careful draft, not legal advice. `build.py` fills them in on every deploy.

3. **Deploy**:

   ```
   npx wrangler deploy
   ```

   It prints the address, `https://quenya-voices.<your-subdomain>.workers.dev`. Until step 4 is done, the API
   refuses everyone.

4. **Access** (Zero Trust in the dashboard; choose a team name and the Free plan the first time):
   1. *Settings → Authentication*: make sure **One-time PIN** is enabled.
   2. *Access → Access groups → Add a group*, named for example *Quenya volunteers*. Under *Include*, add
      *Emails* with your own address. Copy the group's id from its URL.
   3. *Access → Applications → Add an application → Self-hosted*: name it *Quenya Voices* and set the domain to
      the workers.dev address. Add a policy *Allow* that includes the group. Set the session duration to
      1 month, as the Cookie Policy says. After saving, copy the **Application Audience (AUD) tag** from its
      overview.
   4. Add a second self-hosted application, *Quenya Voices public pages*, on the same domain with these paths:
      `privacy`, `privacy.html`, `cookies`, `cookies.html`, `terms`, `terms.html`, `stats`, `stats.html`,
      `stats.js`, `style.css` and `api/public/stats`. Give it a policy with the action **Bypass** and include
      *Everyone*. That way the legal pages and the progress page open without signing in.

5. **Variables**: uncomment `[vars]` in `wrangler.toml` and fill them in, or set them in the dashboard (Worker →
   Settings → Variables and Secrets):

   | Name | Value |
   |---|---|
   | `ACCESS_TEAM_DOMAIN` | `<team>.cloudflareaccess.com` |
   | `ACCESS_AUD` | the AUD tag from step 4.3 |
   | `REVIEWERS` | comma-separated e-mails of reviewers |
   | `ADMINS` | comma-separated e-mails of people who can invite |
   | `CF_ACCOUNT_ID` | your account id (dashboard → Workers & Pages, right column) |
   | `ACCESS_GROUP_ID` | the group id from step 4.2 |

   For the *Invitations* page, create an API token (My Profile → API Tokens → Create custom token). Give it the
   permission *Account → Access: Organizations, Identity Providers, and Groups → Edit*, for this account only.
   Store it as a secret, never in a file:

   ```
   npx wrangler secret put CF_API_TOKEN
   ```

   Then `npx wrangler deploy` again.

The Worker checks the Access token itself, so the API stays closed even if the Access application is switched
off by mistake.

### Running it

- **Invite**: *Invitations* on the site (admins), then send the invitation text it shows. The site sends no e-mails.
The commands with `python -m quenya_tts` run in a [Quenya-TTS](https://github.com/brunopacheco1/Quenya-TTS)
checkout, inside its `.venv`.

- **Listen button**: generate and upload computer readings, one session at a time, on a machine with the reader:
  `python -m quenya_tts.volunteers references --session 1 -o ~/references --upload`. This needs the R2 API
  credentials below.
- **Training data**: create an R2 API token (R2 → Manage API tokens, *Object Read only*, this bucket only),
  then run:

  ```
  export R2_ACCOUNT_ID=... R2_ACCESS_KEY_ID=... R2_SECRET_ACCESS_KEY=...
  python -m quenya_tts.volunteers download -o ~/volunteers --for-training
  ```

  It prints a `prepare_corpus` command for each accepted recording. Run the download before every training,
  because it also deletes the local copies of volunteers who asked for erasure. Treat that folder as the only
  copy outside Cloudflare: any other backup must be refreshed the same way, to keep the erasure promise.

  The recommended way is to let the Kaggle notebook in Quenya-TTS fetch the recordings itself, into a temporary
  folder deleted after the session, with this token stored as a Kaggle Secret. If you download them elsewhere,
  keep the folder on an encrypted disk (FileVault on macOS, BitLocker or LUKS elsewhere) and delete it after
  training: the Privacy Notice promises temporary, encrypted copies only.
- **Changing the legal texts**: edit `legal/`, set `last_updated` in `site.json` to the new date, and deploy.
  Everyone is asked to accept again before recording.

### Developing

```
cp .dev.vars.example .dev.vars   # signs you in as DEV_EMAIL on localhost only
npm run dev                      # http://localhost:8787, with a local bucket
npm test                         # unit tests of the checks, the reviews and the API
```

Add `REVIEWERS` and `ADMINS` with the same address to `.dev.vars` to try the review and invitation pages.

Layout: `public/` is the page (`app.js`; `lib/` is shared with the Worker: script parsing, WAV encoding, quality
checks, review rules, ZIP). `src/` is the Worker (`worker.js` API, `access.js` sign-in check, `consent.js`,
`invites.js`). `legal/` holds the legal pages and the progress page. `build.py` writes `public/script.tsv`
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
