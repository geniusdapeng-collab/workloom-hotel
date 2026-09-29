#!/usr/bin/env bash
# MCD M2 · 静态台账运行复现（把 M1 卡升级为运行实锤）
#
#   bash outputs/mine-clear/T-2026-0929-0007/scripts/m2-static-card-repro.sh
#
# 覆盖：
#   MC-012（NUL 字符文本入口）—— POST /trpc/threads.dispatch title 含 \u0000
#   MC-001 关联（CEO 节拍顺序依赖）—— 见 m2-run.sh 的 order-dependence.log（本脚本不复跑）
# 产物：evidence/m2/static-card-repro.log
set -uo pipefail
REPO="/Users/mac/WorkLoom-fleet/.wt-mc-hotel-m23"
EVIDENCE="$REPO/outputs/mine-clear/T-2026-0929-0007/evidence/m2"
PNPM_WRAP="/Users/mac/Documents/Codex/2026-09-29/https-cnb-cool-workloom-ai-workloom-4/work/bin"
NODE_BIN="/Users/mac/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin"
export PATH="$PNPM_WRAP:$NODE_BIN:$PATH"
PORT=8802
OUT="$EVIDENCE/static-card-repro.log"
mkdir -p "$EVIDENCE"
cd "$REPO" || exit 1

CI=true npm_config_verify_deps_before_run=false ./node_modules/.bin/tsx --env-file=.env apps/server/src/index.ts \
  > "$EVIDENCE/server-static-repro.log" 2>&1 &
SERVER_PID=$!
cleanup() { kill "$SERVER_PID" 2>/dev/null; wait "$SERVER_PID" 2>/dev/null; }
trap cleanup EXIT

for _ in $(seq 1 40); do
  curl -fsS -m 2 "http://127.0.0.1:$PORT/health" >/dev/null 2>&1 && break
  sleep 0.5
done

TOKEN=$(curl -s -X POST "http://127.0.0.1:$PORT/trpc/auth.loginAs" -H 'content-type: application/json' \
  -d '{"workspaceSlug":"yunqi-hotel","memberNo":"MEM-001"}' \
  | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);process.stdout.write(j.result?.data?.token??'')})")

{
  echo "=== M2 静态卡运行复现 $(date -u +%FT%TZ) ==="
  echo "--- MC-012：NUL 字符进入文本入口（期望 400，实测见下）---"
  curl -s -m 60 -w "\n__HTTP__%{http_code}__TOTAL__%{time_total}\n" -X POST "http://127.0.0.1:$PORT/trpc/threads.dispatch" \
    -H 'content-type: application/json' -H "authorization: Bearer $TOKEN" \
    --data-binary '{"title":"NUL\u0000注入探针"}'
  echo "--- 服务端日志（该请求相关）---"
  grep -E "threads.dispatch|INTERNAL_SERVER_ERROR|NUL" "$EVIDENCE/server-static-repro.log" | tail -5
} | tee "$OUT"

echo "▸ 证据：${OUT}"
