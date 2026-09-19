#!/usr/bin/env bash
# 售前数字孪生 · 一键恢复（售前现场演示：免 seed/免模拟，30 秒进入「经营中的酒店」）
# 用法：pnpm demo:twin:restore（依赖 demo/twin/yunqi-30d.sql.gz，随仓库分发）
set -euo pipefail
cd "$(dirname "$0")/.."
SNAP=demo/twin/yunqi-30d.sql.gz
[ -f "$SNAP" ] || { echo "❌ 未找到快照 $SNAP（可执行 pnpm db:seed && pnpm demo:twin && pnpm demo:twin:snapshot 重新生成）"; exit 1; }
DB_URL=$(grep -E '^DATABASE_URL=' .env | cut -d= -f2-)
echo "⚠️  将重置本地 workloom 库为「云栖酒店 30 天经营态」快照"
case "${1:-}" in --yes|-y) ;; *) [ -t 0 ] && { read -r -p "确认继续？[y/N] " a; [ "$a" = "y" ] || exit 0; } ;; esac
psql "$DB_URL" -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;" >/dev/null
# macOS 自带 /usr/bin/zcat 只解 .Z（compress）不吃 .gz，统一用可移植的 gzip -dc
gzip -dc "$SNAP" | psql "$DB_URL" -q >/dev/null
EVENTS=$(psql "$DB_URL" -t -c "SELECT count(*) FROM biz_events" | tr -d ' ')
echo "✅ 快照已恢复（事件 ${EVENTS} 条）。启动 pnpm dev 后："
echo "   · P1 晨间简报 / P9 夜班驾驶舱：30 天夜班战报与决策包"
echo "   · P6 技能市场：25 官方技能 + 使用看板/采纳率"
echo "   · P10 断点看板 / P11 价格健康页：根因闭环与倒挂/超售处置留痕"
echo "   · pnpm db:verify-chain 可现场验证全库哈希链（防篡改演示）"
