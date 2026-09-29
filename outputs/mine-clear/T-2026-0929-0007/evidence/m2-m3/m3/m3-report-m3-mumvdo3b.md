# M3 联动排雷执行记录（m3-mumvdo3b）

- 目标：http://127.0.0.1:8802
- 时间：2026-09-29T16:07:21.912Z → 2026-09-29T16:07:26.497Z
- 结果：3 通过 / 7 失败 / 2 观察 / 0 异常（共 12）

| 用例 | 维度 | 判定 | 期望 | 实测摘要 |
| --- | --- | --- | --- | --- |
| M3-A1 | 联动基线 | PASS | 基线可读且一致（线程数、待审批数、剧场人数） | 任务 46 / 待批 4 / 剧场 11 人 |
| M3-A2 | 联动（状态变更） | FAIL | 任务页 pending_review 且带 pending_approval_id；审批页出现该单；剧场对应员工 asking 且 approvalId 一致；播报不出现（未终结） | 任务=pending_review 审批=pending 剧场=blocked(approvalId=false) 播报=false |
| M3-A3 | 联动（状态变更） | PASS | 任务页 completed；审批页不再 pending 且状态 approved；剧场不再 asking；播报包含该线程；账本事件流应含裁决动作（缺则记联动断点） | 任务=completed 审批=approved 剧场=blocked 播报=有；断点：裁决动作不在任务事件流（approval.gesture session_id=NULL） |
| M3-A4 | 联动（驳回路径） | FAIL | 任务页 cancelled；审批页 rejected 且带原因；播报包含 cancelled 线程；剧场“驳回→遇阻”表达必须由其声明机制驱动（floor 读 decision.params.gesture=reject 且 actor=员工 preset_key） | 任务=cancelled 审批=rejected 播报=cancelled；剧场=blocked；驳回→遇阻分支接线=false（生产 after.gesture=reject/who=human，floor 读 params.gesture=NULL） |
| M3-A5 | 联动（覆盖度机检） | OBSERVE | 统计 biz_events 中无 session_id（非线程）事件占比；这些事件在任务页/账本页（threads.events 投影）均不可见 | 事件 198 条，其中非线程事件（session_id NULL）62 条（31%）在 /events 账本页与任务事件流中不可见 |
| M3-B1 | 联动（跨端/出厂默认） | FAIL | 出厂 .env/.env.example 未声明 SERVICE_C_*，按产品文档口径应先可用或明确给出可执行的配置引导；此处如实记录实际返回 | 默认配置 C 端会话=503（C 端工作区未配置，请设置 SERVICE_C_WORKSPACE_ID 或 SERVICE_C_WORKSPACE_MAP） |
| M3-B2 | 联动（跨端/官方首启路径） | FAIL | 官方推荐首启路径必须让 C 端可达；若指向不存在的工作区（酒店仓只有 ws-yunqi）判 FAIL | preview:all 口径 C 端会话=503（C 端配置的工作区不存在，请联系管理员检查站点映射） |
| M3-B3 | 联动（跨端/全配） | PASS | 三面一致：C 端创建成功；PC service.tickets.list 命中；PC advance 后 C 端 /c/tickets 读到新状态 | C=processing PC=assigned 推进=200 |
| M3-C1 | 问答覆盖 | FAIL | 答案中的待审批数量 == DB count(approvals where pending) | DB=4，回答命中=false，answer=关于「现在有多少条待审批？」：
· 事件库规模：201 条五元事件（哈希链可验）
以上数字均来自事件库实时取数，可下钻溯源。 |
| M3-C2 | 问答覆盖 | FAIL | 若回答只能给系统统计、给不出任何具体审批/事件明细，判覆盖不足（FAIL） | 回答未含任何被驳回审批明细（DB 有 3 条样本）；answer=关于「上个月被驳回的调价有哪些？」：
· 事件库规模：203 条五元事件（哈希链可验）
以上数字均来自事件库实时取数，可下钻溯源。 |
| M3-C3 | 问答覆盖 | OBSERVE | 行业包未注册 ask 事实面时，回答应至少明确说明无该数据（不得用系统统计冒充营收） | 未声称有营收数据（回答=关于「本月营收多少？」：
· 事件库规模：205 条五元事件（哈希链可验）
以上数字均来自事件库实时取数，可下钻溯源。） |
| M3-C4 | 问答覆盖（对照） | FAIL | 短问句下若仍只有“事件库规模/动作分布”这类系统统计、而“当前待审批/进行中线程”被挤出，说明事实排序与问题无关（120 字硬闸按固定顺序截断） | 回答含“当前待审批”事实=false、含“进行中线程”=false；answer=关于「待审批？」： · 事件库规模：207 条五元事件（哈希链可验） 以上数字均来自事件库实时取数，可下钻溯源。 |

