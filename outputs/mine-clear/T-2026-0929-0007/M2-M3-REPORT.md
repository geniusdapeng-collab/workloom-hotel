# 排雷式交付报告 · M2 动态 + M3 联动（workloom-hotel）

> 档位：**B2 动态域（M2 五维矩阵 + 三类错误）+ B3 联动域（M3 状态投影保真度）**
> 任务卡：`T-2026-0929-0007` ｜ 仓库：`workloom-ai/workloom-hotel`
> 审计基线：`ed6056fa3ad8869133d70fc614c966c8ceb0b31c`（工作树 `.wt-mc-hotel-m23`，分支 `tmp/mc-audit-m23`）
> 环境：`local-preview`（PG17 127.0.0.1:5461/`wl_mc_m23`，出厂演示配置 `LLM_PROVIDER=mock` / `IM_DRIVER=mock` / `TOOL_UNVERIFIED_RATE=0`）
> 执行角色：发现者 `mcd_m23_dynamic_linkage`（本报告不含任何修复动作；修复卡由 M5 会话负责）

---

## 1. 覆盖率声明

```
- 范围内文件总数：48；精读：14；机检/脚本解析：22；抽样：6；未读：6
- 未读/抽样清单及原因：
  - 未读：apps/*/src 中与本链路无关的页面组件（p0/p5–p9/p11–p21/p30/p31 等 6 个目录段）——不在目标链路辐射面内
  - 抽样：apps/server/src/trpc/router.ts（3497 行，只精读 threads/approvals/nightShift/captain/service/onboarding/auth/context 段及挂载表）、scripts/suite.ts（3924 行，只精读 A–F/K–Z 用例断言与 E2E 驱动段）
  - 机检：全仓 grep（tickTriggers / registerWriteActions / params.gesture / SERVICE_C_* / ask-facts / status 枚举）与 SQL 覆盖度统计
```

**本轮范围界定**：目标链路 =「对话框/移动端派任务 → 岗位路由 → 规划 → 围栏 → 审批 → 执行/续跑 → 三端投影」。范围内的 14 个精读文件：

`packages/runtime/src/loop.ts`、`packages/runtime/src/ask.ts`、`packages/base/captain/loop.ts`、`packages/base/captain/floor.ts`、`packages/base/workdata/gateway.ts`、`packages/base/review-console/approvals.ts`、`packages/base/night-shift/triggers.ts`、`apps/server/src/runtime/thread-runner.ts`、`apps/server/src/runtime/scheduler.ts`、`apps/server/src/runtime/dispatch-routing.ts`、`apps/server/src/industry/hotel/acquisition-planner.ts`、`apps/server/src/service/gateway.ts`、`apps/server/src/service/workspace-routing.ts`、`apps/web/src/pages/observability/Observability.tsx`（另含 .env/.env.example/preview-all.sh/acceptance/profile.json 等装配文件）。

## 2. 系统不变量清单（断言骨架）

| ID | 不变量 | 来源 | 本轮绕过路径 |
|---|---|---|---|
| INV-2 | 事件/审批只增不改，纠正通过新事件表达 | `AGENTS.md` §4.2 | 无（append-only 与哈希链实测通过） |
| INV-3 | 所有变更性动作统一经过权限/PII/围栏/审批 | `AGENTS.md` §4.3 | **有**：MC-206（未分类动作在规则装载前 fail-open） |
| INV-4 | 高风险动作必须人审 | `AGENTS.md` §4.4 | **有**：MC-201/MC-202（挂起步骤被当已完成，可绕过未决审批直接完成） |
| INV-5 | 没有真实回执就不能标记完成 | `AGENTS.md` §4.5 | **有**：MC-201（completed 1/2、无执行回执）、MC-204（competitor.crawl 顶包完成） |
| INV-12 | 个性化与行业扩展不得形成第二事实源 | `AGENTS.md` §4.12 | 局部：MC-303（C 端工作区映射双口径） |

## 3. 问题台账（正负对照）

### 3.1 本轮新增问题卡（13 张，已上账至共享台账 `T-2026-0929-0007/ledger.json`）

