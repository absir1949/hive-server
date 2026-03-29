FROM debian:bookworm-slim

# Avoid interactive prompts during install
ENV DEBIAN_FRONTEND=noninteractive

# Install Chromium, Xvfb, x11vnc, noVNC, websockify
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    xvfb \
    x11vnc \
    novnc \
    websockify \
    # Fonts for Chinese content
    fonts-noto-cjk \
    # socat: forward 0.0.0.0:9222 → 127.0.0.1:9222 (Chrome ignores --remote-debugging-address)
    socat \
    # xclip: clipboard sharing between x11vnc and Chrome
    xclip \
    # Clean up
    && rm -rf /var/lib/apt/lists/*

# noVNC index redirect — auto-connect with scaling
RUN echo '<html><head><meta http-equiv="refresh" content="0;url=vnc_lite.html?resize=scale&autoconnect=true"></head></html>' \
    > /usr/share/novnc/index.html

# Fixed ports inside container
#   9222 — Chrome DevTools Protocol (CDP)
#   6080 — noVNC web access
EXPOSE 9222 6080

# user-data-dir mount point
VOLUME /data

# Environment variables for Chrome configuration (all optional)
#   CHROME_PROXY        — proxy server, e.g. http://user:pass@host:port
#   CHROME_USER_AGENT   — user agent string override
#   CHROME_EXTENSION    — path to unpacked extension directory
#   CHROME_URL          — URL to open on startup
#   CHROME_EXTRA_FLAGS  — additional Chrome flags
ENV DISPLAY=:99

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
