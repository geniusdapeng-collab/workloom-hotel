#!/usr/bin/env bash
# MCD M2 · 异常注入：依赖（模型端点）挂起
#
#   bash outputs/mine-clear/T-2026-0929-0007/scripts/m2-hang-injection.sh
#
# 做法：起一个"只接受连接、永不回包"的假模型端点（9911），
#       再用 LLM_PROVIDER=openai-compatible + LLM_BASE_URL=http://127.0.0.1:9911/v1
#       启动第二台服务端（8805，共用 wl_mc_m23 库），派一条差评 Quest：
#         - intent 路由预算 12s → 应退化为规则分类（timeout_fallback），不阻塞派遣判定；
#         - quest 规划预算 120s（providers.ts:89 AbortSignal.timeout）→ 挂起期间不得假完成，
#           超时后应回落到装配内确定性规划（planQuestSmart catch）。
# 取证：派遣耗时、响应原文、线程终态、事件流、两端服务日志 → evidence/m2/hang-injection.log
set -uo pipefail
REPO="/Users/mac/WorkLoom-fleet/.wt-mc-hotel-m23"
EVIDENCE="$REPO/outputs/mine-clear/T-2026-0929-0007/evidence/m2"
NODE_BIN="/Users/mac/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin"
export PATH="$NODE_BIN:$PATH"
OUT="$EVIDENCE/hang-injection.log"
mkdir -p "$EVIDENCE"
cd "$REPO" || exit 1

HANG_PORT=9911
APP_PORT=8805

cat > /tmp/m2-hang-endpoint.mjs <<'EOF'
import { createServer } from "node:http";
let n = 0;
createServer((req, res) => {
  n += 1;
  console.log(JSON.stringify({ at: new Date().toISOString(), n, method: req.method, url: req.url, note: "accepted and never responding" }));
  void res; // 永不回包：连接保持打开，模拟依赖挂起
}).listen(9911, "127.0.0.1", () => console.log("hang endpoint up on 9911"));
EOF

node /tmp/m2-hang-endpoint.mjs > "$EVIDENCE/hang-endpoint.log" 2>&1 &
HANG_PID=$!

LLM_PROVIDER=openai-compatible \
LLM_BASE_URL="http://127.0.0.1:$HANG_PORT/v1" \
LLM_API_KEY="sk-hang-injection" \
LLM_MODEL="hang-model-1" \
SERVER_PORT=$APP_PORT \
./node_modules/.bin/tsx --env-file=.env apps/server/src/index.ts > "$EVIDENCE/hang-app-server.log" 2>&1 &
APP_PID=$!

cleanup() { kill "$APP_PID" "$HANG_PID" 2>/dev/null; wait "$APP_PID" "$HANG_PID" 2>/dev/null; }
trap cleanup EXIT

for i in $(seq 1 40); do
  curl -fsS -m 2 "http://127.0.0.1:$APP_PORT/health" >/dev/null 2>&1 && break
  sleep 0.5
done

TOKEN=$(curl -s -X POST "http://127.0.0.1:$APP_PORT/trpc/auth.loginAs" -H 'content-type: application/json' \
  -d '{"workspaceSlug":"yunqi-hotel","memberNo":"MEM-001"}' \
  | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);process.stdout.write(j.result?.data?.token??'')})")

{
  echo "=== M2 依赖挂起注入（模型端点不回包）$(date -u +%FT%TZ) ==="
  echo "模型端点：http://127.0.0.1:$HANG_PORT/v1 （只接受连接、永不回包）"
  echo "应用端口：$APP_PORT  线程标题：依赖挂起探针"
  START_MS=$(node -e "console.log(Date.now())")
  echo "--- 派遣请求（timeout 400s）---"
  RESP=$(curl -s -m 400 -w "\n__HTTP__%{http_code}__TOTAL__%{time_total}" -X POST "http://127.0.0.1:$APP_PORT/trpc/threads.dispatch" \
    -H 'content-type: application/json' -H "authorization: Bearer $TOKEN" \
    -d '{"title":"回复那条 2 分差评（依赖挂起探针）","presetKey":"review-agent","runImmediately":true}')
  echo "$RESP"
  END_MS=$(node -e "console.log(Date.now())")
  echo "派遣墙钟耗时(ms)=$((END_MS - START_MS))"
  echo "--- 挂起端点命中记录 ---"
  cat "$EVIDENCE/hang-endpoint.log"
} | tee "$OUT"

echo "▸ 证据：${OUT}（另见 hang-app-server.log / hang-endpoint.log）"
