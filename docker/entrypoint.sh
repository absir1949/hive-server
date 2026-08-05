#!/bin/bash
set -e

# If a command is passed (e.g. "echo image built"), execute it directly and exit.
if [ $# -gt 0 ]; then
  exec "$@"
fi

# Clean stale Chrome lock files (left behind when container is killed).
rm -f /data/SingletonLock /data/SingletonSocket /data/SingletonCookie

BROWSER_MODE="${BROWSER_MODE:-vnc}"
case "$BROWSER_MODE" in
  vnc|headless) ;;
  *)
    echo "Unsupported BROWSER_MODE: $BROWSER_MODE (expected vnc or headless)" >&2
    exit 1
    ;;
esac

if [ "$BROWSER_MODE" = "vnc" ]; then
  # --- Display and desktop services ---
  Xvfb :1 -screen 0 1920x1080x24 -ac &
  sleep 1
  export DISPLAY=:1

  mkdir -p /root/.config/openbox
  cat > /root/.config/openbox/rc.xml <<'OBXML'
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

  # --- D-Bus and Fcitx (required for Chinese input) ---
  eval $(dbus-launch --sh-syntax)
  export DBUS_SESSION_BUS_ADDRESS
  export GTK_IM_MODULE=fcitx
  export QT_IM_MODULE=fcitx
  export XMODIFIERS=@im=fcitx
  fcitx -d &
  sleep 1

  # Keep X CLIPBOARD and PRIMARY selection in sync for noVNC users.
  autocutsel -selection CLIPBOARD &
  autocutsel -selection PRIMARY &
fi

# --- Chrome ---
CHROME_FLAGS=(
  --no-sandbox
  --disable-dev-shm-usage
  --disable-gpu
  --no-first-run
  --no-default-browser-check
  --disable-infobars
  --window-size=1920,1080
  --disable-background-networking
  --disable-sync
  --remote-debugging-port=9223
  --user-data-dir=/data
)

if [ "$BROWSER_MODE" = "headless" ]; then
  CHROME_FLAGS+=(--headless=new)
else
  CHROME_FLAGS+=(--window-position=0,0)
fi

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

if [ "$BROWSER_MODE" = "vnc" ]; then
  # Force Chrome to re-layout at the actual VNC viewport size.
  xdotool search --class chromium windowsize --sync 800 600
  sleep 0.3
  xdotool search --class chromium windowsize --sync 1920 1080
fi

# Chrome ignores --remote-debugging-address, so expose its loopback CDP port
# through a small TCP forwarder inside the container.
socat TCP-LISTEN:9222,fork,reuseaddr,bind=0.0.0.0 TCP:127.0.0.1:9223 &

if [ "$BROWSER_MODE" = "vnc" ]; then
  # --- x11vnc + noVNC ---
  x11vnc -display :1 -forever -nopw -rfbport 5900 -q &
  sleep 1
  websockify --web /usr/share/novnc 6080 localhost:5900 &
  echo "Hive Chrome ready — mode: vnc, CDP :9222, noVNC :6080"
else
  echo "Hive Chrome ready — mode: headless, CDP :9222"
fi

# Docker sends SIGTERM to PID 1 when a profile changes from VNC to Headless.
# Forward it to Chrome and wait for a clean exit so cookies/localStorage are
# flushed before the container is removed and the next mode starts.
shutdown_chrome() {
  trap - TERM INT
  if kill -0 "$CHROME_PID" 2>/dev/null; then
    kill -TERM "$CHROME_PID" 2>/dev/null || true
    wait "$CHROME_PID" || true
  fi
  exit 0
}

trap shutdown_chrome TERM INT
wait "$CHROME_PID"
