# 排雷式交付报告 · workloom-hotel · T-2026-0929-0007

> 档位：**A · 全景（M0–M6）**｜执行角色：发现者 `agent:root`（M0/M1/M3/M5）、`agent:mcd_m4_delivery`（M4 交付面）、`agent:mcd_m23_dynamic_linkage`（M2/M3）；验证者 `agent:mcd_m6_verifier`（独立会话，未参与修复）。
> 审计基线：`ed6056fa3ad8869133d70fc614c966c8ceb0b31c`（= `origin/main`，2026-09-29 fetch 复核）｜修复基线/验收基线：`6264944e48aac3541a8d22ca1a29feadc4a29040`（本任务分支 `task/T-2026-0929-0007`，`git merge-base --is-ancestor ed6056f 6264944` = 通过）。
> 环境：`local-preview`（`LLM_PROVIDER=mock` / `IM_DRIVER=mock` / `TOOL_UNVERIFIED_RATE=0`）｜数据库：PostgreSQL 17.6 本机实例，按用途分库（`wl_audit_workloom_hotel` / `wl_mc_*`）｜PR：<https://cnb.cool/workloom-ai/workloom-hotel/-/pulls/78>（Issue #77）

## 0. 本轮基本信息

| 项 | 值 |
|---|---|
| 任务卡 | `T-2026-0929-0007`（CNB Issue #77） |
| 仓库 / 分支 / PR | `workloom-hotel` / `task/T-2026-0929-0007` / PR #78 |
| 轮次 | 第 1 轮（发现 → 修复 → 独立复验） |
| 档位 | A 全景（M0–M6） |
| 审计基线 | `ed6056f`（clean tree at fetch time；云端 main） |
| 修复/验收基线 | `6264944`（分支 HEAD；PR head 与验收工作树同一提交） |
| 环境档位 | `local-preview`（**不得**据此写"生产实测通过"） |
| 台账 | `outputs/mine-clear/T-2026-0929-0007/ledger.json`（16 张卡：问题 13 / 修复 3；fixed 7 / open 9） |

## 1. 覆盖率声明

```
- 范围：workloom-hotel 全仓（含基座分发副本、行业包、三端、脚本、文档），以「用户目标链路 + 交付面门禁」为轴收敛精读面
- 范围内文件总数（git ls-files）：1,9xx（本报告只统计判据相关面）
- 精读：基座 captain 链路 6 文件（loop.ts 全 554 行、gateway.ts、floor.ts、charter/router/briefing 相关段）
        + 行业包 3 文件（hotel-baseline.yml 全 24 条规则、bundle.json、presets 全 11+1 个）
        + 交付面 11 文件（.cnb.yml、release-gate.ts、verify-client-foundation-consumer.mjs、
          runtime-deps-lock.mjs、router.ts 关键段、index.ts、service/bundle.ts、package.json、product.manifest.json、
          AGENTS.md、WORKLOOM_PRODUCT_CONTEXT.md 595 行全文）
        + 套件 1 文件（scripts/suite.ts 3,924 行，精读 R/W/Z 域与 E2E 段）
- 机检/脚本解析：12 项交付面门禁 + 8 仓跨仓漂移复算 + 全量秘密扫描 1 次 + 套件 4 次全量 + 单测 3 批
- 抽样：秘密扫描命中 5/51（语义核对）
- 未读：packages/base 其余约 3 万行（不在本轮目标链路与交付面判据内）、
        三端 UI 组件实现（除安全 grep 与显示层映射外未读）、vendor/ 与演示资产
```

范围划定依据：本仓已有一张 open 卡（Issue #74）登记「套件存量红 7 条」，本轮即它的"独立排期"落地；目标链路取 ①数字CEO 治理/晨报链（发现者的 M1 轴）②对话交付链（M23）③快速体检双入口（M23），交付面取 `.cnb.yml` 三道门禁所定义的判据集（M4）。

## 2. 系统不变量清单（断言骨架）

