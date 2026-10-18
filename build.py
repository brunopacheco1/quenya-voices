# SPDX-FileCopyrightText: 2026 Bruno Pacheco (https://bruno.pacheco.lu)
# SPDX-License-Identifier: Apache-2.0
"""
Copies the recording script into the site's static files, with an ipa column from quenya_g2p, so the page can
show a pronunciation hint under each line. Wrangler runs this before every deploy and dev run (wrangler.toml).

    python3 build.py   # from recording/web; needs only the Python standard library
"""

import csv
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", ".."))

from quenya_g2p import to_ipa  # noqa: E402


def main():
    source = os.path.join(HERE, "..", "script.tsv")
    target = os.path.join(HERE, "public", "script.tsv")
    with open(source, encoding="utf8", newline="") as f:
        rows = list(csv.DictReader(f, delimiter="\t"))
    columns = list(rows[0].keys()) + ["ipa"]
    with open(target, "w", encoding="utf8", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=columns, delimiter="\t", lineterminator="\n")
        writer.writeheader()
        for row in rows:
            writer.writerow({**row, "ipa": to_ipa(row["text"])})
    print(f"{len(rows)} lines -> {os.path.relpath(target, HERE)}")


if __name__ == "__main__":
    main()
