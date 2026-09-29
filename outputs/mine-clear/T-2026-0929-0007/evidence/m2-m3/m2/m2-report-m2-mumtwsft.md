# M2 动态排雷执行记录（m2-mumtwsft）

- 目标：http://127.0.0.1:8802；工作区：yunqi-hotel
- 时间：2026-09-29T15:26:14.777Z → 2026-09-29T15:26:15.362Z
- 结果：2 通过 / 23 失败 / 2 观察 / 1 执行异常（共 28）

| 用例 | 维度 | 判定 | 期望 | 实测摘要 |
| --- | --- | --- | --- | --- |
| A1 | 主链路 | FAIL | health 200 / system.health db=up / 三 token 互不相同 | health=0, db=undefined |
| A2 | 主链路 | FAIL | dispatch 返回 pending_review 且带 pending_approval_id；批准后 threads.run 返回 completed 2/2 | dispatch 未返回 threadId：{"transportError":"TypeError: fetch failed"} |
| A3 | 主链路/语义层 | FAIL | 默认路由应把「回复差评」交给带 review.reply 的岗位并走挂起审批；派给他岗并以不相关工具 completed 判 FAIL（假交付） | dispatch 未返回 threadId：{"transportError":"TypeError: fetch failed"} |
| A4 | 主链路 | FAIL | dispatch 返回 completed；DB 内 price.adjust 步骤带 after.price 且无 pending 审批 | dispatch 未返回 threadId：{"transportError":"TypeError: fetch failed"} |
| A5 | 主链路 | FAIL | dispatch 返回 kind=clarify 且工作区线程数不增加 | kind=?, threads 58→58 |
| A6 | 主链路 | FAIL | dispatch 返回 mode=ask 且带非空 answer；线程终态 completed | mode=undefined, answer 长度=0 |
| B1 | 并发 | FAIL | 仅 1 路非 deduped；approvals.status=approved；approval.gesture 事件恰 1 条；无 5xx | 未拿到待审审批 |
| B2 | 并发 | FAIL | 无 5xx；成功数 ≤10；每路 threadId 唯一；429 为预期拒绝码 | 成功=0, 429=0, 5xx=0 |
| B3 | 并发 | OBSERVE | 全部请求不 5xx；终态唯一；该线程 step 事件不重复 | B2 未产出可续跑线程，跳过 |
| B4 | 并发 | PASS | 全部成功；过期项不重复标；同项不重复写手势事件 | 5xx=0, 状态分布=[{"status":"approved","n":496},{"status":"edited","n":4},{"status":"expired","n":8},{"status":"pending","n":34},{"status":"rejected","n":78}] |
| C1 | 异常注入/配置 | FAIL | saveLlmConfig 拒绝落盘（400）且 .env 的 LLM_PROVIDER 保持 mock | status=0, LLM_PROVIDER=mock |
| C2 | 异常注入 | FAIL | 线程仍建立（按标题规划），服务端出现 [dispatch] 未取到档案 警告 | threadId=-, 日志含警告=false |
| C3 | 异常注入/状态机 | FAIL | 驳回后线程不得永久滞留 pending_review；必须有可解释的出口（终态或可续跑） | 未拿到待审审批 |
| C4 | 异常注入 | PASS | 观察行为：是否产生两条独立线程（幂等键缺失） | deduped（undefined） |
| C5 | 异常注入/环境 | FAIL | 线程不得永久 running；应落到可解释终态且日志留痕 | dispatch=?, 终态=- -/- |
| D1 | 边界 | FAIL | 空标题 400；500 字接受；501 字 400 | 空=0, 500=0, 501=0 |
| D2 | 边界/注入 | FAIL | 创建成功且 DB 中标题与输入逐字一致；无 5xx | 创建=0/3，逐字一致=true |
| D3 | 边界 | FAIL | 0 与 201 被 400 拒绝；1 与 200 正常返回 | 0=0, 1=0, 200=0, 201=0 |
| D4 | 边界 | FAIL | 非法 status 被 400 拒绝 | status=0 |
| D5 | 边界 | FAIL | 空数组 400；51 项 400（上限 50） | 空=0, 51=0 |
| D6 | 边界 | FAIL | 200 字接受；201 字 400 | 200 字=0, 201 字=0 |
| E1 | 状态机 | FAIL | 重复 run completed 线程不产生重复 step 事件、状态不变 | before=undefined, after=undefined, 重复执行=0 |
| E2 | 状态机 | ERROR | 过期快照 decide 被拒并标 expired；不会出现 approved |  |
| E3 | 状态机/联动 | OBSERVE | nightShift.deliver 正常推进状态机；若被安全网关拒绝判 FAIL | 无夜班班次可投递 |
| E4 | 状态机/越权 | FAIL | readonly dispatch/run 403；跨工作区 threadId 查询返回空（不泄露存在性） | readonly dispatch=0, run=0, 不存在线程查询=有数据 |
| F1 | 业务错误 | FAIL | 不存在审批 404；readonly 裁决 403；非法手势 400（结构校验） | 不存在=0, readonly=0, 非法手势=0 |
| F2 | 配置错误/环境 | FAIL | runBeat 在规则装载后仍可写事件；若被系统级禁写 500 判 FAIL | status=0, eventId=- |
| F3 | 环境错误 | FAIL | 存在消费点：trigger_fires 有记录 / trigger.fired 事件存在；否则判 FAIL（触发器空转） | 种子触发器 14/16 启用，trigger_fires=0，trigger.fired 事件=0 |