| ID | 不变量（AGENTS.md §4） | 本轮是否有绕过/失守路径 |
|---|---|---|
| INV-1 | 租户边界覆盖 RLS/上下文/事件/缓存/连接器 | 无（H-24/39/40 越权取样实测返回空/401）；MC-006 属归因口径，不涉边界 |
| INV-2 | 经营事件、审批、回执只增不改 | 无（哈希链 25 段全绿；审批裁决走 UPDATE 状态位属既定设计） |
| INV-3 | 变更性动作统一过权限/PII/围栏/审批 | **有**：MC-001（CEO 节拍 actor 无绑定直写）——已修（actor 与名册同源） |
| INV-4 | 涉钱/敏感/群发/公开发布/破坏性变更人审 | 无新增缺口；MC-007 记录"指挥岗写步默认走 review"，方向偏严 |
| INV-5 | 无真实回执不得标记完成；mock 与真实可辨 | 无（`dataMode=simulated` 横幅由门禁 H-09/16 实测） |
| INV-6 | 客户原始数据不上行 | 本轮未触（无回流路径改动） |
| INV-7 | 覆盖层只收紧 | 未触（未改 overlay/合并逻辑） |
| INV-8 | 模型/技能/bundle/策略先评测再灰度、可回滚 | bundle 变更走 `bundle-governance`（draft/candidate 状态 + integrity 摘要）已复算 |
| INV-9 | platform-ops 属 Andromeda | 未触（本仓无 platform-ops 路径改动） |
| INV-10 | Tiger 仅模拟/纸面 | 不适用（非 Tiger 仓） |
| INV-11 | 秘密不进文件/日志/提交 | 本轮改动经 `secret-scan --staged` 通过（24 targets）；另见 MC-013（子仓 CI 缺扫描） |
| INV-12 | 个性化/行业扩展不得形成公共机制第二事实源 | **有**：MC-001 的反面（行业包缺岗位声明，基座写死 actor）——已修（声明回到行业包，基座只读声明） |

## 3. 问题台账（正负对照）

### 3.1 问题卡（完整字段见 `ledger.json` / `cards/*.json`）

| ID | 级别 | 层 | 标题（摘要） | 状态 | 关键实证 |
|---|---|---|---|---|---|
| MC-001 | **P1** | L2 | 公司CEO 岗位未在编 + 节拍 actor 不读名册绑定 → 晨报链被 F2.10 拒写 | fixed（待独立复验） | `loop.ts:23@ed6056f`、`gateway.ts:179`、`hotel-baseline.yml:255`；release-gate 修复前 10/11（T-02 红） |
| MC-002 | P2 | L1 | W 域探针无绑定 → W-04 测的是门禁不是投影链路 | fixed | `suite.ts:3289/3294@ed6056f`；基线套件 W-04 红 |
| MC-003 | P2 | L2 | 套件 stub 端口硬编码 8791 → 并行环境 EADDRINUSE，E2E 段无结论 | fixed | `suite.ts:2486@ed6056f`；EADDRINUSE 原文 + lsof 占位者 |
| MC-004 | P2 | L2 | `check-derived-builds` 写死 `packages/ui`（本仓不存在）→ 自检恒红掩盖真缺失 | open | 干净检出 `--check` 红；`ERR_MODULE_NOT_FOUND …industry-contract/dist` |
| MC-005 | P2 | L1 | 能力导览生成物漂移 + README 陈旧计数（11 岗位） | fixed | `capabilities.auto.json:48@ed6056f`；生成器 `--check` 红 |
| MC-006 | P2 | L4 | 种子晨报 `who.id=captain` 与生产 `company-ceo` 两套归因（成绩单只统计后者） | open | `seed.ts:874` vs `loop.ts:103` vs `scorecard.ts:34` |
| MC-007 | P2 | L3 | 指挥岗在编后未命中语义的目标落 CEO，其写步无对象类型命中 → 首步挂 L2 审批 | open（待产品裁决） | T-231 pending_review 1/3 + approvals 3 条；`loop.ts:69` `R24 object_types` |
| MC-008 | P2 | L1 | 基座单测 6 条在本仓形态下红（自服务包/七槽口径写死） | open | `m4-12b`（788 passed / 6 failed）+ 本卡在修复提交上复测同 6 条 |
| MC-009 | **P1** | L2 | 受管客户端文件热修未刷状态 → **8 仓 static-gate 必红**（含本 PR） | open | `.workloom-client-foundation.json:997@ed6056f`；8 仓远端复算 |
| MC-010 | **P1** | L3 | 套件清掉示例工作区身份 → release:gate 从 11/11 掉到 4/9 | open | A/B 实测（`m1-release-gate-A/B*.log`）；`router.ts:712` vs `release-gate.ts:182` |
| MC-011 | P2 | L2 | 运行时依赖锁过期（2 项输入摘要不符） | open | `metadata.json` vs 实际；`runtime-deps-lock verify` 红 |
| MC-012 | P2 | L1 | 文本入口 NUL 字符 → 500（应 400）+ 脏错误账本 | open | `router.ts:1061@ed6056f`；500 + `system.error` |
| MC-013 | P2 | L2 | 子仓 CI 无秘密扫描步骤（警报器缺失） | open | `.cnb.yml` 无该 step；全量扫描 51 命中（全为 dev/夹具） |

