#!/bin/bash
set -e

# --- Xvfb ---
Xvfb :99 -screen 0 1920x1080x24 -ac &
sleep 1

# Clean stale Chrome lock files (left behind when container is killed)
rm -f /data/SingletonLock /data/SingletonSocket /data/SingletonCookie

# --- Chrome ---
CHROME_FLAGS=(
  --no-sandbox
  --disable-dev-shm-usage
  --disable-gpu
  --no-first-run
  --no-default-browser-check
  --disable-background-networking
  --disable-sync
  --remote-debugging-port=9223
  --user-data-dir=/data
)

# Optional: proxy
if [ -n "$CHROME_PROXY" ]; then
  CHROME_FLAGS+=(--proxy-server="$CHROME_PROXY")
fi

# Optional: user agent
if [ -n "$CHROME_USER_AGENT" ]; then
  CHROME_FLAGS+=(--user-agent="$CHROME_USER_AGENT")
fi

# Optional: extension
if [ -n "$CHROME_EXTENSION" ]; then
  CHROME_FLAGS+=(--load-extension="$CHROME_EXTENSION")
fi

# Optional: extra flags (space-separated)
if [ -n "$CHROME_EXTRA_FLAGS" ]; then
  read -ra EXTRA <<< "$CHROME_EXTRA_FLAGS"
  CHROME_FLAGS+=("${EXTRA[@]}")
fi

# Start URL (default: about:blank)
CHROME_URL="${CHROME_URL:-about:blank}"

chromium "${CHROME_FLAGS[@]}" "$CHROME_URL" &
sleep 2

# --- socat: expose CDP to 0.0.0.0 (Chrome ignores --remote-debugging-address) ---
socat TCP-LISTEN:9222,fork,reuseaddr,bind=0.0.0.0 TCP:127.0.0.1:9223 &

# --- x11vnc ---
x11vnc -display :99 -forever -nopw -rfbport 5900 -q &
sleep 1

# --- noVNC (websockify) ---
websockify --web /usr/share/novnc 6080 localhost:5900 &

echo "Hive Chrome ready — CDP :9222, noVNC :6080"

# Keep container alive — wait for any child to exit
wait -n
