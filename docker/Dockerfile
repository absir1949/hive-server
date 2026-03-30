FROM debian:bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive

# Layer 1: Heavy packages (rarely change, cached)
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    fonts-noto-cjk \
    && rm -rf /var/lib/apt/lists/*

# Layer 2: Display + VNC stack
RUN apt-get update && apt-get install -y --no-install-recommends \
    xvfb \
    x11vnc \
    websockify \
    openbox \
    xclip \
    socat \
    wget ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# noVNC v1.6.0 (Debian ships 1.3.0 which has broken resize=scale)
RUN wget -q https://github.com/novnc/noVNC/archive/refs/tags/v1.6.0.tar.gz -O /tmp/novnc.tar.gz && \
    mkdir -p /usr/share/novnc && \
    tar -xzf /tmp/novnc.tar.gz -C /usr/share/novnc --strip-components=1 && \
    rm /tmp/novnc.tar.gz && \
    echo '<html><head><meta http-equiv="refresh" content="0;url=vnc_lite.html?scale=true&autoconnect=true"></head></html>' \
    > /usr/share/novnc/index.html

EXPOSE 9222 6080
VOLUME /data

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
