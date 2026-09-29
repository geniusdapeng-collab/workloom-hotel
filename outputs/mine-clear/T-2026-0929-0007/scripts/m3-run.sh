#!/usr/bin/env bash
# MCD M3 · 一键可复跑（联动/状态投影保真度 · workloom-hotel · T-2026-0929-0007）
#
#   bash outputs/mine-clear/T-2026-0929-0007/scripts/m3-run.sh
#
# 前置：库 wl_mc_m23 已存在且完成过 M2 运行（未重置），PG17 在 5461。
# 做什么：起三台服务端做"同一代码 × 三种装配"对照——
#   8802 出厂默认（.env，无 SERVICE_C_*）
#   8807 preview:all 口径（SERVICE_C_WORKSPACE_ID=ws-aipm-demo，见 scripts/preview-all.sh:15）
#   8808 全配口径（SERVICE_C_WORKSPACE_ID=ws-yunqi）
#   → 跑 m3-runner.mjs → 全部停服。
# 产物：evidence/m3/m3-report-*.{json,md} + server-m3{,-preview,-configured}.log
set -uo pipefail
REPO="/Users/mac/WorkLoom-fleet/.wt-mc-hotel-m23"
SCRIPT_DIR="$REPO/outputs/mine-clear/T-2026-0929-0007/scripts"
EVIDENCE="$REPO/outputs/mine-clear/T-2026-0929-0007/evidence/m3"
PNPM_WRAP="/Users/mac/Documents/Codex/2026-09-29/https-cnb-cool-workloom-ai-workloom-4/work/bin"
NODE_BIN="/Users/mac/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin"
PG_BIN="/Users/mac/.local/pg17/bin"
export PATH="$PNPM_WRAP:$NODE_BIN:$PG_BIN:$PATH"

DB_NAME="wl_mc_m23"
OWNER_URL="postgres://postgres@127.0.0.1:5461/$DB_NAME"
PORT=8802
mkdir -p "$EVIDENCE"
cd "$REPO" || exit 1

echo "▸ 启动服务端 8802（出厂默认）"
npm_config_verify_deps_before_run=false CI=true ./node_modules/.bin/tsx --env-file=.env apps/server/src/index.ts \
  > "$EVIDENCE/server-m3.log" 2>&1 &
SERVER_PID=$!

echo "▸ 启动服务端 8807（preview:all 口径：SERVICE_C_WORKSPACE_ID=ws-aipm-demo）"
SERVER_PORT=8807 SERVICE_C_WORKSPACE_ID=ws-aipm-demo \
  npm_config_verify_deps_before_run=false CI=true ./node_modules/.bin/tsx --env-file=.env apps/server/src/index.ts \
  > "$EVIDENCE/server-m3-preview.log" 2>&1 &
PREVIEW_PID=$!

echo "▸ 启动服务端 8808（全配口径：SERVICE_C_WORKSPACE_ID=ws-yunqi）"
SERVER_PORT=8808 SERVICE_C_WORKSPACE_ID=ws-yunqi \
  npm_config_verify_deps_before_run=false CI=true ./node_modules/.bin/tsx --env-file=.env apps/server/src/index.ts \
  > "$EVIDENCE/server-m3-configured.log" 2>&1 &
CONFIGURED_PID=$!

cleanup() { kill "$SERVER_PID" "$PREVIEW_PID" "$CONFIGURED_PID" 2>/dev/null; wait "$SERVER_PID" "$PREVIEW_PID" "$CONFIGURED_PID" 2>/dev/null; }
trap cleanup EXIT

for _ in $(seq 1 40); do
  curl -fsS -m 2 "http://127.0.0.1:$PORT/health" >/dev/null 2>&1 && break
  sleep 0.5
done
curl -fsS "http://127.0.0.1:$PORT/health" || { echo "✗ 服务端未就绪"; exit 1; }
for P in 8807 8808; do
  for _ in $(seq 1 40); do
    curl -fsS -m 2 "http://127.0.0.1:$P/health" >/dev/null 2>&1 && break
    sleep 0.5
  done
  curl -fsS "http://127.0.0.1:$P/health" >/dev/null || { echo "✗ 端口 $P 未就绪"; exit 1; }
done
echo

M3_BASE="http://127.0.0.1:$PORT" \
M3_BASE_PREVIEW="http://127.0.0.1:8807" \
M3_BASE_CONFIGURED="http://127.0.0.1:8808" \
DATABASE_URL="$OWNER_URL" \
M3_SERVER_LOG="$EVIDENCE/server-m3.log" \
node "$SCRIPT_DIR/m3-runner.mjs"
RUNNER_EXIT=$?
echo "▸ 停服（pids=${SERVER_PID},${PREVIEW_PID},${CONFIGURED_PID}）"
exit $RUNNER_EXIT
