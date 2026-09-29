# 基座回灌说明（T-2026-0929-0007 → workloom-im）

> 本仓（workloom-hotel）本轮修复含 **3 个基座受管路径**（`sync/base-scope.json` include：`packages/base/**`、`scripts/**`）。
> 若不回灌基座，下一次 full 代码波次会把本仓的修复覆盖掉（`lastSyncedBaseSha` 一推进即复发）。
> 基座车道请以下述 patch 为准，按基座口径重做/合并；本文件即交接单。

## 一键应用

```bash
cd <workloom-im>
git apply --3way /path/to/upstream-base.patch
```

patch：`outputs/mine-clear/T-2026-0929-0007/upstream-base.patch`（253 行，含 `packages/base/captain/loop.ts`、`packages/base/captain/ceo-actor.test.ts`、`scripts/suite.ts`）

## 逐项说明与基座侧注意点

1. **`packages/base/captain/loop.ts`**：把写死的 `CEO_ACTOR` 换成 `ceoActor(client, scope)`（从 `agents` 表按 `preset_key='company-ceo'` 读 `readonly/fence_bindings`；缺编留空绑定 → 网关 F2.10 拒写）。
   - 基座注意：基座 `bundles/ai-pm` 没有 `company-ceo` 岗位，因此基座自身行为不变（绑定为空，且 ai-pm 围栏未登记 `ceo.briefing` 为写类动作）。
   - 该实现与 `WorkLoom-growth` 车道已有的 `ceoActor()` 同形（`packages/base/captain/loop.ts:26-45 @WorkLoom-growth`）——实验车道先验证的实现按 §10.2 需**提案任务卡**后才能在基座落地，本 patch 即提案的实现载体。

2. **`packages/base/captain/ceo-actor.test.ts`**：四态单测（在编/缺编/只读/身份一致性），直接复用网关 `checkPermission`；测试内显式 `registerWriteActions(["ceo.briefing"])` 复刻装配期登记。
   - 基座注意：`@workloom/base/workdata` 需导出 `checkPermission` 与 `EventDraft`（本仓已导出）。

3. **`scripts/suite.ts`**：
   - `STUB_PORT` 支持 `SUITE_STUB_PORT` 覆盖 + 值域校验（多会话/多副本并行必需）；
   - W 域探针 `ensureWProbe/wEvent` 声明 `fence_bindings`（否则「门禁拒绝无绑定探针」会被误读成投影链路失败）；
   - 新增 Z-05「CEO 节拍 actor 绑定同源」双向断言。
   - **基座注意（移植前置条件）**：Z-05 依赖工作区存在 `company-ceo` 岗位。基座 `ai-pm` 包没有该岗位，直接搬会红——请按 Z-03 的既有做法改成**跨仓可移植**（无该岗位时 skip 并给出说明），或保留本仓本地版、基座只搬 `SUITE_STUB_PORT` 与探针绑定两处。

## 建议的基座侧追加（本仓未做，属基座职责）

- `scripts/check-derived-builds.mjs`：目标包不存在时按仓形态判定（本仓无 `packages/ui`，UI 走稳定制品 tarball）→ 见台账 MC-004；
- `packages/base/bundles/bundles.test.ts` 等 6 条行业仓不可移植断言（自服务包口径写死）→ 见台账 MC-008；
- `.cnb.yml` 秘密扫描步骤与受理清单下发到订阅仓 → 见台账 MC-013；
- release-gate 工作区探测口径（`is_example=true` 被套件清掉）→ 见台账 MC-010。
