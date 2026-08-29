# 硬编码排查报告（workloom-hotel / WorkLoom 酒店版）

> 排查日期：2026-08-29 · 方法：六类维度自动扫描（`scripts/hardcode-scan.mjs`）→ 白名单过滤 → 逐条语义复核
> 范围：apps/（server+web）、packages/（base/runtime/shared/db）、bundles/、scripts/、.github/
> 结果：候选 924 条 → 白名单豁免 749 条 → 疑似 175 条逐条复核 → **真问题 10 项（已全部修复）+ 测试魔法数 2 处（已一并治理）**

## 一、复核结论总表

| 类别 | 疑似数 | 真问题 | 判定 |
|---|---|---|---|
| A 环境配置 | 93 | 0 | 全部为 CI 连接串、本地开发脚本默认值（有 env 兜底）、LLM/微信官方端点预设、npm 镜像、oss-components 上游清单、dsh-gate 本机地址——标准实践，豁免 |
| B 身份演示 | 21 | **3** | trpc.ts 演示登录写死 slug+MEM-001（P1）、P7 草稿写死 MEM-001（P1）、P1 页写死演示身份号码（P2→顺手修）；其余为 demo/twin-genie/release-gate/eval 等脚本口径（豁免） |
| C 密钥凭据 | 0 | 0 | 全仓无明文密钥（25 条候选全在白名单内） |
| D 行业泄漏 | 2 | **3** | runtime planQuest 残留 ai-video/geo-growth 内容域分支（抖音/TikTok/小红书正则，P1）、runtime DEMO_TOOLS 残留内容域五工具（P1）、audit-core 注释 SKU 举例（P2→顺手修）；另 8 处底座通用逻辑注释/标识酒店词中性化（顺手修） |
| E 规则外溢 | 6 | 0 | charter.ts 自治额度 5000/2000 经行业语境判定**保留**（见下）；E8.3 校准系数 ×2 为有注释依据的产品逻辑常量（豁免）；P6 阈值渲染为动态数据（豁免） |
| F 文案展示 | 53 | **1** | "Agent ID" 未中文化（P2→顺手修）；OCC/ADR/API Key 为行业通用术语（豁免）；owner/manager/readonly 为枚举值且 P8 有中文映射字典（豁免） |

## 二、修复清单（10+2 项，全部完成）

| # | 级别 | 位置 | 问题 | 修法 |
|---|---|---|---|---|
| 1 | P1 | `apps/web/src/lib/trpc.ts` | 演示登录写死 `workspaceSlug: "yunqi-hotel"` + `MEM-001`——客户自建工作区时演示登录即坏 | 抽为 `VITE_DEMO_WORKSPACE` / `VITE_DEMO_MEMBER` env 可配（保留默认值兜底） |
| 2 | P1 | `apps/web/src/pages/p7/P7.tsx` | 技能发布草稿 `ownerMemberNo: "MEM-001"` 写死（含提交后重置处） | 默认空，页面加载时以当前登录身份 `members.me.identity.memberNo` 填充；重置亦置空 |
| 3 | P1 | `packages/runtime/src/loop.ts` | `planQuest` 残留 ai-video/geo-growth 内容域分支（测评片/短视频/小红书/抖音/TikTok/GEO 正则 + 五步生产链）——跨行业残留在底座 runtime | 整支移除（仓内无测试/种子依赖，回退默认只读巡检单步） |
| 4 | P1 | `packages/runtime/src/tools.ts` | `DEMO_TOOLS` 残留内容域五工具（intel.collect/script.draft/content.submit/publish.execute/metrics.collect，含 `platform ?? "tiktok"`）——同属跨行业残留 | 五个工具整组移除（仅 display.ts 字典标签与 release-gate 脚本提及，无功能依赖） |
| 5 | P2 | `apps/web/src/pages/p1/P1.tsx` | 文案写死"演示身份 MEM-001" | 去除写死号码，显示实际身份名 |
| 6 | P2 | `apps/web/src/pages/p8/P8.tsx` | "Agent ID" 英文直出 | 中文化"员工编号" |
| 7 | P2 | `packages/base/audit-core/types.ts` | 注释以"该SKU该渠道销量"举例（底座 D18 行业无关纪律；index.ts 头部此前已中性化） | 改为"该对象该渠道量"中性表述 |
| 8 | P2 | `scripts/suite.ts` NLU 夹具 | quest 句式混入社媒内容域句式"生成下周小红书文案"（geo-growth 方向残留） | 替换为酒店句式"生成下周连住优惠方案"，路由断言不变 |
| 9 | P2 | `packages/runtime/src/loop.ts` | 注释 `hotel-baseline default_level`；事件 `model_trace.model_id: "mock-hotel-001"` | 注释改"行业基线"；model_id 改 `mock-agent-001`（suite 不对该值跨断言） |
| 10 | P2 | 底座通用逻辑 7 处注释 | `fence-engine/judge.ts`（bundles/hotel 路径）、`model-router/router.ts`（酒店演示口径）、`runtime/ask.ts`（如酒店的…）、`runtime/assembly.ts`（bundles/hotel presets）、`workdata/recall.ts`×2（酒店枚举）、`night-shift/candidates.ts`×2（酒店版模板） | 通用逻辑里的行业词全部改中性表述（纯注释/文案，无语义变化）；`service-dialog/dialog.ts` mock 兜底文案去"云栖酒店"品牌化 |
| 11 | 治理 | `packages/base/captain/captain.test.ts` | 断言绑死默认值魔法数（5000/2500/6000/3000/2000/4000…）——默认值行业化调整即破 | 引入 `CAP = defaultCharter().autonomy.procurement_cap`，断言全部动态化（CAP 模式） |
| 12 | 治理 | `packages/base/captain/captain-v2.test.ts` | 同上（5000/12000/800/3000） | 同上（CAP/CAP×2+1000/CAP×0.16/CAP×0.6） |

