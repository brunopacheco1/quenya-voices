<!--
SPDX-FileCopyrightText: 2026 Bruno Pacheco (https://bruno.pacheco.lu)

SPDX-License-Identifier: CC-BY-4.0
-->

# Contributing to Quenya Voices

Thank you for wanting to help! The project is coordinated by Bruno Pacheco
([@brunopacheco1](https://github.com/brunopacheco1)), who approves every merge.

## Ways to help

- **Record your voice.** Ask for an invitation in the book's
  [Volunteer voices](https://github.com/brunopacheco1/ma-quetilye-quenya/issues/38) issue.
- **Report a problem** with the site: open an issue saying what you did, what you expected, and your browser
  and microphone. Never paste recordings, e-mail addresses or other personal data into an issue.
- **Improve the code or the texts** with a pull request.

## Pull requests

1. Open an issue first for anything larger than a small fix, so we can agree on the approach.
2. Keep each pull request to one change, and describe what a volunteer or reviewer will see differently.
3. Run the tests (`npm test`) and the [REUSE](https://reuse.software/) check (`reuse lint`) before you push.
4. Give every new file an SPDX header with its copyright and licence: Apache-2.0 for code, CC-BY-4.0 for
   documentation and page texts. Files that cannot carry a header are listed in [REUSE.toml](REUSE.toml).
5. Never commit secrets (API tokens, `.dev.vars`), recordings or personal data.

### Privacy and legal texts

The site collects voices and e-mail addresses, so it must keep its promises under the GDPR. A change that
affects what is collected, who sees it, how long it is kept or how it is used must update the Privacy Notice,
Cookie Policy or Terms in the same pull request, and set `last_updated` in `site.json` so that volunteers accept
the new version. Say so clearly in the pull request description.

## Code of Conduct

Everyone taking part follows the [Code of Conduct](CODE_OF_CONDUCT.md).

## Licence of contributions

By contributing, you agree that your code is released under the Apache License 2.0 and your documentation and
texts under CC BY 4.0, as stated in their SPDX headers.
