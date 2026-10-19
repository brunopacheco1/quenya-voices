#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Bruno Pacheco (https://bruno.pacheco.lu)
# SPDX-License-Identifier: Apache-2.0

# Sets up the site on a fresh Ubuntu 24.04 machine, as root:
#   curl -fsSLO https://raw.githubusercontent.com/brunopacheco1/quenya-voices/main/deploy/setup.sh
#   sudo bash setup.sh voices.pacheco.lu
# Then fill in /etc/quenya-voices.env and run: sudo systemctl restart quenya-voices
# Running it again is safe: it updates the code and keeps the settings.
set -euo pipefail

DOMAIN="${1:?usage: setup.sh <site address, e.g. voices.pacheco.lu>}"
NODE_MAJOR=22
APP=/opt/quenya-voices

export DEBIAN_FRONTEND=noninteractive
apt-get -qq update
apt-get -qq install -y caddy git python3 curl xz-utils ufw unattended-upgrades > /dev/null

# Node.js from nodejs.org, checked against its published SHA-256
if ! /usr/local/bin/node --version 2>/dev/null | grep -q "^v${NODE_MAJOR}\."; then
    tmp=$(mktemp -d)
    base="https://nodejs.org/dist/latest-v${NODE_MAJOR}.x"
    curl -fsSL "$base/SHASUMS256.txt" -o "$tmp/SHASUMS256.txt"
    file=$(grep -o "node-v[0-9.]*-linux-x64.tar.xz" "$tmp/SHASUMS256.txt" | head -1)
    curl -fsSL "$base/$file" -o "$tmp/$file"
    (cd "$tmp" && grep " $file\$" SHASUMS256.txt | sha256sum -c -)
    tar -xJf "$tmp/$file" -C /usr/local --strip-components=1
    rm -rf "$tmp"
fi

id quenya &>/dev/null || useradd --system --home-dir "$APP" --shell /usr/sbin/nologin quenya
if [ -d "$APP/.git" ]; then
    git -C "$APP" pull -q --ff-only
else
    git clone -q https://github.com/brunopacheco1/quenya-voices.git "$APP"
fi
cd "$APP"
npm ci --omit=dev --no-audit --no-fund
python3 build.py
chown -R root:root "$APP"
chmod -R go-w "$APP"

if [ ! -f /etc/quenya-voices.env ]; then
    install -m 640 -o root -g quenya deploy/quenya-voices.env.example /etc/quenya-voices.env
    echo "Fill in /etc/quenya-voices.env, then: sudo systemctl restart quenya-voices"
fi
install -m 644 deploy/quenya-voices.service /etc/systemd/system/quenya-voices.service
sed "s/SITE_DOMAIN/$DOMAIN/" deploy/Caddyfile > /etc/caddy/Caddyfile

ufw allow OpenSSH > /dev/null
ufw allow http > /dev/null
ufw allow https > /dev/null
ufw --force enable > /dev/null

systemctl daemon-reload
systemctl enable -q quenya-voices caddy
systemctl restart quenya-voices caddy
echo "Done: https://$DOMAIN (DNS must point to this machine for the certificate)."