附带工程修复：`scripts/suite.ts` HTTP 端口 `8787` 写死——多仓并行时被他仓 server 占用即 401 连环失败（多环境会错）。改为 `SUITE_PORT` env 可配（默认 8787 不变）。

## 三、保留判定：charter.ts 自治额度 5000/2000

`packages/base/captain/charter.ts` 默认 `procurement_cap: 5000 / campaign_cap: 2000` **保留不改**。判定依据：酒店行业语境下单间夜数百元（种子房价 ¥458–688）、布草/耗材采购与单次营销活动量级小，5000/2000 与种子数据及围栏阈值（R4 退款≥¥500 必审）同口径；电商仓调整为 100_000/50_000 是电商量级，方向不可照搬。默认值行业化差异正是 CAP 动态化要保护的场景。

## 四、记录项（P2 架构观察，不在本次范围）

底座包存在**行业域模块整体驻留**的历史耦合（非通用逻辑夹带行业词，而是酒店域实现住在 `packages/base`）：`service-ticket/constants.ts`（客房部/工程部路由表）、`inspection/checks.ts`（默认酒店四检/roomType 探针）、`service-kb/search.ts` 弱词表与 `service-dialog/intents.ts` KB 意图词（早餐/退房/入住）、`night-shift` 模板、`runtime/tools.ts` 酒店演示剧本数据（与种子同源）、`captain/loop.ts` 回测 KPI 源写死 `occ`/`store.daily.summary`、`db` 租户 `industry` 默认值 `'hotel'`。中性化需"行业槽位化"重构（配置下沉 bundles/hotel），属架构任务卡，逐项改动收益低风险高，本次仅记录。

## 五、豁免判定摘录（代表性）

- **CI 连接串**（.github/workflows/ci.yml）：CI postgres service 标准做法
- **本地开发脚本**（doctor.sh/reset.sh/preview-all.sh/dev-note.js/twin-genie.ts 等）：localhost 提示与默认值，均有 env 兜底
- **第三方官方端点**（api.weixin.qq.com、api.deepseek.com 等 LLM 预设、registry.npmmirror.com）：产品预设，非硬编码缺陷
- **dsh-gate 127.0.0.1:8799**：local-first 架构的本机 gate 地址，有意设计
- **demo.ts / twin-genie.ts / release-gate.ts / eval 脚本**：演示/校准脚本写死种子身份属脚本口径
- **demo-conversation.ts**：AskRail 演示剧本本体（按工作区出剧本），豁免
- **E8.3 校准系数 ×2**：驳回降权的产品逻辑常量，有注释依据
- **OCC / ADR / API Key**：行业通用术语（中文化口径中明确保留）
- **owner/manager/readonly 枚举**：内部角色值，P8 有中文映射字典（"经营者 · 审批人"等）

## 六、验证

- `pnpm -C packages/base typecheck`：绿
- `pnpm -C packages/base test`：**385/385 通过**（含 captain CAP 动态化断言；75 条 PG 依赖用例按既有口径 skip）
- `pnpm typecheck`：全仓全绿（base/runtime/shared/db/server/web）
- `pnpm suite`：**443/443 全绿**（workloom-pg 容器独立库 `workloom_hotel`；因 8787 被他仓 server 占用，本次以 `SERVER_PORT=8899` + `SUITE_PORT=8899` 跑通——suite 端口已改可配）

## 七、后续纪律

- `scripts/hardcode-scan.mjs` 已入仓——六类维度一键复扫，可作为 CI 防回归门禁（`node scripts/hardcode-scan.mjs .`）
- 默认值调整时**禁止**在测试中写死具体数值——一律动态引用（CAP 模式）
- 底座新增逻辑**禁止**带入行业词；行业域配置一律下沉 bundles/hotel（记录项四的槽位化方向）
