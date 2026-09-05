# syntax=docker/dockerfile:1.7

# ----------------------------------------------------------------------
# Build stage: compile TypeScript to dist/
# ----------------------------------------------------------------------
FROM --platform=$BUILDPLATFORM node:26-alpine AS build
WORKDIR /app

COPY package.json package-lock.json* ./
# `npm install` rather than `npm ci` so the build is robust to
# cross-platform lockfile drift — npm's platform-specific optional
# dependencies (e.g. @emnapi on Linux) are written into the lockfile
# only on the platform where `npm install` was last run, which makes
# `npm ci` brittle when the Dockerfile is built locally on Windows /
# macOS. CI runs `npm ci` separately for the package itself; this
# install is for the build stage only and `npm prune --omit=dev`
# below trims it back to the production tree before the runtime
# stage copies node_modules in.
RUN npm install --no-audit --no-fund --loglevel=error

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# Trim to production-only deps for the runtime stage.
RUN npm prune --omit=dev

# ----------------------------------------------------------------------
# OPA + Regal binary stage
# ----------------------------------------------------------------------
# Pinned versions. Bumped via Dependabot or manual PR.
FROM alpine:3.24 AS binaries

ARG OPA_VERSION=1.19.0
ARG REGAL_VERSION=0.30.0
ARG TARGETARCH

RUN apk add --no-cache curl ca-certificates

# OPA static binary (linux_amd64 / linux_arm64_static), checked against the
# digest published beside the release. Bump the digests with the version.
RUN set -eux; \
    case "${TARGETARCH}" in \
      amd64) OPA_ASSET="opa_linux_amd64_static"; \
             OPA_SHA256="1dd5c5591ff856f5e20a1d66bafae9511ddf3c5552ed3b5070c70b2b6580ee3f" ;; \
      arm64) OPA_ASSET="opa_linux_arm64_static"; \
             OPA_SHA256="06680087ed236c8c6aaa021660d83178db829a2ad30bdb3482481fada6791b2a" ;; \
      *) echo "Unsupported arch: ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    curl -fsSL -o /usr/local/bin/opa \
      "https://openpolicyagent.org/downloads/v${OPA_VERSION}/${OPA_ASSET}"; \
    echo "${OPA_SHA256}  /usr/local/bin/opa" | sha256sum -c -; \
    chmod +x /usr/local/bin/opa; \
    /usr/local/bin/opa version

# Regal binary, checked against the release's checksums.txt.
RUN set -eux; \
    case "${TARGETARCH}" in \
      amd64) REGAL_ASSET="regal_Linux_x86_64"; \
             REGAL_SHA256="c7d30504a46fbf6d93c88385cea498aa00d032279f606c3ff27a412960523341" ;; \
      arm64) REGAL_ASSET="regal_Linux_arm64"; \
             REGAL_SHA256="8d62165cdda1d856b6b48fb88489b1959d67f398dc3b2dcb8793a5b2ea53c9d3" ;; \
      *) echo "Unsupported arch: ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    curl -fsSL -o /usr/local/bin/regal \
      "https://github.com/StyraInc/regal/releases/download/v${REGAL_VERSION}/${REGAL_ASSET}"; \
    echo "${REGAL_SHA256}  /usr/local/bin/regal" | sha256sum -c -; \
    chmod +x /usr/local/bin/regal; \
    /usr/local/bin/regal version

# ----------------------------------------------------------------------
# Runtime stage: minimal Node + bundled binaries
# ----------------------------------------------------------------------
FROM node:26-alpine AS runtime

LABEL org.opencontainers.image.title="orygn-opa-mcp"
LABEL org.opencontainers.image.description="Model Context Protocol server for Open Policy Agent (OPA)"
LABEL org.opencontainers.image.source="https://github.com/OrygnsCode/opa-mcp-server"
LABEL org.opencontainers.image.url="https://github.com/OrygnsCode/opa-mcp-server"
LABEL org.opencontainers.image.licenses="MIT"
LABEL org.opencontainers.image.vendor="Orygn LLC"

# Ownership marker required by the official MCP Registry to validate
# OCI packages. Without this label, `mcp-publisher publish` rejects
# the OCI entry in server.json with HTTP 400.
LABEL io.modelcontextprotocol.server.name="io.github.OrygnsCode/opa-mcp"

# Run as non-root.
RUN addgroup -g 1001 -S app && adduser -u 1001 -S app -G app

WORKDIR /app

COPY --from=build --chown=app:app /app/dist ./dist
COPY --from=build --chown=app:app /app/node_modules ./node_modules
COPY --from=build --chown=app:app /app/package.json ./
COPY --from=binaries /usr/local/bin/opa /usr/local/bin/opa
COPY --from=binaries /usr/local/bin/regal /usr/local/bin/regal

USER app

# stdio transport — no port to expose.
ENTRYPOINT ["node", "/app/dist/server.js"]