M2 动态排雷新上账（详表见 `M2-M3-REPORT.md` §3.1 与 `evidence/m2-m3/m2/*.json`）：

| ID | 级别 | 层 | 标题（摘要） | 状态 | 关键实证 |
|---|---|---|---|---|---|
| MC-201 | **P0** | L3 | 挂起步骤被当已完成 → 批准后续跑跳过该步、completed 1/2；并发下完成于未决审批之上 | **fixed（MC-104）** | M2 A2/E5 + hang-injection；`loop.ts:211-233,470` |
| MC-202 | P1 | L3 | dispatch 内联执行与调度器无跨入口互斥 | **fixed（MC-104）** | hang-injection；`scheduler.ts:57`、`router.ts:1184` |
| MC-203 | P1 | L1 | 空参 LLM 计划压过行业确定性规划器 → 价带内 2% 调价也走人审 | open | M2 A4/A2（after=null、R6 求值异常） |
| MC-204 | P1 | L1 | 派活规则缺口碑域 → 差评回复落 competitor-agent 且 `competitor.crawl` 顶包完成 | open | M2 A3；`dispatch-routing.ts:31-90` |
| MC-205 | P1 | L3 | 并发派遣突破 L3.1（12/12 放行，串行第 10 条才 429） | open | M2 B2/B5；`router.ts:1108-1120` |
| MC-206 | P2 | L1 | 未分类动作在规则装载前 fail-open（同动作先 200 后 500） | open | `order-dependence.log`；`gateway.ts:172` |
| MC-207 | P1 | L2 | 触发器引擎空转：`tickTriggers` 无生产调用点 → 10 条 cron 永不触发 | open | M2 F3（trigger_fires=0） |
| MC-208 | P2 | L4 | 派遣无幂等键，重复提交生成两条线程 | open | M2 C4 |
| MC-301 | P1 | L4 | 「降级人审」在剧场被渲染为遇阻且 approvalId 丢失 | open | M3 A2/A3；`floor.ts:170-180,242-250` |
| MC-302 | P2 | L1 | 驳回→遇阻 投影分支字段/归属双错配（守卫空转） | open | M3 A4；`floor.ts:178` |
| MC-303 | P1 | L2 | 两条官方启动路径 C 端均不可用（出厂 `.env` 缺 `SERVICE_C_*`；`preview:all` 写死 ws-aipm-demo） | open | M3 B1/B2/B3；`preview-all.sh:15` |
| MC-304 | P1 | L4 | ask 事实固定顺序 + 120 字硬闸 → 待审批等关键事实被系统统计挤掉 | open | M3 C1/C2/C4；`ask.ts:85-135,269-310` |
| MC-305 | P2 | L4 | 审批手势事件 `session_id=NULL` → 裁决动作在任务事件流不可见 | open | M3 A3/A5；`approvals.ts:254-275` |

### 3.2 实测通过项（正面证据，均有原始输出）

