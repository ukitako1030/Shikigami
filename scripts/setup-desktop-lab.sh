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
  xvfb openbox mousepad x11-apps xdotool xclip xauth python3-pil fonts-noto-cjk
if ! id shikigami-lab >/dev/null 2>&1; then
  useradd --system --create-home --home-dir /var/lib/shikigami-lab \
    --shell /usr/sbin/nologin shikigami-lab
fi
echo 'Ready: a non-admin Linux user and the desktop dependencies are available.'
