#!/bin/bash
set -e

# Clean stale Chrome lock files (left behind when container is killed)
rm -f /data/SingletonLock /data/SingletonSocket /data/SingletonCookie

# --- KasmVNC (replaces Xvfb + x11vnc + noVNC) ---
# Use Xvnc directly (skip the interactive Perl wrapper)
#   - Built-in X server (no Xvfb needed)
#   - Built-in web client on websocketPort
#   - Native clipboard, dynamic resize, WebP encoding
Xvnc :1 \
  -geometry 1920x1080 -depth 24 \
  -websocketPort 6080 \
  -interface 0.0.0.0 \
  -SecurityTypes None \
  -disableBasicAuth \
  -sslOnly 0 \
  -AcceptCutText 1 \
  -SendCutText 1 \
  -httpd /usr/share/kasmvnc/www \
  &
sleep 2

export DISPLAY=:1

# --- Openbox (window manager) ---
# Configure to maximize all windows automatically
mkdir -p /root/.config/openbox
cat > /root/.config/openbox/rc.xml << 'OBXML'
<?xml version="1.0" encoding="UTF-8"?>
<openbox_config xmlns="http://openbox.org/3.4/rc">
  <applications>
    <application class="*">
      <maximized>yes</maximized>
      <decor>no</decor>
    </application>
  </applications>
</openbox_config>
OBXML
openbox &
sleep 1

# --- Chrome ---
CHROME_FLAGS=(
  --no-sandbox
  --disable-dev-shm-usage
  --disable-gpu
  --no-first-run
  --no-default-browser-check
  --start-maximized
  --window-size=1920,1080
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

echo "Hive Chrome ready — CDP :9222, KasmVNC :6080"

# Keep container alive — wait for any child to exit
wait -n
