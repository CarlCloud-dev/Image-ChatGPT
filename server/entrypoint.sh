#!/bin/sh
set -eu
if [ "$(id -u)" = 0 ]; then
  if ! command -v x11vnc >/dev/null 2>&1 || ! command -v websockify >/dev/null 2>&1 || ! command -v google-chrome-stable >/dev/null 2>&1; then
    export DEBIAN_FRONTEND=noninteractive
    apt-get update
    apt-get install -y --no-install-recommends x11vnc novnc websockify ca-certificates wget
    if ! command -v google-chrome-stable >/dev/null 2>&1; then
      wget -q -O /tmp/google-chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
      apt-get install -y /tmp/google-chrome.deb
      rm -f /tmp/google-chrome.deb
    fi
    rm -rf /var/lib/apt/lists/*
  fi
  if [ ! -f /app/node_modules/playwright-core/package.json ]; then
    cd /app
    npm ci --omit=dev --ignore-scripts --no-audit --no-fund
  fi
  mkdir -p /data/config /data/logs /data/uploads /data/output
  chown -R pwuser:pwuser /data
  exec su -s /bin/sh pwuser -c '/bin/sh /app/server/entrypoint.sh'
fi
umask 077
mkdir -p /data/config
# Container start happens before the Node service or a managed browser starts.
# Chrome's singleton symlinks can point at a previous container hostname after
# recreation; remove only these known lock/socket entries, never profile data.
for profile in /data/browser_profile /data/browser_profile_edge /data/browser_profile_gemini_chrome /data/browser_profile_gemini_edge; do
if [ -d "$profile" ] && [ ! -L "$profile" ]; then
  for name in SingletonLock SingletonSocket SingletonCookie; do
    entry="$profile/$name"
    if [ -L "$entry" ] || [ -S "$entry" ]; then
      rm -f -- "$entry"
    elif [ -e "$entry" ]; then
      echo "Unexpected browser singleton entry: $name" >&2
      exit 1
    fi
  done
fi
done
Xvfb :99 -screen 0 1280x900x24 -nolisten tcp >/dev/null 2>&1 &
ready=0
for attempt in 1 2 3 4 5 6 7 8 9 10; do
  if [ -S /tmp/.X11-unix/X99 ]; then ready=1; break; fi
  sleep 1
done
[ "$ready" = 1 ] || { echo 'Xvfb did not start' >&2; exit 1; }
x11vnc -display :99 -nopw -forever -shared -listen 127.0.0.1 -rfbport 5900 -bg -o /data/logs/vnc.log
websockify --web /usr/share/novnc 127.0.0.1:6080 127.0.0.1:5900 >> /data/logs/novnc.log 2>&1 &
exec node /app/server/server.js
