# M2 动态排雷执行记录（m2-mumxnyey）

- 目标：http://127.0.0.1:8820；工作区：yunqi-hotel
- 时间：2026-09-29T17:11:21.083Z → 2026-09-29T17:11:21.110Z
- 结果：1 通过 / 2 失败 / 0 观察 / 0 执行异常（共 3）

| 用例 | 维度 | 判定 | 期望 | 实测摘要 |
| --- | --- | --- | --- | --- |
| A1 | 主链路 | FAIL | health 200 / system.health db=up / 三 token 互不相同 | health=0, db=undefined |
| A2 | 主链路 | FAIL | dispatch 返回 pending_review 且带 pending_approval_id；批准后 threads.run 返回 completed 2/2 | dispatch 未返回 threadId：{"transportError":"TypeError: fetch failed"} |
| E5 | 状态机（属性断言） | PASS | completed 且存在 pending 审批的线程数=0；completed 且 progress_done<progress_total 的线程数=0 | completed+未决审批=0 条（-）；completed+进度未满=0 条（-） |

## 失败/观察项明细

### A1 健康检查 + 三成员登录（owner/manager/readonly）（FAIL）

- 期望：health 200 / system.health db=up / 三 token 互不相同
- 实测：health=0, db=undefined
- 证据：API 2 条 / DB 0 条 / 日志 1 段

### A2 差评回复闭环（指定口碑岗）：派遣→挂起→人工批准→续跑完成（FAIL）

- 期望：dispatch 返回 pending_review 且带 pending_approval_id；批准后 threads.run 返回 completed 2/2
- 实测：dispatch 未返回 threadId：{"transportError":"TypeError: fetch failed"}
- 证据：API 1 条 / DB 0 条 / 日志 1 段
