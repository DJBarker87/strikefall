# syntax=docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e
ARG STRIKEFALL_BUILD_REVISION=unbound
FROM rust:1.85.1-bookworm@sha256:e51d0265072d2d9d5d320f6a44dde6b9ef13653b035098febd68cce8fa7c0bc4 AS builder

WORKDIR /workspace
# The builder tag is already the repository's exact pinned compiler. Omitting
# rust-toolchain.toml here avoids installing the browser-only WASM target.
COPY Cargo.toml Cargo.lock ./
COPY apps ./apps
COPY crates ./crates
COPY tools ./tools
COPY migrations ./migrations
RUN --mount=type=cache,id=strikefall-cargo-registry,target=/usr/local/cargo/registry \
    --mount=type=cache,id=strikefall-cargo-target,target=/workspace/target \
    cargo build --locked --release -p strikefall-round-service \
    && cp /workspace/target/release/strikefall-round-service /tmp/strikefall-round-service

FROM debian:bookworm-slim@sha256:7b140f374b289a7c2befc338f42ebe6441b7ea838a042bbd5acbfca6ec875818 AS runtime
ARG STRIKEFALL_BUILD_REVISION
LABEL org.opencontainers.image.revision=$STRIKEFALL_BUILD_REVISION

RUN apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --system --gid 10001 strikefall \
    && useradd --system --uid 10001 --gid strikefall --home-dir /nonexistent --shell /usr/sbin/nologin strikefall

COPY --from=builder /tmp/strikefall-round-service /usr/local/bin/strikefall-round-service

USER 10001:10001
ENV HOST=0.0.0.0 \
    PORT=3001 \
    RUST_LOG=strikefall_round_service=info,tower_http=info
EXPOSE 3001
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=5 \
    CMD ["curl", "--fail", "--silent", "--show-error", "http://127.0.0.1:3001/health/ready"]
ENTRYPOINT ["/usr/local/bin/strikefall-round-service"]