### M3-A1 主链路五个面基线快照（任务/审批/剧场/播报/账本）（PASS）

- 期望：基线可读且一致（线程数、待审批数、剧场人数）
- 实测：任务 46 / 待批 4 / 剧场 11 人
- 证据：API 7 条 / DB 1 条
- 备注：
  - 清位 0 条 queued/running
  - 任务=46，待批=4，剧场员工=11，已结算=20

### M3-A2 派遣差评 Quest → 挂起：任务页 / 审批页 / 剧场 / 播报 逐面取证（FAIL）

- 期望：任务页 pending_review 且带 pending_approval_id；审批页出现该单；剧场对应员工 asking 且 approvalId 一致；播报不出现（未终结）
- 实测：任务=pending_review 审批=pending 剧场=blocked(approvalId=false) 播报=false
- 证据：API 8 条 / DB 3 条
- 备注：
  - 变更前 review-agent=blocked；变更后=blocked
  - 任务页 entry={"id":"T-147","title":"回复那条 2 分差评（联动探针） [m3-mumvdo3b]","mode":"quest","status":"pending_review","progress_done":1,"progress_total":2,"created_by":"MEM-001","agent_id":"agt-review-agent","created_at":"2026-09-29T16:07:22.666Z"}；审批单=apr-e-9191/pending；剧场=blocked/null；播报含本线程=false
  - 线程事件流动作=["thread.dispatch","review.list","review.reply"]
  - 断点：挂起事件 rule_impact 仍带 result=blocked（W-01 降级保留原 impacts）→ 剧场按“遇阻”渲染且优先级高于 asking，approvalId 丢失（无法直达审批）

### M3-A3 批准 + 续跑 → 完成：任务页 / 审批页 / 剧场 / 播报 / 账本 逐面取证（PASS）

- 期望：任务页 completed；审批页不再 pending 且状态 approved；剧场不再 asking；播报包含该线程；账本事件流应含裁决动作（缺则记联动断点）
- 实测：任务=completed 审批=approved 剧场=blocked 播报=有；断点：裁决动作不在任务事件流（approval.gesture session_id=NULL）
- 证据：API 8 条 / DB 2 条
- 备注：
  - 剧场 review-agent=blocked（celebrating=false）；播报=completed@2026-09-29T16:07:23.031Z；账本动作=["thread.dispatch","review.list","review.reply"]

### M3-A4 驳回 → 任务取消：任务页 / 审批页 / 剧场 / 播报 四面对账（FAIL）

- 期望：任务页 cancelled；审批页 rejected 且带原因；播报包含 cancelled 线程；剧场“驳回→遇阻”表达必须由其声明机制驱动（floor 读 decision.params.gesture=reject 且 actor=员工 preset_key）
- 实测：任务=cancelled 审批=rejected 播报=cancelled；剧场=blocked；驳回→遇阻分支接线=false（生产 after.gesture=reject/who=human，floor 读 params.gesture=NULL）
- 证据：API 7 条 / DB 2 条
- 备注：
  - 清位 0 条 queued/running
  - 驳回后：任务=cancelled，审批=rejected/reply.tone，剧场 review-agent=blocked，播报=cancelled
  - 手势事件字段：who=human:MEM-001，after.gesture=reject，params.gesture=NULL

### M3-A5 事件账本/任务事件流的数据源覆盖度（OBSERVE）

- 期望：统计 biz_events 中无 session_id（非线程）事件占比；这些事件在任务页/账本页（threads.events 投影）均不可见
- 实测：事件 198 条，其中非线程事件（session_id NULL）62 条（31%）在 /events 账本页与任务事件流中不可见
- 证据：API 0 条 / DB 2 条
- 备注：
  - 动作分布=[{"action":"thread.dispatch","n":45,"no_session":0},{"action":"price.adjust","n":20,"no_session":0},{"action":"review.reply","n":19,"no_session":0},{"action":"approval.gesture","n":18,"no_session":8},{"action":"competitor.fetch","n":11,"no_session":10},{"action":"content.publish","n":10,"no_session":0},{"action":"order.reconcile","n":10,"no_session":10},{"action":"order.refund","n":10,"no_session":10},{"action":"inspection.scan","n":10,"no_session":10},{"action":"review.list","n":9,"no_session":0},{"action":"price.scan","n":4,"no_session":0},{"action":"ask.answer","n":4,"no_session":0}]

### M3-B1 出厂默认配置下 C 端会话可用性（FAIL）

