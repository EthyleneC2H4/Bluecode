# 真实插件回放评测

A（关闭两项）、B（RTK）、C（headroom）、D（组合）均调用生产使用的 `createPluginRuntime`。每份 fixture 分四个阶段送入，阶段内两次独立宿主调用均从原始宿主数组重新克隆：首次触发后台任务，`drain()` 后再次调用以应用持久视图。工具输出通过 `toolAfter`，检索通过 `createRetrieveTool`，不在评测中重新实现视图替换算法。

```sh
bun run eval --invariants --benchmarks --report-path /tmp/default-report.json
bun run eval --invariants --retrieval-strategy eager-recovery --report-path /tmp/eager-report.json
bun run eval --check --skip-latency --report-path /tmp/regression-report.json
```

`--report-path` / `EVAL_REPORT_PATH` 和 `--baseline-path` / `EVAL_BASELINE_PATH` 可分别注入目的路径；API `writeReport(report, path)`、`readReport(path)`、`checkBaseline(update, {reportPath, baselinePath})` 同样支持隔离。测试在临时目录建立自己的报告和基线，不替换或恢复仓库跟踪文件。`--update-baseline` 必须完整运行且所有绝对门禁通过；比较旧基线的相对回归门禁是另一项检查。

## 口径

这是本地、确定性的回放代理指标，不代表外部模型真实 usage 或实际软件任务解决能力。精确 token 计数采用 o200k_base，对明确的角色标记与可见消息文本表示计数；不估计提供商隐藏的聊天模板。所有固定宿主调用、十个问题的调用、实际返回的检索工具输出和此后重复输入这些证据的成本都累计。`outTokens` 和 `compressionRatio` 单独表示最终上下文；不得把最终比例称为总成本节省。

两种检索策略在执行前固定，均不读取 golden answer 决定是否继续检索：

- `query-only`（默认）：每道自然问句调用真实 query 工具，最多五个排名命中，必要时跟随 query cursor；同一排名命中的续页按 hash/chunkId 与连续 source offset 拼接，第五个命中也会读完全部续页；偏移缺口明确报错。返回的原文 snippet 直接成为模型可见证据。之后才使用预先给定的期望标识符评分。
- `eager-recovery`（压力场景）：在同样的 query 操作后，对所有前五命中的不同文档强制逐页展开完整内容，每页均成为一次实际模型输入。额外成本单独报告，不能替代默认策略或隐藏其失败。

档案完整性探针是评测器验证操作，不作为模型证据或任务成功来源：RTK 按项目/会话命名空间分页读回，拼接后与原始终端文本的 sanitized 版本逐字比较；headroom 按 history cursor 读回，允许页内切分消息，对每条 source ID 的原始角色、文本、工具输入/输出/错误渲染逐字比较。不能只以 `found: true` 判定恢复成功。

旧十份 fixture 的 `mustHit` / `niceToHave` 指标保留为普通上下文保留率；其中包含工具清单与终端瞬态状态，不冒充关键约束。新增工程回放含三个明确关键约束、十八个完整轮次和活动请求、十个独立自然问句/期望标识符。`critical`、`naturalRecallAt5`、`tasks` 与 `archiveRecovery` 分开计数；无 query 的 A/B 使用 null，不报告虚构的 100% 检索率。

## 绝对门禁与边界

关键约束 100%、档案逐字恢复 100%、确定性答案标识符比较 100%，跨命名空间、旧计划替换新编辑、检索结果被再次 RTK 压缩各 0 次违规；要求非空实际探针。C/D 自然 Recall@5 ≥90%，D 总输入相对 A 至少降低 20%。基线再弱也不会降低这些目标。先检查每条 fixture 的质量与安全结果，再从各行重算所有 replay 聚合字段（包含调用数、检索 token、探针及 RSS）和档案计数/率；组级摘要必须与重算结果完全一致，不能用成功摘要掩盖失败行。相对基线仍比较压缩比例、上下文回忆、档案数量和延迟回归。

每个 fixture 的延迟不包含客户端 create/connect 启动握手；吞吐与冷启动不能从这些值直接推断。延迟分为工具 hook、transform、等待后台 planning drain、实际检索和档案探针的端到端耗时。现有公开客户端没有暴露 RPC 队列/服务内部分段，故 `queueMs` / `serviceMs` 明确为 null，不能从总耗时伪造分解。`deadlineMs` 是 RTK 配置预算，hook p50/p95 是实测经过时间。RSS 是评测主进程采样峰值，不含独立 sidecar，也不是操作系统级精确峰值。

`--benchmarks` 使用真实共享客户端和同一个插件实例测量 1/8/32 并发。记录完成调用、计划、过载、降级、RSS、延迟，允许真实队列饱和和 40ms 超时出现，不使用脆弱的墙钟性能断言。CI 在 Linux/macOS、Bun 1.4.0 下执行冻结依赖安装、类型检查、测试、依赖方向门禁以及一次完整回放；共享硬件仅跳过相对 p95 延迟门禁，报告始终上传。Linux 的实测状态以 CI 运行结果为准。
