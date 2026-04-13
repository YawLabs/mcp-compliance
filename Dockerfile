# syntax=docker/dockerfile:1.7
# Multi-stage build for @yawlabs/mcp-compliance.
# Final image runs `mcp-compliance` as the entrypoint with the latest
# published version baked in. Use --version to override.

# ── builder ──────────────────────────────────────────────────────────
FROM node:22-alpine AS builder
WORKDIR /build

# Install only the published CLI globally — no source build inside
# the image. Pin via build arg if you want a specific version.
ARG MCP_COMPLIANCE_VERSION=latest
RUN npm install -g "@yawlabs/mcp-compliance@${MCP_COMPLIANCE_VERSION}"

# ── runtime ──────────────────────────────────────────────────────────
FROM node:22-alpine
LABEL org.opencontainers.image.title="@yawlabs/mcp-compliance" \
      org.opencontainers.image.description="MCP server compliance testing CLI" \
      org.opencontainers.image.source="https://github.com/YawLabs/mcp-compliance" \
      org.opencontainers.image.licenses="MIT"

# Copy the global install from the builder. /usr/local/lib/node_modules
# holds the package; /usr/local/bin/mcp-compliance is the symlink.
COPY --from=builder /usr/local/lib/node_modules /usr/local/lib/node_modules
COPY --from=builder /usr/local/bin/mcp-compliance /usr/local/bin/mcp-compliance

# Run as a non-root user so child processes spawned via stdio inherit
# minimal privileges. Anyone can `--user 0:0` to escalate if needed.
RUN addgroup -S mcp && adduser -S -G mcp -h /home/mcp mcp
USER mcp
WORKDIR /home/mcp

ENTRYPOINT ["mcp-compliance"]
CMD ["--help"]