| ID | 级别 | 层 | 标题 | 运行实证 | 根因（文件:行@commit） | 验收断言 |
|---|---|---|---|---|---|---|
| MC-201 | **P0** | L3 | 求值异常降级人审的步骤被当「已完成」→ 批准后跳过该步、completed 1/2；并发下可绕过未决审批直接完成 | `evidence/m2/m2-report-m2-mumurpu0.json#A2/E5`、`evidence/m2/hang-injection.log` | `packages/runtime/src/loop.ts:211-233,410-412` | A2 断言 completed 且 progress 2/2 + E5 属性断言 |
| MC-202 | P1 | L3 | dispatch 内联执行与调度器并发跑同一线程（无跨入口互斥） | `hang-injection.log`（scheduler→completed 2/2，审批仍 pending） | `apps/server/src/runtime/scheduler.ts:57`、`trpc/router.ts:1177-1184` | 慢执行派遣不得出现 pending_review 响应后线程被标 completed |
| MC-203 | P1 | L1 | 空参 LLM 计划优先于行业确定性规划器 → 参数型围栏全部求值异常→人审（价带内 2% 调价也不 auto） | `m2-report#A4/A2`（after=null、R6 求值异常） | `packages/runtime/src/loop.ts:94-138`、`thread-runner.ts:246-254` | 2% 调价 completed + after.price≈553.86 |
| MC-204 | P1 | L1 | 派活语义规则缺口碑域 → 回复差评落到 competitor-agent，用 competitor.crawl 顶包 completed | `m2-report#A3` | `apps/server/src/runtime/dispatch-routing.ts:31-90`、`acquisition-planner.ts:159-180` | 默认入口派遣差评 → preset=review-agent + pending_review |
| MC-205 | P1 | L3 | 并发派遣突破 L3.1 上限：12/12 全放行（串行对照第 10 条 429） | `m2-report#B2/B5` | `apps/server/src/trpc/router.ts:1108-1120` | 12 路并发成功 ≤10，其余 429 |
| MC-206 | P2 | L1 | 网关对未分类动作 fail-open + 分类依赖规则装载时序（同一节拍先 200 后 500） | `evidence/m2/order-dependence.log` | `packages/base/workdata/gateway.ts:172` | 顺序依赖探针两次结果一致 |
| MC-207 | P1 | L2 | 触发器引擎空转（tickTriggers 无生产调用）→ 10 条种子 cron 永不触发 | `m2-report#F3`（trigger_fires=0、trigger.fired=0） | `packages/base/night-shift/triggers.ts:141` | 命中分钟内 trigger_fires/trigger.fired 有记录 |
| MC-208 | P2 | L4 | 派遣无幂等键，重复提交生成两条线程 | `m2-report#C4` | `apps/server/src/trpc/router.ts:1060-1068` | 同幂等键 → 同一 threadId |
| MC-301 | P1 | L4 | 「降级人审」在剧场被渲染成遇阻(blocked) 且 approvalId 丢失（审批队列说待批、剧场说撞墙） | `evidence/m3/m3-report-m3-mumvdo3b.json#M3-A2/A3` | `packages/base/captain/floor.ts:170-180,242-250` | 挂起时剧场 state=asking 且 approvalId 一致 |
| MC-302 | P2 | L1 | 驳回→遇阻 分支字段/归属双错配 → 分支确定性空转（守卫空转） | `m3-report#M3-A4`（after.gesture=reject / params.gesture=NULL / who=human） | `packages/base/captain/floor.ts:178` | 驳回后被审员工 state=blocked |
| MC-303 | P1 | L2 | 两条官方启动路径 C 端均 503：出厂 .env 无 SERVICE_C_*；preview:all 写死 ws-aipm-demo（本仓只有 ws-yunqi） | `m3-report#M3-B1/B2/B3` | `scripts/preview-all.sh:15`、`service/workspace-routing.ts:30-40` | 默认与 preview:all 口径 /c/session 均 200 |
| MC-304 | P1 | L4 | ask 事实固定顺序 + 120 字硬闸 → 待审批等关键事实被系统统计挤掉；明细/行业数据无事实面 | `m3-report#M3-C1/C2/C4` | `packages/runtime/src/ask.ts:85-135,269-310` | 问待审批 → 回答含与 DB 一致的 N 项 |
| MC-305 | P2 | L4 | 审批手势事件 session_id=NULL → 裁决动作在任务事件流/账本页不可见（31% 非线程事件整体缺失） | `m3-report#M3-A3/A5` | `packages/base/review-console/approvals.ts:254-275` | threads.events 含 approval.gesture |

### 3.2 实测通过项（同样有证据，防修复误伤）

