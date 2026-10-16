# The TBO Copilot worker on a Linux server: the engine (host-core, Rust) and the worker (Node) in one image.
# Built on the server itself (arm64 or x86), from the repository root:
#
#   docker build -f apps/tbo-worker/deploy/Dockerfile -t tbo-worker .
#
# How to run it, and where its settings file goes: apps/tbo-worker/deploy/README.md.

FROM rust:1-bookworm AS rust

FROM node:22-bookworm AS build
COPY --from=rust /usr/local/cargo /usr/local/cargo
COPY --from=rust /usr/local/rustup /usr/local/rustup
# Two jobs keep the build inside a 4 GB server's memory.
ENV RUSTUP_HOME=/usr/local/rustup \
    CARGO_HOME=/usr/local/cargo \
    PATH=/usr/local/cargo/bin:$PATH \
    CARGO_BUILD_JOBS=2 \
    CI=true
RUN npm install -g pnpm@12.8.1
WORKDIR /src
COPY . .
# Only the worker and the workspace packages it uses: no desktop app, no Electron.
RUN pnpm install --frozen-lockfile --filter "@tbo/worker..."
RUN pnpm --filter "@tbo/worker..." run build
RUN cargo build --release -p host-core \
    && install -m 0755 target/release/pi-desktop-host-core /usr/local/bin/pi-desktop-host-core \
    && rm -rf target

FROM node:22-bookworm-slim
# git: the worker clones the customer's apps; ssh: the sandbox runner on the fix server (Phase 1c-2).
RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates openssh-client \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /usr/local/bin/pi-desktop-host-core /usr/local/bin/pi-desktop-host-core
COPY --from=build --chown=node:node /src /opt/tbo-copilot
WORKDIR /opt/tbo-copilot
# /data holds the settings file (env), the engine's data, clones, run folders and logs.
ENV TBO_WORKER_DIR=/data \
    TBO_HOST_CORE_BIN=/usr/local/bin/pi-desktop-host-core
USER node
ENTRYPOINT ["node", "apps/tbo-worker/dist/cli.js"]
CMD ["start"]
