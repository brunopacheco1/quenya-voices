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

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) and the [Code of Conduct](CODE_OF_CONDUCT.md). To report a security or
privacy problem, see [SECURITY.md](SECURITY.md).

## Licence

The code is under the [Apache License 2.0](LICENSE). Documentation and the texts of the site's pages are under
[CC BY 4.0](LICENSES/CC-BY-4.0.txt). Every file states its licence in an SPDX header or in
[REUSE.toml](REUSE.toml), following the [REUSE](https://reuse.software/) specification.

The volunteers' recordings are not part of this repository. Each volunteer chooses on the site whether their
recordings are used only for training, or also published under CC BY 4.0.
