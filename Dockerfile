# syntax=docker/dockerfile:1.7

# ----------------------------------------------------------------------
# Build stage: compile TypeScript to dist/
# ----------------------------------------------------------------------
FROM node:20-alpine AS build
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# Trim to production-only deps for the runtime stage.
RUN npm prune --omit=dev

# ----------------------------------------------------------------------
# OPA + Regal binary stage
# ----------------------------------------------------------------------
# Pinned versions. Bumped via Dependabot or manual PR.
FROM alpine:3.20 AS binaries

ARG OPA_VERSION=0.69.0
ARG REGAL_VERSION=0.30.0
ARG TARGETARCH

RUN apk add --no-cache curl ca-certificates

# OPA static binary (linux_amd64 / linux_arm64_static).
RUN set -eux; \
    case "${TARGETARCH}" in \
      amd64) OPA_ASSET="opa_linux_amd64_static" ;; \
      arm64) OPA_ASSET="opa_linux_arm64_static" ;; \
      *) echo "Unsupported arch: ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    curl -fsSL -o /usr/local/bin/opa \
      "https://openpolicyagent.org/downloads/v${OPA_VERSION}/${OPA_ASSET}"; \
    chmod +x /usr/local/bin/opa; \
    /usr/local/bin/opa version

# Regal binary.
RUN set -eux; \
    case "${TARGETARCH}" in \
      amd64) REGAL_ASSET="regal_Linux_x86_64" ;; \
      arm64) REGAL_ASSET="regal_Linux_arm64" ;; \
      *) echo "Unsupported arch: ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    curl -fsSL -o /usr/local/bin/regal \
      "https://github.com/StyraInc/regal/releases/download/v${REGAL_VERSION}/${REGAL_ASSET}"; \
    chmod +x /usr/local/bin/regal; \
    /usr/local/bin/regal version

# ----------------------------------------------------------------------
# Runtime stage: minimal Node + bundled binaries
# ----------------------------------------------------------------------
FROM node:20-alpine AS runtime

LABEL org.opencontainers.image.title="orygn-opa-mcp"
LABEL org.opencontainers.image.description="Model Context Protocol server for Open Policy Agent (OPA)"
LABEL org.opencontainers.image.source="https://github.com/OrygnsCode/opa-mcp-server"
LABEL org.opencontainers.image.url="https://github.com/OrygnsCode/opa-mcp-server"
LABEL org.opencontainers.image.licenses="MIT"
LABEL org.opencontainers.image.vendor="Orygn"

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
