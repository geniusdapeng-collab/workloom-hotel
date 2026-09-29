#!/usr/bin/env bash
# MCD M2 · 一键可复跑（workloom-hotel · T-2026-0929-0007）
#
#   bash outputs/mine-clear/T-2026-0929-0007/scripts/m2-run.sh [--fresh] [--no-reset]
#
# 做什么：
#   1)（默认）重建隔离库 wl_mc_m23：DROP+CREATE → migrate → seed（--no-reset 跳过，续跑已有环境）
#   2) 用出厂演示配置（.env / LLM_PROVIDER=mock）启动服务端 8802，标准输出落 evidence/m2/server-m2.log
#   3) 顺序依赖探针：全新进程先跑一次 CEO 晨报（记录"规则未装载"时的行为），
#      再跑一次巡检 Quest（触发围栏规则装载）后重跑晨报（记录"规则装载后"的行为）
#   4) 执行 M2 五维矩阵 + 三类错误：node m2-runner.mjs → evidence/m2/m2-report-*.{json,md}
#   5) 结束后停服（脚本自持 PID，不依赖后台会话）
#
# 前置：PG17 在 127.0.0.1:5461（superuser=postgres，本地 trust/空密码），
#       pnpm 10.14.0（packageManager 声明版本，见 work/bin/pnpm 包装），node 24。
set -uo pipefail

REPO="/Users/mac/WorkLoom-fleet/.wt-mc-hotel-m23"
SCRIPT_DIR="$REPO/outputs/mine-clear/T-2026-0929-0007/scripts"
EVIDENCE="$REPO/outputs/mine-clear/T-2026-0929-0007/evidence/m2"
PG_BIN="/Users/mac/.local/pg17/bin"
NODE_BIN="/Users/mac/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin"
PNPM_WRAP="/Users/mac/Documents/Codex/2026-09-29/https-cnb-cool-workloom-ai-workloom-4/work/bin"
export PATH="$PNPM_WRAP:$NODE_BIN:$PG_BIN:$PATH"

DB_NAME="wl_mc_m23"
OWNER_URL="postgres://postgres@127.0.0.1:5461/$DB_NAME"
# 本地审计实例走 trust 认证：URL 不带口令，避免把开发凭据写进脚本/提交（INV-11）
APP_URL="postgres://workloom_app@127.0.0.1:5461/$DB_NAME"
PORT=8802
FRESH=1
[ "${1:-}" = "--no-reset" ] && FRESH=0

mkdir -p "$EVIDENCE"
cd "$REPO" || exit 1

if [ "$FRESH" = "1" ]; then
  echo "▸ 重建隔离库 ${DB_NAME}（DROP+CREATE，仅本任务审计库）"
  psql "postgres://postgres@127.0.0.1:5461/postgres" -q -c "DROP DATABASE IF EXISTS $DB_NAME WITH (FORCE)" \
    && psql "postgres://postgres@127.0.0.1:5461/postgres" -q -c "CREATE DATABASE $DB_NAME"
  if [ $? -ne 0 ]; then echo "✗ 重建数据库失败"; exit 1; fi
fi

echo "▸ 迁移 + 种子"
npm_config_verify_deps_before_run=false CI=true ./node_modules/.bin/tsx --env-file=.env scripts/migrate.ts >/dev/null || { echo "✗ migrate 失败"; exit 1; }
npm_config_verify_deps_before_run=false CI=true ./node_modules/.bin/tsx --env-file=.env scripts/seed.ts >/dev/null || { echo "✗ seed 失败"; exit 1; }

echo "▸ 启动服务端（端口 ${PORT}，出厂演示配置）"
npm_config_verify_deps_before_run=false CI=true ./node_modules/.bin/tsx --env-file=.env apps/server/src/index.ts > "$EVIDENCE/server-m2.log" 2>&1 &
SERVER_PID=$!
cleanup() { kill "$SERVER_PID" 2>/dev/null; wait "$SERVER_PID" 2>/dev/null; }
trap cleanup EXIT

for i in $(seq 1 40); do
  if curl -fsS -m 2 "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then break; fi
  sleep 0.5
done
curl -fsS "http://127.0.0.1:$PORT/health" || { echo "✗ 服务端未就绪"; exit 1; }
echo

TOKEN=$(curl -s -X POST "http://127.0.0.1:$PORT/trpc/auth.loginAs" -H 'content-type: application/json' \
  -d '{"workspaceSlug":"yunqi-hotel","memberNo":"MEM-001"}' \
  | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);process.stdout.write(j.result?.data?.token??'')})")
[ -n "$TOKEN" ] || { echo "✗ 登录失败"; exit 1; }

ORDER_LOG="$EVIDENCE/order-dependence.log"
{
  echo "=== M2 顺序依赖探针（ceo.briefing：规则装载前 vs 装载后）==="
  echo "--- ① 全新进程、未跑过任何 Quest ---"
  curl -s -m 60 -X POST "http://127.0.0.1:$PORT/trpc/captain.runBeat" -H 'content-type: application/json' \
    -H "authorization: Bearer $TOKEN" -d '{"beat":"daily"}'
  echo
  echo "--- ② 先派遣一条巡检 Quest（触发围栏规则装载）---"
  curl -s -m 180 -X POST "http://127.0.0.1:$PORT/trpc/threads.dispatch" -H 'content-type: application/json' \
    -H "authorization: Bearer $TOKEN" \
    -d '{"title":"跑一轮巡检（顺序依赖探针）","presetKey":"inspection-agent","runImmediately":true}'
  echo
  echo "--- ③ 规则装载后，重跑同一节拍 ---"
  curl -s -m 60 -X POST "http://127.0.0.1:$PORT/trpc/captain.runBeat" -H 'content-type: application/json' \
    -H "authorization: Bearer $TOKEN" -d '{"beat":"daily"}'
  echo
} | tee "$ORDER_LOG"

echo "▸ 执行 M2 五维矩阵 + 三类错误"
M2_BASE="http://127.0.0.1:$PORT" \
DATABASE_URL="$OWNER_URL" \
DATABASE_APP_URL="$APP_URL" \
M2_SERVER_LOG="$EVIDENCE/server-m2.log" \
node "$SCRIPT_DIR/m2-runner.mjs"
RUNNER_EXIT=$?

echo "▸ 停服（pid=${SERVER_PID}）"
exit $RUNNER_EXIT
