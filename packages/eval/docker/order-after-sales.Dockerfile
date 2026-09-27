FROM oven/bun:1.4.0

RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/bluecode
COPY packages/eval/docker/runtime-package.json ./package.json
COPY tsconfig.base.json ./tsconfig.base.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/contracts/tsconfig.json packages/contracts/tsconfig.json
COPY packages/contracts/src packages/contracts/src
COPY packages/shared/package.json packages/shared/package.json
COPY packages/shared/tsconfig.json packages/shared/tsconfig.json
COPY packages/shared/src packages/shared/src
COPY packages/rtk-core/package.json packages/rtk-core/package.json
COPY packages/rtk-core/tsconfig.json packages/rtk-core/tsconfig.json
COPY packages/rtk-core/src packages/rtk-core/src
COPY packages/security-core/package.json packages/security-core/package.json
COPY packages/security-core/tsconfig.json packages/security-core/tsconfig.json
COPY packages/security-core/src packages/security-core/src
COPY packages/rtk/package.json packages/rtk/package.json
COPY packages/rtk/tsconfig.json packages/rtk/tsconfig.json
COPY packages/rtk/src packages/rtk/src
COPY packages/headroomd/package.json packages/headroomd/package.json
COPY packages/headroomd/tsconfig.json packages/headroomd/tsconfig.json
COPY packages/headroomd/src packages/headroomd/src
COPY packages/vsecagent/package.json packages/vsecagent/package.json
COPY packages/vsecagent/tsconfig.json packages/vsecagent/tsconfig.json
COPY packages/vsecagent/src packages/vsecagent/src
COPY packages/plugin/package.json packages/plugin/package.json
COPY packages/plugin/tsconfig.json packages/plugin/tsconfig.json
COPY packages/plugin/src packages/plugin/src
RUN bun install --production && bun install -g opencode-ai@1.18.23 && \
    opencode --version
ENV BUN_RUNTIME_TRANSPILER_CACHE_PATH=0
WORKDIR /workspace
