FROM debian:bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive

# Layer 1: Heavy packages (rarely change, cached)
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    fonts-noto-cjk \
    wget ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Layer 2: KasmVNC (pinned version, cached)
RUN KASMVNC_VER=1.4.0 && \
    ARCH=$(dpkg --print-architecture) && \
    wget -q "https://github.com/kasmtech/KasmVNC/releases/download/v${KASMVNC_VER}/kasmvncserver_bookworm_${KASMVNC_VER}_${ARCH}.deb" -O /tmp/kasmvnc.deb && \
    apt-get update && apt-get install -y --fix-broken /tmp/kasmvnc.deb && \
    rm -f /tmp/kasmvnc.deb && rm -rf /var/lib/apt/lists/*

# Layer 3: Small tools (add new packages here to avoid rebuilding layer 1 & 2)
RUN apt-get update && apt-get install -y --no-install-recommends \
    socat \
    openbox \
    && rm -rf /var/lib/apt/lists/*

EXPOSE 9222 6080
VOLUME /data

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
