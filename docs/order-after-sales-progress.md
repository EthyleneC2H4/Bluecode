# 订单与售后修改计划进度

截至 2026-09-27。对应仓库上层《修改计划.md》的 B1→B4 顺序；详细设计与复现见[评测说明](order-after-sales-evaluation.md)。

| 阶段 | 当前状态 | 证据／剩余事项 |
| --- | --- | --- |
| B1 业务契约与验收 | 已完成离线闭环 | 三份固定快照；参考实现 3/3 通过，错误实现 14/14 被拒绝；见[有效性记录](../packages/eval/evidence/order-after-sales/acceptance-validity.json) |
| B2 隔离执行 | 已完成离线机制检查 | Docker Agent 与独立验证容器、临时令牌代理、宿主保存的轨迹、两组有效配置和清理命令；在线凭据不进入容器 |
| B3 观测 | 已完成离线机制检查 | 每次运行保存 manifest、补丁、事件、usage、验收与轨迹；缺失 provider usage 为 `null`；见[离线压力结果](../packages/eval/evidence/order-after-sales/offline-pressure/result.json) |
| B4 免费模型实验 | 待运行 | [16 项完整清单](../packages/eval/evidence/order-after-sales/online-pending.json)均未运行；缺 Zen 免费模型凭据，因此自然任务／压力任务的在线报告与真实成功／失败案例尚无数据 |

本阶段只有离线失败复盘及参考实现成功验证，不把二者包装成在线 Agent 案例。正式在线实验前再次核查官方定价与模型 ID，固定镜像及代码摘要，然后按冻结 AB／BA 顺序运行全部 12＋4 项并保留失败。若免费模型不可用，保留未运行状态，不改用付费模型。

## 本地验证记录

- `bun run eval:business validate`：参考实现 3/3 通过，错误实现 14/14 被拒绝。
- `bun test` 与 `bun run typecheck`：审阅修复后的完整 `verify` 中 880 项通过、1 项模板测试跳过、0 项失败；代理鉴权／预算、输出目录保护和压缩消费顺序均有定向测试。
- `bun run check:security`、`bun run eval:security:host /tmp/bluecode-business-security-host.json`：通过；宿主检查首次与回放并行运行时进程组清理报错，单独复跑通过，未复现。
- `bun run eval --invariants --headroom-strategy layered --retain-recent-turns 1 --report-path /tmp/bluecode-business-replay.json`：通过；这是旧有离线回放指标，不能填入本业务在线结果。
- `bun run verify`：审阅修复后的类型、全部测试、依赖、宿主与安全门禁通过。离线压力试跑的镜像摘要和评测器摘要保存在其 manifest 中；该次运行早于后续文档补充。