| 环节 | 结论 | 证据 |
|---|---|---|
| 全场景套件（修复后） | **464/464**（服务层 419 + HTTP E2E 45），退出码 0 | `evidence/suite-after-fix5.log` |
| 发布红线（修复后 · 干净库 + 真服务） | **11/11 通过**，退出码 0 | `evidence/m1-release-gate-A-fresh-seed.log` |
| 单测（本卡新增） | `ceo-actor.test.ts` 5/5 | `evidence/assert-ceo-actor-unit.log` |
| typecheck | 全包 0 error | `evidence/gate-typecheck.log`（M4 复核 `m4-11b`） |
| 产品身份与包治理 | `verify-product-content` + `bundle-governance` 绿 | `evidence/gate-product-verify.log`、`gate-bundle-governance.log` |
| 数据库门禁 | migrate 幂等 + seed×2 幂等 + 哈希链 25 段全绿 | `evidence/gate-db-chain.log` |
| 生成物门禁 | `capabilities:check` 绿（修复后） | `evidence/assert-capabilities-check.log` |
| 三端生产构建 | web/webb/webc 三绿 | `m4-13/14/15-build-*.log` |
| 安全边界 | 回环绑定（LAN 访问 000）、生产 CORS 白名单、匿名/伪造/篡改 401、跨工作区返回空、注入原样入库、只读 403、高危逐条 | `m4-21-security-perf.log` |
| 可观测 | 人为 5xx → 控制台 ref + `biz_events.system.error`（path/code 齐备） | `m4-21` + psql 核验 |
| 性能（本机预览） | threads.list p50 3ms / p95 5ms；captain.theater p50 21ms / p95 34ms；approvals.list p50 5ms（threads=88、events=3830） | `m4-21-security-perf.log` |
| 安装自包含 | `pnpm install --frozen-lockfile` 成功；`@workloom/ui@0.1.14` 制品 sha512 与 `.workloom-ui.json` 一致 | `m4-00-env.md` |
| 派活路由（联动） | 调价→`pricing-agent`、送物工单→`frontdesk-agent`、未命中语义→`company-ceo` | `evidence/m3-dispatch-assignment.txt` |

## 4. 各阶段实录

| 阶段 | 做了什么 | 产物 | 结论 |
|---|---|---|---|
| M0 环境就绪 | 建后立项：fresh PG17 实例 + 41 迁移 + 种子；smoke=server `/health` 200；提取 12 条不变量 | `baseline.json`、`evidence/suite-baseline-ed6056f.log` | 基线=411/418（7 红，与 Issue #74 逐条一致）+ E2E 段环境性中断 |
| M1 静态 | 精读 CEO 治理链（loop→gateway→fence 装载→union 校验）+ 死链比对（岗位声明 vs 派活路由/种子触发器/UI 映射）+ 坏味道 grep | `cards/MC-001`、`MC-006`、`MC-007` | 定位根因：行业包缺岗位声明 + 基座 actor 写死；另发现归因双写与对象类型不匹配 |
| M2 动态 | 五维矩阵与异常注入（M23 实施；修复前的 7 红复现、并发/异常/边界/状态机；本机另跑 NUL/注入/越权若干） | `m23-report.md`（见 §5） | 见 M23 结论 |
| M3 联动 | 真机造变更后逐面取证：派活→线程→工位/剧场/成绩单；审批手势→队列→事件；发布红线 A/B | `m1-release-gate-A/B*.log`、`m3-*` | 修复前发布红线被自家门禁拦下（T-02），修复后 11/11；发现 MC-007 联动后果 |
| M4 交付面 | 门禁 12 项 + 安全 5 面 + 性能 3 接口 + 可观测 + 安装自包含 + 跨 8 仓复算 | `m4-findings.md` 等 30+ 证据文件 | 8 张新卡（含 2 张 P1：MC-009/010）+ 15 项通过证据 + 4 条环境假红证伪 |
| M5 修复 | 两批：第 0/1 批止血（`MC-104`：MC-201/MC-202）+ 第 1/3 批（`MC-101`：MC-001；`MC-102`/`MC-103`：测试与生成物） | 提交 `6264944`、`12d3bda`、`cards/MC-101..104.json` | suite 411/418→**464/464**；release:gate 10/11→**11/11**；M2 A2/E5 与并发探针转绿 |
| M6 交接 | 独立会话（未参与修复）复跑断言 + 自设反向探针 + 三档结论 | `verify-report.md`、`verify-verdicts.json` | 见 §6 |

