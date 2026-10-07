#!/bin/sh
# Experimental backend for the existing Ubuntu 22.04 WSL distribution.
set -eu
if [ "$(id -u)" != 0 ]; then
  echo 'Run this setup as root inside the chosen WSL distribution.' >&2
  exit 1
fi
. /etc/os-release
if [ "$ID" != ubuntu ] || [ "$VERSION_ID" != 22.04 ]; then
  echo 'This prototype currently supports Ubuntu 22.04 only.' >&2
  exit 1
fi
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y --no-install-recommends --no-upgrade \
  xvfb openbox mousepad x11-apps xdotool xclip xauth python3-pil fonts-noto-cjk pcmanfm curl ca-certificates
if ! command -v google-chrome-stable >/dev/null 2>&1; then
  # Official Google package over TLS. Never use an unsigned third-party mirror.
  package=$(mktemp /tmp/shikigami-chrome-XXXXXX.deb)
  trap 'rm -f "$package"' EXIT HUP INT TERM
  curl --fail --location --proto '=https' --tlsv1.2 \
    https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb -o "$package"
  test "$(dpkg-deb -f "$package" Package)" = google-chrome-stable
  test "$(dpkg-deb -f "$package" Architecture)" = amd64
  apt-get install -y --no-install-recommends "$package"
fi
# Managed policy read by Google Chrome (google-chrome-stable from Google's .deb) in this distro.
# It blocks file:// so the dedicated Chrome cannot open Windows files under /mnt/c by URL.
# Linux apps' file dialogs can still reach /mnt/c: this is not a sandbox.
policy=/etc/opt/chrome/policies/managed
install -d -m 0755 /etc/opt/chrome /etc/opt/chrome/policies "$policy"
printf '%s\n' '{"URLBlocklist":["file://*"]}' >"$policy/shikigami-lab.json.tmp"
chmod 0644 "$policy/shikigami-lab.json.tmp"
mv -f "$policy/shikigami-lab.json.tmp" "$policy/shikigami-lab.json"
if ! id shikigami-lab >/dev/null 2>&1; then
  useradd --system --create-home --home-dir /var/lib/shikigami-lab \
    --shell /usr/sbin/nologin shikigami-lab
fi
echo 'Ready: a non-admin Linux user and the desktop dependencies are available.'
