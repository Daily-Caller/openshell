# syntax=docker/dockerfile:1

# SPDX-FileCopyrightText: Copyright (c) 2025-2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# OpenShell Community base sandbox image
#
# Provides the foundational system tools, users, and developer environment
# that all other community sandbox images build on top of.
#
# Build:  docker build -t openshell-base .

# System base
FROM nvcr.io/nvidia/base/ubuntu:noble-20251013 AS system

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /sandbox

# Core system dependencies
# iproute2: network namespace management (ip netns, veth pairs)
# iptables: legacy bypass detection (kept for transition)
# nftables: bypass detection — log + reject rules for direct connection diagnostics
# dnsutils: dig, nslookup
# Python is managed entirely by uv (see devtools stage).
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        dnsutils \
        iproute2 \
        iptables \
        nftables \
        iputils-ping \
        net-tools \
        netcat-openbsd \
        openssh-sftp-server \
        procps \
        traceroute \
        php-cli \
        ripgrep \
    && rm -rf /var/lib/apt/lists/*

# Create supervisor and sandbox users/groups
RUN groupadd -r supervisor && useradd -r -g supervisor -s /usr/sbin/nologin supervisor && \
    groupadd -r sandbox && useradd -r -g sandbox -d /sandbox -s /bin/bash sandbox

# Developer tools
FROM system AS devtools

# Node.js 22 + build toolchain (needed by npm packages with native addons).
# Pin to a specific patch version for reproducible builds.
# CVE-2026-21637, CVE-2025-59466, CVE-2025-59465, CVE-2025-55131 affect
# Node.js <= 22.22.1. Update to 22.23.0+ when a patched release ships.
#
# npm is upgraded to v11 in the same layer to avoid caching the old npm.
# npm 11 ships tar@^7.5.9, fixing tar@6.2.1 vulns bundled in npm 10
# (GHSA-r6q2-hw4h-h46w, GHSA-8qq5-rm4j-mr97, GHSA-83g3-92jg-28cx,
# GHSA-34x7-hfp2-rc4v, GHSA-qffp-2rhf-9h96).
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && \
    apt-get install -y --no-install-recommends \
        build-essential \
        git \
        nodejs=22.22.1-1nodesource1 \
        vim-tiny \
        nano \
        tmux \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g npm@11.11.0

# Global npm packages — pinned for reproducibility.
# tar + @hono/node-server: transitive vuln fixes
#   (GHSA-qffp-2rhf-9h96, GHSA-9ppj-qmqm-q256, GHSA-8qq5-rm4j-mr97,
#    GHSA-r6q2-hw4h-h46w, GHSA-34x7-hfp2-rc4v, GHSA-83g3-92jg-28cx,
#    GHSA-wc8c-qw6v-h7f6).
# @opencode/cli + @openai/codex: agent CLIs.
RUN npm install -g \
        tar@7.5.11 \
        @hono/node-server@1.19.11 \
        @opencode/cli@2 \
        @openai/codex@0.117.0 \
        @github/copilot@1.0.16

# GitHub CLI
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
        -o /usr/share/keyrings/githubcli-archive-keyring.gpg && \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
        > /etc/apt/sources.list.d/github-cli.list && \
    apt-get update && apt-get install -y --no-install-recommends gh && \
    rm -rf /var/lib/apt/lists/*

# Install Claude CLI via native installer (npm method is deprecated)
RUN curl -fsSL https://claude.ai/install.sh | bash \
    && cp /root/.local/bin/claude /usr/local/bin/claude \
    && chmod 755 /usr/local/bin/claude

# uv (Python package/project manager) — pinned for reproducibility.
# uv manages the Python toolchain; no system Python packages are needed.
COPY --from=ghcr.io/astral-sh/uv:0.10.8 /uv /usr/local/bin/uv
ENV UV_PYTHON_INSTALL_DIR="/sandbox/.uv/python"
RUN uv python install 3.14.3 && \
    ln -s $(uv python find 3.14.3) /usr/local/bin/python3 && \
    ln -s $(uv python find 3.14.3) /usr/local/bin/python && \
    uv cache clean

# Multi-language toolchains — pinned for reproducibility.
# Official tarballs/installers only; clean caches and temp files after each install.
# Binaries are linked into /usr/local/bin so the final-stage PATH picks them up
# without modifying existing ENV lines.
#
# Go 1.24.0: stable release from go.dev. Official linux tarball under
# /usr/local/go. No known critical CVEs at pin time.
#
# Dart 3.7.0: stable SDK from dart.dev storage (Google Cloud dart-archive).
# Provides the standalone dart toolchain alongside Flutter's bundled SDK.
#
# Flutter 3.29.0: stable-channel linux tarball from flutter_infra_release.
# Official archive name is arch-agnostic (x64); arm64 hosts reuse the same pin
# when a matching artifact is published upstream.
#
# Deno 2.2.0: official static binary from GitHub releases (denoland/deno).
# Equivalent to the deno.land install script, without piping to a remote shell.
#
# Rust 1.85.0: pinned default toolchain via rustup for reproducible builds.
# Installed under /usr/local/{rustup,cargo}; cargo registry/git caches stripped.
ENV DART_SDK="/usr/lib/dart" \
    FLUTTER_HOME="/usr/local/flutter" \
    CARGO_HOME="/usr/local/cargo" \
    RUSTUP_HOME="/usr/local/rustup"
RUN set -eux; \
    arch="$(dpkg --print-architecture)"; \
    case "$arch" in \
        amd64) go_arch=amd64; dart_arch=x64; deno_arch=x86_64 ;; \
        arm64) go_arch=arm64; dart_arch=arm64; deno_arch=aarch64 ;; \
        *) echo "unsupported architecture: $arch" >&2; exit 1 ;; \
    esac; \
    # unzip needed for Dart and Deno zip archives
    apt-get update && apt-get install -y --no-install-recommends unzip && \
    rm -rf /var/lib/apt/lists/* && \
    # Go 1.24.0
    curl -fsSL "https://go.dev/dl/go1.24.0.linux-${go_arch}.tar.gz" -o /tmp/go.tar.gz && \
    tar -C /usr/local -xzf /tmp/go.tar.gz && \
    ln -sf /usr/local/go/bin/go /usr/local/bin/go && \
    ln -sf /usr/local/go/bin/gofmt /usr/local/bin/gofmt && \
    rm -f /tmp/go.tar.gz && \
    # Dart 3.7.0
    curl -fsSL "https://storage.googleapis.com/dart-archive/channels/stable/release/3.7.0/sdk/dartsdk-linux-${dart_arch}-release.zip" -o /tmp/dart.zip && \
    unzip -q /tmp/dart.zip -d /usr/lib && \
    mv /usr/lib/dart-sdk /usr/lib/dart && \
    ln -sf /usr/lib/dart/bin/dart /usr/local/bin/dart && \
    rm -f /tmp/dart.zip && \
    # Flutter 3.29.0 (stable)
    curl -fsSL "https://storage.googleapis.com/flutter_infra_release/releases/stable/linux/flutter_linux_3.29.0-stable.tar.xz" -o /tmp/flutter.tar.xz && \
    tar -C /usr/local -xJf /tmp/flutter.tar.xz && \
    ln -sf /usr/local/flutter/bin/flutter /usr/local/bin/flutter && \
    ln -sf /usr/local/flutter/bin/dart /usr/local/bin/flutter-dart && \
    rm -f /tmp/flutter.tar.xz && \
    # Deno 2.2.0
    curl -fsSL "https://github.com/denoland/deno/releases/download/v2.2.0/deno-${deno_arch}-unknown-linux-gnu.zip" -o /tmp/deno.zip && \
    unzip -q /tmp/deno.zip -d /usr/local/bin && \
    chmod 755 /usr/local/bin/deno && \
    rm -f /tmp/deno.zip && \
    # Rust 1.85.0 via rustup
    curl -fsSL https://sh.rustup.rs -o /tmp/rustup-init.sh && \
    sh /tmp/rustup-init.sh -y --default-toolchain 1.85.0 --profile minimal --no-modify-path && \
    ln -sf /usr/local/cargo/bin/cargo /usr/local/bin/cargo && \
    ln -sf /usr/local/cargo/bin/rustc /usr/local/bin/rustc && \
    ln -sf /usr/local/cargo/bin/rustup /usr/local/bin/rustup && \
    rm -f /tmp/rustup-init.sh && \
    rm -rf /usr/local/cargo/registry /usr/local/cargo/git /tmp/*

# Final base image
FROM devtools AS final

# Add venvs to PATH -- /sandbox/.venv (writable, user-installed packages)
# takes priority over system paths.
# VIRTUAL_ENV and UV_PYTHON_INSTALL_DIR are also exported in .bashrc
# so that login shell sessions (interactive and exec) see them.
ENV PATH="/sandbox/.venv/bin:/usr/local/bin:/usr/bin:/bin" \
    VIRTUAL_ENV="/sandbox/.venv"

# Default sandbox network / filesystem policy
COPY policy.yaml /etc/openshell/policy.yaml

# Copy custom skills into the image.
# To add a skill, create a subdirectory under sandboxes/base/skills/
# with a SKILL.md file (and any supporting files). It will be installed into
# both ~/.claude/skills/ and ~/.agents/skills/ for agent discovery.
COPY skills/ /sandbox/.agents/skills/

# Set up sandbox user home directory
RUN mkdir -p /sandbox/.config/opencode /sandbox/.claude/skills && \
    # Create a writable venv using uv-managed Python 3.14.3.
    # Sandbox users can `uv pip install` (or `pip install`) into
    # this venv without touching the base image layer.
    uv venv --python 3.14.3 --seed /sandbox/.venv && \
    uv pip install --python /sandbox/.venv/bin/python cloudpickle && \
    uv cache clean && \
    chown -R sandbox:sandbox /sandbox/.venv && \
    # Minimal shell init files so interactive and non-interactive shells
    # get a sane PATH and prompt.  Without these, bash sources nothing
    # under /sandbox and tools like VS Code Remote-SSH may mis-detect
    # the platform.
    printf 'export PATH="/sandbox/.venv/bin:/usr/local/bin:/usr/bin:/bin"\nexport VIRTUAL_ENV="/sandbox/.venv"\nexport UV_PYTHON_INSTALL_DIR="/sandbox/.uv/python"\nexport PS1="\\u@\\h:\\w\\$ "\n' \
        > /sandbox/.bashrc && \
    printf '[ -f ~/.bashrc ] && . ~/.bashrc\n' > /sandbox/.profile && \
    chown sandbox:sandbox /sandbox/.bashrc /sandbox/.profile && \
    # Symlink skills into agent discovery directories
    for skill in /sandbox/.agents/skills/*/; do \
        [ -d "$skill" ] || continue; \
        ln -sf "$skill" "/sandbox/.claude/skills/$(basename "$skill")"; \
    done && \
    chown -R sandbox:sandbox /sandbox/.config /sandbox/.claude /sandbox/.agents /sandbox

USER sandbox

ENTRYPOINT ["/bin/bash"]