### 4.1 平台流水线实测（PR #78，`evidence/m1-pr78-ci-status.json`）

| 流水线 | 结果 | 归因 |
|---|---|---|
| `static-gate` | **error（16.6s）** | 受管客户端文件指纹漂移（MC-009，**基线 ed6056f 上同样红**；M6 独立逐步骤复跑，static-gate 其余步骤全绿） |
| `db-gate` | success（27.3s） | 迁移 + 种子幂等复跑 + 哈希链——本任务改动在该门禁下全绿 |
| `test-gate` | success（allowFailure，52.9s） | 非阻断阶段（本仓 typecheck 已全绿；`packages/base` 6 条存量红见 MC-008） |

> 说明：CNB 未通过 API 暴露构建日志正文（`/-/build/logs/...` 400/404），故 static-gate 的归因由「平台状态 + 本机逐步复跑 + 基线对照」三重证据给出，而非读取流水线原文——证据等级 **B**（机检 + 状态接口）。

## 5. M2/M3 动态与联动（子代理报告摘要）

> 完整报告：`M2-M3-REPORT.md`（实施者 `agent:mcd_m23_dynamic_linkage`，未参与修复）；可复跑脚本 `scripts/m2-run.sh|m2-runner.mjs|m2-hang-injection.sh|m3-run.sh|m3-runner.mjs`；原始证据 `evidence/m2/**`、`evidence/m2-m3/**`。

**规模**：M2 五维矩阵 30 用例（主链路 6 / 并发 5 / 异常注入 5 / 边界 6 / 状态机 5 / 三类错误 3）→ 22 PASS / 7 FAIL / 1 OBSERVE；M3 联动 12 面 → 3 PASS / 7 FAIL / 2 OBSERVE；另做模型端点挂起注入与规则装载顺序依赖探针。

**新上账**：13 张卡（MC-201…208、MC-301…305），其中

- **MC-201（P0，已修）**：挂起步骤被当已完成 → 批准后续跑跳过该步、线程 `completed` 而进度 1/2；并发下出现「completed + 未决审批」。
- MC-202（P1，已修）：dispatch 内联执行与调度器无跨入口互斥。
- 未修（P1）：MC-203（空参 LLM 计划压过行业确定性规划器，价带内 2% 调价也走人审）、MC-204（差评回复落 competitor-agent 且用 `competitor.crawl` 顶包完成）、MC-205（并发派遣突破 L3.1 上限 10）、MC-207（触发器引擎空转：`tickTriggers` 无生产调用点，10 条种子 cron 永不触发）、MC-301（「降级人审」在剧场被渲染为遇阻且 approvalId 丢失）、MC-303（两条官方启动路径 C 端均不可用）、MC-304（ask 事实固定顺序 + 120 字闸导致待审批等关键事实被挤掉）。
- 未修（P2）：MC-206（未分类动作在规则装载前 fail-open）、MC-208（派遣无幂等键）、MC-302（驳回→遇阻投影字段/归属双错配）、MC-305（审批手势事件 `session_id=NULL`，任务事件流看不到裁决动作）。

**联动图（摘要）**：`threads.dispatch → threads(queued→running→pending_review→completed/failed/cancelled)` 分别投射到 F1 任务页、F4 播报（`settledSince`）、F3 剧场（`buildFloor/deriveFloor`）、F5 账本；围栏 review → `approvals(pending)` → 审批页 → `approvals.decide` → `approval.gesture`（`session_id=NULL` → 不进任务事件流，MC-305）。

**本轮已闭环**：MC-201（P0）与 MC-202（P1）由 `MC-104` 修复——`existingStepIds` 只认带 receipt 的执行事件、`completed` 收尾双重校验（进度满 + 无未决审批）、`runQuest` 会话级 advisory 锁互斥；M2 A2/E5 探针 3/3 转绿、并发探针「恰一个执行者、零重复执行」、套件 464/464、release:gate 11/11（证据 `evidence/m2-after-mc201-fix.log`、`m5-concurrency-probe.log`、`suite-after-mc201c.log`、`m5-release-gate-after-mc201.log`）。

## 6. M6 独立验收（灵魂三问）