- 期望：出厂 .env/.env.example 未声明 SERVICE_C_*，按产品文档口径应先可用或明确给出可执行的配置引导；此处如实记录实际返回
- 实测：默认配置 C 端会话=503（C 端工作区未配置，请设置 SERVICE_C_WORKSPACE_ID 或 SERVICE_C_WORKSPACE_MAP）
- 证据：API 1 条 / DB 0 条
- 备注：
  - 默认配置 /c/session → 503 "C 端工作区未配置，请设置 SERVICE_C_WORKSPACE_ID 或 SERVICE_C_WORKSPACE_MAP"

### M3-B2 pnpm preview:all 口径（SERVICE_C_WORKSPACE_ID=ws-aipm-demo）C 端会话可用性（FAIL）

- 期望：官方推荐首启路径必须让 C 端可达；若指向不存在的工作区（酒店仓只有 ws-yunqi）判 FAIL
- 实测：preview:all 口径 C 端会话=503（C 端配置的工作区不存在，请联系管理员检查站点映射）
- 证据：API 1 条 / DB 1 条
- 备注：
  - preview:all 口径 /c/session → 503 "C 端配置的工作区不存在，请联系管理员检查站点映射"

### M3-B3 正确配置（SERVICE_C_WORKSPACE_ID=ws-yunqi）：C 端建单 → PC 服务前台可见 → 推进 → C 端回读（PASS）

- 期望：三面一致：C 端创建成功；PC service.tickets.list 命中；PC advance 后 C 端 /c/tickets 读到新状态
- 实测：C=processing PC=assigned 推进=200
- 证据：API 5 条 / DB 1 条
- 备注：
  - C 端建单=tck-mumvdrdx0016pax；PC 服务前台命中=true（assigned）；推进返回={"ticket":{"id":"tck-mumvdrdx0016pax","workspaceId":"ws-yunqi","cUserId":"cu-mumvdr9z001gn3x","conversationId":"conv [m3；C 端回读=processing（处理中）

### M3-C1 ask 计数类：待审批数量应与数据库事实一致（FAIL）

- 期望：答案中的待审批数量 == DB count(approvals where pending)
- 实测：DB=4，回答命中=false，answer=关于「现在有多少条待审批？」：
· 事件库规模：201 条五元事件（哈希链可验）
以上数字均来自事件库实时取数，可下钻溯源。
- 证据：API 1 条 / DB 1 条
- 备注：
  - DB 待审批=4；ask 回答=关于「现在有多少条待审批？」：
· 事件库规模：201 条五元事件（哈希链可验）
以上数字均来自事件库实时取数，可下钻溯源。

### M3-C2 ask 明细类：被驳回的调价明细（FAIL）

- 期望：若回答只能给系统统计、给不出任何具体审批/事件明细，判覆盖不足（FAIL）
- 实测：回答未含任何被驳回审批明细（DB 有 3 条样本）；answer=关于「上个月被驳回的调价有哪些？」：
· 事件库规模：203 条五元事件（哈希链可验）
以上数字均来自事件库实时取数，可下钻溯源。
- 证据：API 1 条 / DB 1 条
- 备注：
  - DB 最近被驳回=[{"approval_id":"apr-e-9195","status":"rejected","action":"review.reply"},{"approval_id":"apr-e-9181","status":"rejected","action":"review.reply"},{"approval_id":"apr-e-9169","status":"rejected","action":"review.reply"}]；回答=关于「上个月被驳回的调价有哪些？」：
· 事件库规模：203 条五元事件（哈希链可验）
以上数字均来自事件库实时取数，可下钻溯源。；sources 未见（产品未在响应暴露 sources）

### M3-C3 ask 行业数据类：本月营收（OBSERVE）

- 期望：行业包未注册 ask 事实面时，回答应至少明确说明无该数据（不得用系统统计冒充营收）
- 实测：未声称有营收数据（回答=关于「本月营收多少？」：
· 事件库规模：205 条五元事件（哈希链可验）
以上数字均来自事件库实时取数，可下钻溯源。）
- 证据：API 1 条 / DB 0 条
- 备注：
  - answer=关于「本月营收多少？」：
· 事件库规模：205 条五元事件（哈希链可验）
以上数字均来自事件库实时取数，可下钻溯源。

### M3-C4 ask 短问句对照：事实装填顺序是否与问题相关（FAIL）

- 期望：短问句下若仍只有“事件库规模/动作分布”这类系统统计、而“当前待审批/进行中线程”被挤出，说明事实排序与问题无关（120 字硬闸按固定顺序截断）
- 实测：回答含“当前待审批”事实=false、含“进行中线程”=false；answer=关于「待审批？」： · 事件库规模：207 条五元事件（哈希链可验） 以上数字均来自事件库实时取数，可下钻溯源。
- 证据：API 1 条 / DB 2 条
- 备注：
  - DB 待审批=4、进行中=6；回答=关于「待审批？」： · 事件库规模：207 条五元事件（哈希链可验） 以上数字均来自事件库实时取数，可下钻溯源。