| 环节 | 结论 | 证据 |
|---|---|---|
| 健康检查 / 三成员登录 / DB | `/health` 200、`system.health db=up`、三 token 各异 | `m2-report#A1` |
| 含糊指令 | 「帮我看看」→ clarify 反问且不建任务 | `m2-report#A5` |
| ask 即时应答链路 | 问数返回 mode=ask + 91–107 字回答，线程 completed | `m2-report#A6` |
| 并发裁决同一审批 | 12 路仅 1 路生效、gesture 事件恰 1 条、无 5xx | `m2-report#B1` |
| 并发续跑同一线程 | 12 路 replay 无重复 step、终态 completed | `m2-report#B3` |
| 并发审批超时扫描 | 12 路 sweep 无 5xx、过期项不重复标 | `m2-report#B4` |
| 串行并发上限（对照） | 第 10 条起 429（上限逻辑本身有效） | `m2-report#B5` |
| 模型配置 fail-closed | 不可达 baseUrl → 400 且 .env 保持 mock | `m2-report#C1` |
| goalRef 缺失 | 按标题规划 + 服务端 `[dispatch] 未取到档案` 警告 | `m2-report#C2`（修脚本后 PASS） |
| 驳回出口 | 挂起线程驳回 → cancelled（有明确出口） | `m2-report#C3` |
| 外部工具缺失手尾 | 海报任务未被标完成（落 pending_review 1/3） | `m2-report#C5` |
| 标题/原因长度与分页边界 | 0/500/501、200/201、limit 0/1/200/201 全部按契约 400/200 | `m2-report#D1/D3/D6` |
| 注入式输入 | SQL/HTML/emoji/零宽字符逐字落库不炸 | `m2-report#D2` |
| 批量边界 | 空数组/51 项均 400 | `m2-report#D5` |
| 过期审批 | decide 被拒 + 标 expired，不出现 approved | `m2-report#E2` |
| 夜班决策包投递 | `nightShift.deliver` 200，状态机 package_generated | `m2-report#E3` |
| 越权与跨区读取 | readonly 403；不存在线程返回 null（不泄露存在性） | `m2-report#E4` |
| 业务错误码 | 不存在审批 400、readonly 403、非法手势 400 | `m2-report#F1` |
| 5xx 可观测 | tRPC onError 将 500 写入 system.error 事件（1 条） | `m2-report#F2` 日志段 + DB 计数 |
| C 端↔PC 全配联动 | 建单 → PC 服务前台可见 → 推进 → C 端回读新状态（processing） | `m3-report#M3-B3` |
| 依赖挂起（模型端点不回包） | 42s 内降级 timeout_fallback，未假完成、未卡死 | `evidence/m2/hang-injection.log` |

## 4. 各阶段实录

| 阶段 | 做了什么 | 产物 | 结论 |
|---|---|---|---|
| M0（沿用父任务） | wl_mc_m23 隔离库 migrate+seed；出厂配置起服务端 8802 | `evidence/m2/server-m2.log` | 环境可用 |
| M2 动态 | 五维矩阵 30 用例（主链路 6 / 并发 5 / 异常注入 5 / 边界 6 / 状态机 5 / 三类错误 3） | `scripts/m2-run.sh` + `m2-runner.mjs` + `m2-report-m2-mumurpu0.{json,md}` | 22 PASS / 7 FAIL / 1 OBSERVE / 0 ERROR |
| M2 注入 | 模型端点挂起（9911 永不回包）+ 顺序依赖探针（规则装载前/后） | `scripts/m2-hang-injection.sh` + `hang-injection.log` / `order-dependence.log` | 降级可用；暴露出并发假完成与分类时序 |
| M3 联动 | 3 台服务端（出厂默认 / preview:all 口径 / 全配口径）＋线程生命周期逐面取证 | `scripts/m3-run.sh` + `m3-runner.mjs` + `m3-report-m3-mumvdo3b.{json,md}` | 3 PASS / 7 FAIL / 2 OBSERVE |

联动图（状态变更 → 各面数据源 → 投影 → UI）：

```
threads.dispatch ──▶ threads(queued→running→pending_review→completed/failed/cancelled)
   │                      │                     │
   │                      ├─▶ F1 任务页  apps/web P2 / apps/webb  → trpc.threads.list/get/events（session_id=threadId）
   │                      ├─▶ F4 播报    threads.settledSince（closed_at 近窗，服务端事实源）
   │                      ├─▶ F3 剧场    captain.theater → buildFloor/deriveFloor（blocked>asking>working>queued>idle）
   │                      └─▶ F5 账本    /events 页 = 最近 12 线程 × threads.events
   └─▶ 围栏判定 review ──▶ approvals(pending) ──▶ F2 审批页（web P3/P4、webb inbox）
                              └─ approvals.decide ──▶ approval.gesture 事件（session_id=NULL）→ 不入任务事件流（MC-305）
C 端 /c/session → /c/tickets（c_tickets）──▶ F7 PC 服务前台 service.tickets.list/advance
问答 ask（threads.dispatch ask 模式）──▶ F8 事实面（biz_events 统计 / KB 命中 / 行业 provider）
```

