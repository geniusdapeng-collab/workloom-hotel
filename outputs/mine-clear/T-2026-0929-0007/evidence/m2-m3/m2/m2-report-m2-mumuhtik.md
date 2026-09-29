# M2 动态排雷执行记录（m2-mumuhtik）

- 目标：http://127.0.0.1:8802；工作区：yunqi-hotel
- 时间：2026-09-29T15:42:35.948Z → 2026-09-29T15:42:40.516Z
- 结果：20 通过 / 7 失败 / 1 观察 / 0 执行异常（共 28）

| 用例 | 维度 | 判定 | 期望 | 实测摘要 |
| --- | --- | --- | --- | --- |
| A1 | 主链路 | PASS | health 200 / system.health db=up / 三 token 互不相同 | health=200, db=up |
| A2 | 主链路 | FAIL | dispatch 返回 pending_review 且带 pending_approval_id；批准后 threads.run 返回 completed 2/2 | dispatch=pending_review, approval=apr-e-9109, final=completed 1/2, run 回报 2/2, 未执行步骤=["s2"] |
| A3 | 主链路/语义层 | FAIL | 默认路由应把「回复差评」交给带 review.reply 的岗位并走挂起审批；派给他岗并以不相关工具 completed 判 FAIL（假交付） | 错配：preset=competitor-agent，线程终态=completed，实际执行动作=["competitor.crawl"]（用户目标是差评回复，未发生 review.reply） |
| A4 | 主链路 | FAIL | dispatch 返回 completed；DB 内 price.adjust 步骤带 after.price 且无 pending 审批（用 2% 同时满足 R1 ≤8% 与 R7 夜班 ≤3% 的 auto 区间） | preset=pricing-agent, status=pending_review, after=null |
| A5 | 主链路 | PASS | dispatch 返回 kind=clarify 且工作区线程数不增加 | kind=clarify, threads 7→7 |
| A6 | 主链路 | PASS | dispatch 返回 mode=ask 且带非空 answer；线程终态 completed | mode=ask, answer 长度=107 |
| B1 | 并发 | PASS | 仅 1 路非 deduped；approvals.status=approved；approval.gesture 事件恰 1 条；无 5xx | 生效=1，5xx=0，gesture 事件=1 |
| B2 | 并发 | FAIL | 无 5xx；成功数 ≤10；每路 threadId 唯一；429 为预期拒绝码 | 成功=12, 429=0, 5xx=0 |
| B3 | 并发 | PASS | 全部请求不 5xx；终态唯一；该线程 step 事件不重复 | 5xx=0, 终态=completed, 重复 step=0 |
| B4 | 并发 | PASS | 全部成功；过期项不重复标；同项不重复写手势事件 | 5xx=0, 状态分布=[{"status":"approved","n":3},{"status":"pending","n":2}] |
| C1 | 异常注入/配置 | PASS | saveLlmConfig 拒绝落盘（400）且 .env 的 LLM_PROVIDER 保持 mock | status=400, LLM_PROVIDER=mock |
| C2 | 异常注入 | FAIL | 线程仍建立（按标题规划），服务端出现 [dispatch] 未取到档案 警告 | threadId=T-122, 日志含警告=false |
| C3 | 异常注入/状态机 | PASS | 驳回后线程不得永久滞留 pending_review；必须有可解释的出口（终态或可续跑） | 驳回后状态=cancelled，run 后=completed（若仍滞留说明无出口） |
| C4 | 异常注入 | OBSERVE | 观察行为：是否产生两条独立线程（幂等键缺失） | 同一目标生成两条线程 T-124 / T-125（无幂等键） |
| C5 | 异常注入/环境 | PASS | 线程不得永久 running；应落到可解释终态且日志留痕 | dispatch=pending_review, 终态=pending_review 1/3 |
| D1 | 边界 | PASS | 空标题 400；500 字接受；501 字 400 | 空=400, 500=200, 501=400 |
| D2 | 边界/注入 | PASS | 创建成功且 DB 中标题与输入逐字一致；无 5xx | 创建=3/3，逐字一致=true |
| D3 | 边界 | PASS | 0 与 201 被 400 拒绝；1 与 200 正常返回 | 0=400, 1=200, 200=200, 201=400 |
| D4 | 边界 | PASS | 非法 status 被 400 拒绝 | status=400 |
| D5 | 边界 | PASS | 空数组 400；51 项 400（上限 50） | 空=400, 51=400 |
| D6 | 边界 | PASS | 200 字接受；201 字 400 | 200 字=200, 201 字=400 |
| E1 | 状态机 | PASS | 重复 run completed 线程不产生重复 step 事件、状态不变 | before=completed, after=completed, 重复执行=0 |
| E2 | 状态机 | PASS | 过期快照 decide 被拒并标 expired；不会出现 approved | decide=400, 终态=expired |
| E3 | 状态机/联动 | PASS | nightShift.deliver 正常推进状态机；若被安全网关拒绝判 FAIL | deliver=200；班次状态 package_generated → package_generated |
| E4 | 状态机/越权 | PASS | readonly dispatch/run 403；跨工作区 threadId 查询返回空（不泄露存在性） | readonly dispatch=403, run=403, 不存在线程查询=null |
| F1 | 业务错误 | PASS | 不存在审批 400/404（当前实现 BAD_REQUEST）；readonly 裁决 403；非法手势 400（结构校验） | 不存在=400, readonly=403, 非法手势=400 |
| F2 | 配置错误/环境 | FAIL | runBeat 在规则装载后仍可写事件；若被系统级禁写 500 判 FAIL | status=500, eventId=- |
| F3 | 环境错误 | FAIL | 存在消费点：trigger_fires 有记录 / trigger.fired 事件存在；否则判 FAIL（触发器空转） | 种子触发器 10/10 启用，trigger_fires=0，trigger.fired 事件=0 |