## 失败/观察项明细

### A1 健康检查 + 三成员登录（owner/manager/readonly）（FAIL）

- 期望：health 200 / system.health db=up / 三 token 互不相同
- 实测：health=0, db=undefined
- 证据：API 2 条 / DB 0 条 / 日志 1 段

### A2 差评回复闭环（指定口碑岗）：派遣→挂起→人工批准→续跑完成（FAIL）

- 期望：dispatch 返回 pending_review 且带 pending_approval_id；批准后 threads.run 返回 completed 2/2
- 实测：dispatch 未返回 threadId：{"transportError":"TypeError: fetch failed"}
- 证据：API 1 条 / DB 0 条 / 日志 1 段

### A3 差评回复闭环（用户默认入口：不指定岗位，模拟对话框派任务）（FAIL）

- 期望：默认路由应把「回复差评」交给带 review.reply 的岗位并走挂起审批；派给他岗并以不相关工具 completed 判 FAIL（假交付）
- 实测：dispatch 未返回 threadId：{"transportError":"TypeError: fetch failed"}
- 证据：API 1 条 / DB 0 条 / 日志 1 段

### A4 调价闭环（价带内 5% 应 auto 完成，不产生审批）（FAIL）

- 期望：dispatch 返回 completed；DB 内 price.adjust 步骤带 after.price 且无 pending 审批
- 实测：dispatch 未返回 threadId：{"transportError":"TypeError: fetch failed"}
- 证据：API 1 条 / DB 0 条 / 日志 1 段

### A5 含糊指令→反问澄清（不建任务）（FAIL）

- 期望：dispatch 返回 kind=clarify 且工作区线程数不增加
- 实测：kind=?, threads 58→58
- 证据：API 1 条 / DB 2 条 / 日志 1 段

### A6 问数闭环（ask 模式即时应答）（FAIL）

- 期望：dispatch 返回 mode=ask 且带非空 answer；线程终态 completed
- 实测：mode=undefined, answer 长度=0
- 证据：API 1 条 / DB 0 条 / 日志 1 段

### B1 12 路并发裁决同一审批（只允许一次生效）（FAIL）

- 期望：仅 1 路非 deduped；approvals.status=approved；approval.gesture 事件恰 1 条；无 5xx
- 实测：未拿到待审审批
- 证据：API 2 条 / DB 0 条 / 日志 1 段

### B2 12 路并发派遣（工作区并发上限 10）（FAIL）

- 期望：无 5xx；成功数 ≤10；每路 threadId 唯一；429 为预期拒绝码
- 实测：成功=0, 429=0, 5xx=0
- 证据：API 12 条 / DB 3 条 / 日志 1 段

### B3 12 路并发续跑同一线程（replay 幂等）（OBSERVE）

- 期望：全部请求不 5xx；终态唯一；该线程 step 事件不重复
- 实测：B2 未产出可续跑线程，跳过
- 证据：API 0 条 / DB 0 条 / 日志 1 段

### C1 模型配置写入（不可达 baseUrl）必须 fail-closed（FAIL）

- 期望：saveLlmConfig 拒绝落盘（400）且 .env 的 LLM_PROVIDER 保持 mock
- 实测：status=0, LLM_PROVIDER=mock
- 证据：API 1 条 / DB 0 条 / 日志 1 段

### C2 goalRef 指向不存在档案 → fail-closed 且留日志（FAIL）

- 期望：线程仍建立（按标题规划），服务端出现 [dispatch] 未取到档案 警告
- 实测：threadId=-, 日志含警告=false
- 证据：API 1 条 / DB 1 条 / 日志 1 段

### C3 驳回路径出口探测：挂起线程被驳回后是否可达终态（FAIL）

