# Renders assets/demo.tape without installing vhs, ttyd or ffmpeg locally.
#
#   docker build -t dif-demo -f assets/demo.Dockerfile assets
#   docker run --rm -v "$PWD":/vhs dif-demo assets/demo.tape
FROM ghcr.io/charmbracelet/vhs

ARG DIF_VERSION=0.6.3
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl git perl \
 && rm -rf /var/lib/apt/lists/* \
 && case "$(uname -m)" in \
      aarch64|arm64) target=aarch64-unknown-linux-musl ;; \
      *) target=x86_64-unknown-linux-musl ;; \
    esac \
 && cd /tmp \
 && curl -fsSLO "https://github.com/dif-sh/dif/releases/download/v${DIF_VERSION}/dif-${target}.tar.gz" \
 && curl -fsSLO "https://github.com/dif-sh/dif/releases/download/v${DIF_VERSION}/dif-${target}.tar.gz.sha256" \
 && sha256sum -c "dif-${target}.tar.gz.sha256" \
 && tar -xzf "dif-${target}.tar.gz" \
 && install -m 0755 "$(find . -type f -name dif | head -1)" /usr/local/bin/dif \
 && rm -rf /tmp/dif-* \
 && dif --version
