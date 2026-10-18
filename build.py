# SPDX-FileCopyrightText: 2026 Bruno Pacheco (https://bruno.pacheco.lu)
# SPDX-License-Identifier: Apache-2.0
"""
Prepares the site's static files. Wrangler runs this before every deploy and dev run (wrangler.toml).

- public/script.tsv: the recording script with an ipa column from quenya_g2p, for the pronunciation hint.
- public/privacy.html, cookies.html, terms.html: legal/*.html with the values of site.json filled in.

    python3 build.py   # from recording/web; needs only the Python standard library
"""

import csv
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", ".."))

from quenya_g2p import to_ipa  # noqa: E402


def build_script():
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
    print(f"{len(rows)} lines -> public/script.tsv")


def fill(template, site):
    def value(match):
        key = match.group(1)
        if key not in site:
            raise KeyError(f"site.json has no {key!r}")
        return str(site[key]) if site[key] != "" else f"[{key} not set in site.json]"
    return re.sub(r"\{\{(\w+)\}\}", value, template)


def build_legal():
    with open(os.path.join(HERE, "site.json"), encoding="utf8") as f:
        site = json.load(f)
    if not site.get("contact_email"):
        print("WARNING: contact_email is empty in site.json; fill it in before inviting anyone.", file=sys.stderr)
    for name in sorted(os.listdir(os.path.join(HERE, "legal"))):
        with open(os.path.join(HERE, "legal", name), encoding="utf8") as f:
            page = fill(f.read(), site)
        with open(os.path.join(HERE, "public", name), "w", encoding="utf8") as f:
            f.write(page)
        print(f"legal/{name} -> public/{name}")


if __name__ == "__main__":
    build_script()
    build_legal()