- 期望：驳回后线程不得永久滞留 pending_review；必须有可解释的出口（终态或可续跑）
- 实测：未拿到待审审批
- 证据：API 2 条 / DB 0 条 / 日志 1 段

### C5 外部工具不可用时的手尾（海报生图工具未配置）（FAIL）

- 期望：线程不得永久 running；应落到可解释终态且日志留痕
- 实测：dispatch=?, 终态=- -/-
- 证据：API 1 条 / DB 0 条 / 日志 1 段

### D1 标题长度边界 0 / 500 / 501（FAIL）

- 期望：空标题 400；500 字接受；501 字 400
- 实测：空=0, 500=0, 501=0
- 证据：API 3 条 / DB 0 条 / 日志 1 段

### D2 注入式/畸形标题（SQL / HTML / emoji / 零宽字符）原样落库不炸（FAIL）

- 期望：创建成功且 DB 中标题与输入逐字一致；无 5xx
- 实测：创建=0/3，逐字一致=true
- 证据：API 3 条 / DB 1 条 / 日志 1 段

### D3 事件流分页 limit 边界 0 / 1 / 200 / 201（FAIL）

- 期望：0 与 201 被 400 拒绝；1 与 200 正常返回
- 实测：0=0, 1=0, 200=0, 201=0
- 证据：API 4 条 / DB 0 条 / 日志 1 段

### D4 审批状态过滤非法枚举（FAIL）

- 期望：非法 status 被 400 拒绝
- 实测：status=0
- 证据：API 1 条 / DB 0 条 / 日志 1 段

### D5 批量裁决边界：空数组 / 51 项（FAIL）

- 期望：空数组 400；51 项 400（上限 50）
- 实测：空=0, 51=0
- 证据：API 2 条 / DB 0 条 / 日志 1 段

### D6 驳回原因长度边界 200 / 201（FAIL）

- 期望：200 字接受；201 字 400
- 实测：200 字=0, 201 字=0
- 证据：API 4 条 / DB 0 条 / 日志 1 段

### E1 completed 线程再 run（replay 是否幂等）（FAIL）

- 期望：重复 run completed 线程不产生重复 step 事件、状态不变
- 实测：before=undefined, after=undefined, 重复执行=0
- 证据：API 1 条 / DB 3 条 / 日志 1 段

### E2 过期审批：decide 与 sweep 的终态一致性（ERROR）

- 期望：过期快照 decide 被拒并标 expired；不会出现 approved
- 实测：column "expires_at" of relation "approvals" does not exist
error: column "expires_at" of relation "approvals" does not exist
    at /Users/mac/WorkLoom-fleet/.wt-mc-hotel-m23/node_modules/.pnpm/pg-pool@3.14.0_pg@8.23.0/node_modules/pg-pool/index.js:45:11
    at process.processTicksAndRejections (node:internal/process/task_queues:104:5)
    at async q (file:///Users/mac/WorkLoom-fleet/.wt-mc-hotel-m23/outputs/mine-clear/T-2026-0929-0007/scripts/m2-runner.mjs:95:13)
- 证据：API 0 条 / DB 0 条 / 日志 1 段

### E3 夜班决策包投递（夜班出口链路）（OBSERVE）

- 期望：nightShift.deliver 正常推进状态机；若被安全网关拒绝判 FAIL
- 实测：无夜班班次可投递
- 证据：API 1 条 / DB 0 条 / 日志 1 段

### E4 readonly 成员越权与跨工作区读取（FAIL）

- 期望：readonly dispatch/run 403；跨工作区 threadId 查询返回空（不泄露存在性）
- 实测：readonly dispatch=0, run=0, 不存在线程查询=有数据
- 证据：API 3 条 / DB 1 条 / 日志 1 段

### F1 业务错误路径：不存在审批 / 越权角色 / 非法手势（FAIL）

- 期望：不存在审批 404；readonly 裁决 403；非法手势 400（结构校验）
- 实测：不存在=0, readonly=0, 非法手势=0
- 证据：API 3 条 / DB 0 条 / 日志 1 段

### F2 CEO 节拍在围栏规则装载后的可用性（company-ceo 写权限）（FAIL）

- 期望：runBeat 在规则装载后仍可写事件；若被系统级禁写 500 判 FAIL
- 实测：status=0, eventId=-
- 证据：API 1 条 / DB 0 条 / 日志 1 段

### F3 触发器引擎是否有生产调度（cron 触发器实际触发）（FAIL）

- 期望：存在消费点：trigger_fires 有记录 / trigger.fired 事件存在；否则判 FAIL（触发器空转）
- 实测：种子触发器 14/16 启用，trigger_fires=0，trigger.fired 事件=0
- 证据：API 0 条 / DB 3 条 / 日志 1 段
