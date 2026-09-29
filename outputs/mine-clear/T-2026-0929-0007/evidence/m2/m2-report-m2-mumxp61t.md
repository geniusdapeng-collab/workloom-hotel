# M2 动态排雷执行记录（m2-mumxp61t）

- 目标：http://127.0.0.1:8820；工作区：yunqi-hotel
- 时间：2026-09-29T17:12:17.633Z → 2026-09-29T17:12:19.014Z
- 结果：3 通过 / 0 失败 / 0 观察 / 0 执行异常（共 3）

| 用例 | 维度 | 判定 | 期望 | 实测摘要 |
| --- | --- | --- | --- | --- |
| A1 | 主链路 | PASS | health 200 / system.health db=up / 三 token 互不相同 | health=200, db=up |
| A2 | 主链路 | PASS | dispatch 返回 pending_review 且带 pending_approval_id；批准后 threads.run 返回 completed 2/2 | dispatch=pending_review, approval=apr-e-12934, final=completed 2/2, run 回报 2/2, 未执行步骤=[] |
| E5 | 状态机（属性断言） | PASS | completed 且存在 pending 审批的线程数=0；completed 且 progress_done<progress_total 的线程数=0 | completed+未决审批=0 条（-）；completed+进度未满=0 条（-） |

## 失败/观察项明细
