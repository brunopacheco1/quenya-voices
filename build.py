# SPDX-FileCopyrightText: 2026 Bruno Pacheco (https://bruno.pacheco.lu)
# SPDX-License-Identifier: Apache-2.0
"""
Prepares the site's static files. Wrangler runs this before every deploy and dev run (wrangler.toml).

- public/script.tsv: the recording script from Quenya-TTS with an ipa column from its quenya_g2p, for the
  pronunciation hint.
- public/privacy.html, cookies.html, terms.html, stats.html: legal/*.html with the values of site.json filled in.

    python3 build.py   # needs only the Python standard library

The script and quenya_g2p come from Quenya-TTS at the commit QUENYA_TTS_REF, downloaded once into
.cache/. To use a local Quenya-TTS checkout instead (offline, or to try a new script), set QUENYA_TTS_DIR.
Changing QUENYA_TTS_REF changes the lines volunteers record: line ids must stay stable once people record.
"""

import csv
import json
import os
import re
import sys
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))

QUENYA_TTS_REPO = "brunopacheco1/Quenya-TTS"
QUENYA_TTS_REF = "347c8c36cd0e1905a834322bc90bc876d57b604d"
QUENYA_TTS_FILES = ["recording/script.tsv", "quenya_g2p/__init__.py", "quenya_g2p/rules.py"]


def quenya_tts():
    """The folder holding the Quenya-TTS files this site needs."""
    local = os.environ.get("QUENYA_TTS_DIR")
    if local:
        return os.path.abspath(os.path.expanduser(local))
    folder = os.path.join(HERE, ".cache", "quenya-tts", QUENYA_TTS_REF)
    for name in QUENYA_TTS_FILES:
        target = os.path.join(folder, name)
        if os.path.exists(target):
            continue
        url = f"https://raw.githubusercontent.com/{QUENYA_TTS_REPO}/{QUENYA_TTS_REF}/{name}"
        print(f"downloading {url}")
        with urllib.request.urlopen(url, timeout=60) as response:
            data = response.read()
        os.makedirs(os.path.dirname(target), exist_ok=True)
        with open(target + ".part", "wb") as f:
            f.write(data)
        os.replace(target + ".part", target)
    return folder


def build_script():
    folder = quenya_tts()
    sys.path.insert(0, folder)
    from quenya_g2p import to_ipa

    source = os.path.join(folder, "recording", "script.tsv")
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
