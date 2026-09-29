# 样板间数据覆盖矩阵（TWIN-COVERAGE）

> 回答一个问题：**「我们涉及的场景方方面面、数据类型和数据状态非常多，全都模拟到了吗？」**
> 诚实答案：核心经营域 100% 覆盖；少数域靠「样板间管家（twin-genie）运行时兜底」而非静态快照覆盖。本矩阵逐域列明，并给出每域的兜底路径。

图例：✅ 快照全量模拟 ｜ 🟡 快照有基础数据，运行态由 Genie 补足 ｜ 🤖 由 Genie 按需合成（不入静态快照）

## 一、数据表级覆盖（22 张表逐表核对）

| 表 | 覆盖 | 数据量（快照口径） | 说明 |
|---|---|---|---|
| biz_events | ✅ | ~1345 条 | 30 天全业务域五元事件，哈希链逐条可验 |
| approvals | ✅ | ×10（approved 7 / pending 2 / rejected 1） | 三手势、驳回回流、P4 决断队列 |
| night_runs | ✅ | ×30（package_generated） | 与 30 个夜班决策包事件一一对应 |
| fence_rules | ✅ | R1–R24 ×active（v3）+ 旧版 rolled_back | 版本化留痕可演示回滚 |
| fence_dry_runs | ✅ | ×3（2 confirmed / 1 rejected） | 含单调守卫驳回样本（只紧不松） |
| org_memory | ✅ | ×8（pattern/sop/preference） | 来源事件可归因（source_events） |
| memory_usage | ✅ | ×16 | 记忆-事件使用归因 |
| skills | ✅ | 25 官方 + 团队 ×1 + 行业共享 ×1 | 技能市场资产卡 |
| skill_installs | ✅ | 25 已装 + 行业共享待装 ×1 | 「一键加装」演示位 |
| triggers | ✅ | ×6（巡检/夜班/SLA/看门狗/FAQ/断点周报） | F4.7 触发器 |
| threads | ✅ | ×5（completed/pending_review/running + 演示线程） | P2 线程页 |
| workspaces | ✅ | ×3（云栖 86 间 + 西溪 32 民宿型 + 满陇 24 无人型） | owner-cockpit 跨店数据基础 |
| profiles（一店一档） | ✅ | ×3；主店 20 字段组全量（含布草/断点/FAQ 演示值） | FAQ 候选带回源归因 |
| agents | ✅ | ×11 preset 实例（含只读/夜班/高危分布） | 班组名册 |
| members / tenants | ✅ | 3 人类成员（owner/manager/readonly） | 权限态演示 |
| industry_assets | ✅ | 行业共享资产（脱敏待装） | D15 上架流水线演示 |
| credentials | ✅ | 占位密文 ×2（只记引用 ID） | 凭据边界演示 |
| skill_publish_reviews | ✅ | 发布双人复核记录 | #42 越权修复后的留痕 |
| skill_revocations | ✅ | 吊销开关演示数据 | kill switch |
| im_inbound_dedupe | ✅ | 演示去重记录 | IM 幂等 |
| fence_rules(patch) | ✅ | 三客群 patch 模板随 Bundle | 客群化演示 |
| _migrations | ✅ | 8 个迁移文件 | 结构版本一致 |

## 二、场景/状态级覆盖（UI 十一页逐页核对）

| 页 | 场景状态 | 覆盖 | 兜底 |
|---|---|---|---|
| P1 晨间简报 | 昨日决策包 + 30 天趋势 | ✅ | Genie 每日刷新 |
| P2 线程 | completed/pending_review/running 三态 | ✅ | Genie 按需建线程 |
| P3 档案 | 20 字段组全量 + FAQ 候选待确认 | ✅ | — |
| P4 决断队列 | pending ×2（最新）+ 历史 approved/rejected | ✅ | Genie 持续产生新 pending |
| P5 围栏 | v3 规则卡 / dry-run ×3 / rolled_back 旧版 / patch | ✅ | Genie 现场发起 dry-run |
| P6 技能市场 | 25 技能 / 采纳率看板 / 待装行业技能 / 客群清单 | ✅ | — |
| P7 组织记忆 | 8 条记忆 + 归因 + confidence | ✅ | Genie 周频沉淀新记忆 |
| P8 班组 | 11 preset / 只读·夜班·高危徽标 / 协作拓扑 | ✅ | — |
| P9 夜班驾驶舱 | 30 晚班次 / 候选清单 / 三栏统计 / 快照 v3 | ✅ | Genie live tick 推进「今晚」 |
| P10 断点看板 | 根因四分类 / 收敛曲线 ×4 周 / 固化建议 | ✅（前端已接线 twin.incidents） | Genie 按需注入断点 |
| P11 价格健康 | 倒挂熔断 / 同步失败下架 / 调价归因 / 渠道健康分 | ✅（前端已接线 twin.priceHealth） | Genie 按需制造倒挂 |

## 三、诚实的缺口与兜底策略

静态快照是「**过去的 30 天**」。以下三类状态本质上是**活的**，静态数据无法覆盖——这正是 twin-genie（样板间管家）存在的理由：

| 缺口类型 | 例子 | 兜底策略 |
|---|---|---|
| **「现在进行时」** | 今天的订单、此刻的在住、正在进行的夜班 | Genie **live tick**：每 5 分钟按真实节奏写入新事件，画面永不冻结 |
| **交互后的新状态** | 客户现场点了「驳回」之后，驳回回流样本 | Genie **空态守卫**：巡检各 UI 域最小数据量，低于阈值自动补齐 |
| **客户临时点名的场景** | 「我想看一次差评危机全程」「制造一次倒挂」 | Genie **场景合成 API**：`POST /genie/scenario {kind}` 秒级生成完整剧情（事件+审批+留痕三段式） |

**原则：静态快照保证「深度」（30 天历史曲线），Genie 保证「活性」（此刻与未来）。两者叠加 = 与真实使用无区别。**

## 三点五、前端接线状态（v2.4.0 起）

P10–P20 全部为真实 API 接线页（apps/web + twinRouter：incidents/priceHealth/goals/events/objectTrail/archive/stores/report），数据源=事件库与一店一档，无独立模拟源；P1–P9 底座页原已接线。UI 用例 90 条为验收基准。移动端：≤860px 自动隐藏侧栏主区全宽。

## 四、版本纪律

- 快照（demo/twin/yunqi-30d.sql.gz）每次 Bundle 版本升级后重新生成，与本矩阵同步核对；
- 新增 UI 页/数据域时，必须先更新本矩阵再发版（覆盖门禁）；
- Genie 的场景合成种类随技能扩充（当前 7 类，见 `pnpm demo:twin:live` 启动日志）。