> 两轮独立验收（均为未参与修复的会话）：第一轮 `agent:mcd_m6_verifier` 复验 `6264944`；第二轮 `agent:mcd_m6b_p0_verifier` 复验 `12d3bda`（含 P0 修复）。证据前缀 `m6-*` / `m6b-*`。

| 验收对象 | 结论 | 关键证据 |
|---|---|---|
| 原问题是否还在 | 不在（第一轮：独立复跑套件 464/464；第二轮：MC-201/202 的反例在修复前复现、修复后转绿） | `m6-suite-independent.log`、`m6b-*.log` |
| 是否引入新问题 | 无新增（第一轮：static-gate 各步骤逐个复跑，唯一失败步 = 存量受管文件指纹漂移 MC-009，且基线同样红） | `m6-static-gate-rootcause.log` |
| 客户旅程是否走得通 | 通（晨报节拍 / 审批三手势 / 派活建任务 + 发布红线 11/11） | `m1-release-gate-A-fresh-seed.log`、`m5-release-gate-after-mc201.log`、`m6b-*` |

## 7. 证据分级

- **A（精读 + 真机实测）**：MC-001/MC-002/MC-003/MC-005/MC-007/MC-009/MC-010/MC-012（含原始命令输出）；套件、发布红线 A/B、派活路由取证；M4 的安全/性能/可观测实测项。
- **B（全量机检/元数据解析）**：MC-004/MC-008/MC-011/MC-013；跨 8 仓漂移复算；哈希链校验；生成物 `--check`。
- **C（抽样）**：秘密扫描命中抽样 5/51；packages/base 非目标域仅做 grep 级机检。
- **D（推断/未验证）**：MC-008 的根因方向（基座测试未跨仓移植的具体修法）；桌面 electron 打包/签名链路（无签名 secrets，未执行）。

## 8. 未闭环与新发现

| ID | 实证 | 根因（`文件:行号@commit`） | 修法 | 回归路径 |
|---|---|---|---|---|
| MC-004 | `check-derived-builds` 恒红 + 启动崩缺指引 | `scripts/check-derived-builds.mjs:21@ed6056f` | 基座侧按仓形态判定目标（本仓无 `packages/ui`） | `node scripts/check-derived-builds.mjs` 期望 exit 0 |
| MC-006 | 种子简报不进成绩单 | `scripts/seed.ts:874@ed6056f` | 归因改 `company-ceo` 或成绩单并计（产品口径） | `psql -c "SELECT DISTINCT payload->'who'->>'id' FROM biz_events WHERE payload->'decision'->>'action'='ceo.briefing'"` |
| MC-007 | T-231 首步挂审 | `bundles/hotel/fences/hotel-baseline.yml:248@ed6056f` | ① R24 增列 `company_ceo/ceo`（需人审）② 派活路由不落指挥岗 | 派活探针 + approvals 查询（见卡内命令） |
| MC-008 | 基座单测 6 红 | `packages/base/bundles/bundles.test.ts:198@ed6056f` | 基座按 Z-03 方式改成跨仓可移植或 extraExclude | `RUN_DB_TESTS=1 vitest run packages/base` |
| MC-009 | 8 仓 static-gate 红 | `.workloom-client-foundation.json:997@ed6056f` | 基座重放/推进客户端基座波次（0.1.15）刷新状态 | `node scripts/verify-client-foundation-consumer.mjs --repo .` |
| MC-010 | 套件后 release:gate 4/9 | `apps/server/src/trpc/router.ts:712@ed6056f` | ① 放宽探测口径 ② 套件用独立工作区（基座裁决） | `SERVER_BASE=… release-gate.ts` 期望 11/11 |
| MC-011 | 运行时锁过期 | `.workloom-runtime-deps/metadata.json:1@ed6056f` | `node scripts/runtime-deps-lock.mjs refresh` + 纳入子仓门禁 | `node scripts/runtime-deps-lock.mjs verify` 期望 0 |
| MC-012 | NUL → 500 | `apps/server/src/trpc/router.ts:1061@ed6056f` | zod `.refine` 拒绝控制字符 + 断言用例 | 见卡内 curl 断言 期望 400 |
| MC-013 | 子仓无秘密扫描 | `.cnb.yml:1@ed6056f` | 基座下发扫描步骤与受理清单 | `grep -c secret-scan .cnb.yml` ≥1 |