## 失败/观察项明细

### A2 差评回复闭环（指定口碑岗）：派遣→挂起→人工批准→续跑完成（FAIL）

- 期望：dispatch 返回 pending_review 且带 pending_approval_id；批准后 threads.run 返回 completed 2/2
- 实测：dispatch=pending_review, approval=apr-e-9109, final=completed 1/2, run 回报 2/2, 未执行步骤=["s2"]
- 证据：API 5 条 / DB 4 条 / 日志 1 段

### A3 差评回复闭环（用户默认入口：不指定岗位，模拟对话框派任务）（FAIL）

- 期望：默认路由应把「回复差评」交给带 review.reply 的岗位并走挂起审批；派给他岗并以不相关工具 completed 判 FAIL（假交付）
- 实测：错配：preset=competitor-agent，线程终态=completed，实际执行动作=["competitor.crawl"]（用户目标是差评回复，未发生 review.reply）
- 证据：API 2 条 / DB 2 条 / 日志 1 段

### A4 调价闭环（价带内 2% 应 auto 完成，不产生审批）（FAIL）

- 期望：dispatch 返回 completed；DB 内 price.adjust 步骤带 after.price 且无 pending 审批（用 2% 同时满足 R1 ≤8% 与 R7 夜班 ≤3% 的 auto 区间）
- 实测：preset=pricing-agent, status=pending_review, after=null
- 证据：API 2 条 / DB 5 条 / 日志 1 段

### B2 12 路并发派遣（工作区并发上限 10）（FAIL）

- 期望：无 5xx；成功数 ≤10；每路 threadId 唯一；429 为预期拒绝码
- 实测：成功=12, 429=0, 5xx=0
- 证据：API 12 条 / DB 3 条 / 日志 1 段

### C2 goalRef 指向不存在档案 → fail-closed 且留日志（FAIL）

- 期望：线程仍建立（按标题规划），服务端出现 [dispatch] 未取到档案 警告
- 实测：threadId=T-122, 日志含警告=false
- 证据：API 1 条 / DB 4 条 / 日志 1 段

### C4 重复提交同一目标（模拟双击）（OBSERVE）

- 期望：观察行为：是否产生两条独立线程（幂等键缺失）
- 实测：同一目标生成两条线程 T-124 / T-125（无幂等键）
- 证据：API 2 条 / DB 1 条 / 日志 1 段

### F2 CEO 节拍在围栏规则装载后的可用性（company-ceo 写权限）（FAIL）

- 期望：runBeat 在规则装载后仍可写事件；若被系统级禁写 500 判 FAIL
- 实测：status=500, eventId=-
- 证据：API 1 条 / DB 0 条 / 日志 1 段

### F3 触发器引擎是否有生产调度（cron 触发器实际触发）（FAIL）

- 期望：存在消费点：trigger_fires 有记录 / trigger.fired 事件存在；否则判 FAIL（触发器空转）
- 实测：种子触发器 10/10 启用，trigger_fires=0，trigger.fired 事件=0
- 证据：API 0 条 / DB 3 条 / 日志 1 段
