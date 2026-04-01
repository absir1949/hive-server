#!/bin/bash
set -e

# If a command is passed (e.g. "echo image built"), execute it directly and exit.
# This allows the build-only service to exit immediately after image build.
if [ $# -gt 0 ]; then
  exec "$@"
fi

# Clean stale Chrome lock files (left behind when container is killed)
rm -f /data/SingletonLock /data/SingletonSocket /data/SingletonCookie

# --- Xvfb ---
Xvfb :1 -screen 0 1920x1080x24 -ac &
sleep 1

export DISPLAY=:1

# --- Openbox (window manager) ---
# Configure to auto-maximize all windows without decorations
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
openbox --config-file /root/.config/openbox/rc.xml &
sleep 1

# --- Fcitx (Chinese input method) ---
# Start dbus (required by fcitx)
eval $(dbus-launch --sh-syntax)
export GTK_IM_MODULE=fcitx
export QT_IM_MODULE=fcitx
export XMODIFIERS=@im=fcitx
# Ctrl+Space to toggle between English and Chinese pinyin
fcitx -d &
sleep 1

# --- Chrome ---
CHROME_FLAGS=(
  --no-sandbox
  --disable-dev-shm-usage
  --disable-gpu
  --no-first-run
  --no-default-browser-check
  --disable-infobars
  --window-position=0,0
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
CHROME_PID=$!
sleep 2

# --- socat: expose CDP to 0.0.0.0 (Chrome ignores --remote-debugging-address) ---
socat TCP-LISTEN:9222,fork,reuseaddr,bind=0.0.0.0 TCP:127.0.0.1:9223 &

# --- x11vnc + noVNC ---
x11vnc -display :1 -forever -nopw -rfbport 5900 -q &
sleep 1
websockify --web /usr/share/novnc 6080 localhost:5900 &

echo "Hive Chrome ready — CDP :9222, noVNC :6080"

# Keep container alive — wait for Chrome to exit
wait $CHROME_PID