## 5. 证据分级

- **A（代码精读 + 运行双证）**：MC-201、MC-202、MC-203、MC-204、MC-205、MC-207、MC-301、MC-302、MC-303、MC-304、MC-305。
- **A（代码精读，运行侧为对照探针）**：MC-206（order-dependence.log 为运行实证，属 A）。
- **B（运行观察 + 代码机检）**：MC-208（重复提交为运行观察，未做幂等键修复前的属性断言）。
- **覆盖度机检（B 级）**：M3-A5（31% 非线程事件不可见）为 SQL 统计 + 代码路径解析，未逐页截图验证 UI。
- **未做（C/D 级）**：三端真实浏览器截图（本轮用 API 投影面取证，UI 像素级验证留给 M4/M6）。

## 6. 本轮产物

- 脚本：`scripts/m2-run.sh`、`scripts/m2-runner.mjs`、`scripts/m2-hang-injection.sh`、`scripts/m3-run.sh`、`scripts/m3-runner.mjs`
- 证据：`evidence/m2/{m2-report-m2-mumurpu0.json,m2-report-m2-mumurpu0.md,cases-m2-mumurpu0.jsonl,server-m2.log,order-dependence.log,hang-injection.log,hang-endpoint.log,hang-app-server.log}`、`evidence/m3/{m3-report-m3-mumvdo3b.json,m3-report-m3-mumvdo3b.md,cases-m3-mumvdo3b.jsonl,server-m3.log,server-m3-preview.log,server-m3-configured.log}`
- 问题卡：`cards/m2-m3-cards.json`（13 张，已 `mine-clear.mjs add` 到共享台账，ID 段 MC-201..208 / MC-301..305）
- 复跑：`bash outputs/mine-clear/T-2026-0929-0007/scripts/m2-run.sh --fresh`（重建隔离库，约 90s）；`bash outputs/mine-clear/T-2026-0929-0007/scripts/m3-run.sh`（三服务端对照，约 60s）

## 收尾报告

- 已完成：M2 五维矩阵（30 用例）+ 依赖挂起/顺序依赖两类注入 + M3 联动图与逐面取证（12 用例，含 C 端跨端与问答覆盖）；13 张问题卡上账（含 1 张 P0）；健康面清单与可复跑脚本齐备。
- 未完成/未覆盖：① 三端真实浏览器截图（本轮以 API 投影面取证）；② 夜班决策包/董事会包对**新**审批的联动（仅验证了 deliver 状态机，未在决策包统计里核对新单）；③ 「优先级永久压制」仅做了代码级核查（floor 30 分钟/10 分钟窗口逻辑），未做 30 分钟等待的真实老化实验。
- 自主追加事项及理由：① 增加「串行派遣对照 B5」以区分“上限逻辑不存在”与“并发竞态”，避免误判；② 增加「三服务端对照（出厂/preview:all/全配）」以区分配置缺陷与环境缺陷；③ 把 order-dependence 探针固化进 `m2-run.sh`，保证 CEO 节拍顺序依赖可复现。
- 采用的假设：① 以 `.wt-mc-hotel-m23` 工作树 + `wl_mc_m23` 隔离库代表出厂默认形态；② 环境档位 `local-preview`，不表述为生产实测；③ 修复动作不在本轮范围（M5 负责），本轮只出卡与断言。
- 置信度：**高**——13 张卡均具备「API 响应原文 + owner 直查 + 服务端日志」三件套或代码精读 + 运行对照；唯一中置信度项为 M3-A5 的 UI 可见性推断（B 级）。
- 建议复核：① MC-201（P0，建议 M5 第 0 批止血）；② MC-203/MC-204（同一根因簇：默认 mock 规划与岗位路由，修一处需连带验证另一处）；③ MC-303（首启路径缺陷，客户第一小时必踩）。

## 自检表

- [是] 覆盖了任务全部范围（M2 五维 + 三类错误 / M3 联动图 + 逐面取证 + 问答覆盖），而非挑容易的部分？
- [是] 没有把可自主完成的事项推给用户，没有以不必要的问句收尾？
- [是] 每个结论/每段代码有依据、可验证、证据等级标注准确？
- [是] 经得起资深工程师逐行审查？（根因均给到文件:行@commit，断言均可运行复跑）
