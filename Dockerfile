# syntax=docker/dockerfile:1.7

# ----------------------------------------------------------------------
# Build stage: compile TypeScript to dist/
# ----------------------------------------------------------------------
FROM --platform=$BUILDPLATFORM node:26-alpine AS build
WORKDIR /app

COPY package.json package-lock.json* ./
# `npm install` rather than `npm ci` so the build is robust to
# cross-platform lockfile drift - npm's platform-specific optional
# dependencies (e.g. @emnapi on Linux) are written into the lockfile
# only on the platform where `npm install` was last run, which makes
# `npm ci` brittle when the Dockerfile is built locally on Windows /
# macOS. CI installs the same way. This install is for the build stage
# only, and `npm prune --omit=dev`
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

ARG OPA_VERSION=1.22.4
ARG REGAL_VERSION=0.43.0
ARG TARGETARCH

RUN apk add --no-cache curl ca-certificates

# OPA binary, checked against the digest published beside the release. Bump
# the digests with the version. The plain linux builds are statically linked,
# so they run on this musl base; the `_static` copies OPA also publishes are
# the same build under a deprecated name.
RUN set -eux; \
    case "${TARGETARCH}" in \
      amd64) OPA_ASSET="opa_linux_amd64"; \
             OPA_SHA256="b76461cf4db0f77946ef557d727a1da5d7a22ba930844678c9be0bebd2c9d0f6" ;; \
      arm64) OPA_ASSET="opa_linux_arm64"; \
             OPA_SHA256="ea958fca8a657e4ce04df74c9b1c30220b368ddcf75fb3aa50bf306d55775dbf" ;; \
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
             REGAL_SHA256="5e7d030064e307d54e6ffa3d85b8d9052d3d40b7afa10262c86c886f8a76559d" ;; \
      arm64) REGAL_ASSET="regal_Linux_arm64"; \
             REGAL_SHA256="d4fd44a191d5b12a5ab980f56d7eddfed0718129c43d1ede5e8dbc9d217fdcb8" ;; \
      *) echo "Unsupported arch: ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    curl -fsSL -o /usr/local/bin/regal \
      "https://github.com/open-policy-agent/regal/releases/download/v${REGAL_VERSION}/${REGAL_ASSET}"; \
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

# Tells usage stats this copy is the Docker image (see docs/privacy.md).
ENV OPA_MCP_PACKAGING=docker

# stdio transport - no port to expose.
ENTRYPOINT ["node", "/app/dist/server.js"]
