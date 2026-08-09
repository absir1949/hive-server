#!/bin/bash
set -euo pipefail

PID_DIR=/tmp/hive-vnc
X11VNC_PID_FILE="$PID_DIR/x11vnc.pid"
WEBSOCKIFY_PID_FILE="$PID_DIR/websockify.pid"

mkdir -p "$PID_DIR"

is_running() {
  local pid_file="$1"
  [ -f "$pid_file" ] && kill -0 "$(cat "$pid_file")" 2>/dev/null
}

start_process() {
  local pid_file="$1"
  local log_file="$2"
  shift 2

  if is_running "$pid_file"; then
    return
  fi

  rm -f "$pid_file"
  nohup "$@" >"$log_file" 2>&1 &
  local pid=$!
  echo "$pid" >"$pid_file"
  sleep 0.2
  if ! kill -0 "$pid" 2>/dev/null; then
    rm -f "$pid_file"
    echo "Failed to start $1; see $log_file" >&2
    exit 1
  fi
}

stop_process() {
  local pid_file="$1"
  if ! is_running "$pid_file"; then
    rm -f "$pid_file"
    return
  fi

  local pid
  pid="$(cat "$pid_file")"
  kill -TERM "$pid" 2>/dev/null || true
  for _ in $(seq 1 30); do
    if ! kill -0 "$pid" 2>/dev/null; then
      rm -f "$pid_file"
      return
    fi
    sleep 0.1
  done
  kill -KILL "$pid" 2>/dev/null || true
  rm -f "$pid_file"
}

case "${1:-}" in
  start)
    export DISPLAY="${DISPLAY:-:1}"
    start_process "$X11VNC_PID_FILE" /tmp/x11vnc.log \
      x11vnc -display "$DISPLAY" -forever -nopw -rfbport 5900 -q
    start_process "$WEBSOCKIFY_PID_FILE" /tmp/websockify.log \
      websockify --web /usr/share/novnc 6080 localhost:5900
    ;;
  stop)
    # Stop the public websocket first so existing noVNC clients are revoked
    # before the local X11 server is torn down.
    stop_process "$WEBSOCKIFY_PID_FILE"
    stop_process "$X11VNC_PID_FILE"
    ;;
  status)
    is_running "$X11VNC_PID_FILE" && is_running "$WEBSOCKIFY_PID_FILE"
    ;;
  *)
    echo "Usage: $0 {start|stop|status}" >&2
    exit 2
    ;;
esac