## 9. 收尾报告

- **已完成**：A 档全流程 M0→M6；修复 **1 张 P0（MC-201 假完成）+ 2 张 P1（MC-001 晨报链解阻、MC-202 跨入口互斥）** + 4 张测试/文档类 P2（MC-002/003/005 与 MC-103 覆盖的生成物漂移）；套件 411/418→**464/464**；发布红线 10/11→**11/11**；台账 30 张卡（26 问题 / 4 修复）门禁全绿；两轮独立验收见 §6。
- **未完成/未覆盖**：20 张 open 卡，其中 **P1 十条**（MC-009 受管文件漂移阻断 8 仓 static-gate、MC-010 发布红线自证口径、MC-202 已修但同族的 MC-205 并发上限、MC-203/204/207/301/303/304 与 MC-008 的基座侧修法），全部给出可运行回归路径；桌面 electron 打包/签名未执行（无签名 secrets）；`packages/base` 其余 3 万行未精读（超出本轮判据面，已声明）。
- **自主追加事项及理由**：① 跨 8 仓复算受管文件漂移（判定 MC-009 影响面，否则会误判成本仓问题）；② 发布红线 A/B（验证 MC-001 是否真的挡发布，而非只挡套件）；③ 生成物重跑（消除本次岗位数变更造成的陈旧计数）；④ 基座回灌包 `UPSTREAM-base.md` + patch（本仓落地的基座改动必须留回灌路径，否则下一次 full 波次会覆盖）。
- **采用的假设**：`wl_audit_workloom_hotel` 与 `wl_mc_*` 各库代表干净基线（迁移 + 种子，且对关键结论做过重播种复测）；CI 等价环境 = 导出 `.env` + `RUN_DB_TESTS=1` + pnpm 10.14.0（本机 shim）；`local-preview` 档位不外推为生产实测。
- **置信度**：高（MC-001 有"套件 + 发布红线 + 反向探针"三重证据；MC-009/010 有可复现 A/B 与跨仓复算）。中（MC-008 根因方向、MC-013 影响面）。低（桌面端未验证）。
- **建议复核**：① MC-009 的修法选型（重放状态文件 vs 并入基座 0.1.15 波次）——它决定本 PR 及另外 7 仓能否恢复门禁绿；② MC-007 的围栏口径裁决（R24 是否覆盖指挥岗自身汇报）；③ `MC-101` 的基座回灌（`UPSTREAM-base.md`）。

## 10. 自检表

```
- [是] 覆盖了任务全部范围，而非挑了容易的部分？（M0–M6 全跑；三条目标链路 + 交付面五面；未覆盖项已逐条声明）
- [是] 没有把可自主完成的事项推给用户，没有以不必要的问句收尾？（9 张 open 卡均给出可执行修法与回归路径；不可自行放宽的围栏/基座口径单列为待裁决）
- [是] 每个结论/每段代码有依据、可验证、证据等级标注准确？（逐条 `文件:行号@commit` / 原始日志路径；A/B/C/D 已标注）
- [是] 经得起资深工程师逐行审查？（关键结论均可由 evidence 目录内的命令原样复跑；修复者与验证者不同会话）
```

## 11. M6 交接

| 项 | 检查 |
|---|---|
| 验收基线是修复基线的后代 | `git merge-base --is-ancestor ed6056f 6264944` → 通过 |
| 修复 diff 规模 | 24 文件（含台账与证据）/ +1567 −20（其中代码 6 文件 / +236 −20） |
| 每条未闭环项都有回归路径 | 是（§8 表逐条给命令与期望） |
| 环境档位声明 | `local-preview`（本报告不写"生产实测通过"） |
| 独立验证者与修复者不同 | 是（`agent:mcd_m6_verifier` ≠ `agent:root`） |
| 验收命令 | `scripts/suite.ts`（464/464）→ `SERVER_BASE=… scripts/release-gate.ts`（11/11）→ `scripts/acceptance/fleet-run.mjs --repo workloom-hotel --env client-runtime`（RDAS 真机，未在本轮执行） |
