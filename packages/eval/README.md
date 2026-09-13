# 评测：当前方案消融、分层回放与真实模型

本包提供四个入口，下面的命令均从仓库根目录运行。离线输入计数、真实 provider usage 和任务通过率采用不同口径，不合并为同一个收益数字。

| 入口 | 验证内容 | 是否调用外部 LLM | 已提交记录 |
|---|---|---|---|
| `bun run eval --headroom-strategy layered --retain-recent-turns 1` | RTK＋当前分层 headroom 的正式 A/B/C/D 消融 | 否；o200k_base 计数 | [一轮正式数据](retention-results/query-only-1.json) |
| `bun run eval:retention` | 五档保留轮数 × 两种检索策略，另加 24 份专用历史交叉检查 | 否；两种计量口径分别报告 | [运行清单](retention-results/manifest.json) |
| `bun run eval:headroom` | 24 份历史的新旧 headroom 对照与工程回放 | 否；字符数 / 4 估算 | [headroom-layered-results.json](headroom-layered-results.json) |
| `bun run eval:live` | 真实 OpenCode 编码任务、缓存 usage 和可选摘要尝试 | 是；须显式提供模型、密钥环境变量和预算 | [headroom-live-results.json](headroom-live-results.json) |

本轮正式消融见[配置与结果](../../docs/headroom-retention.md)，早期分层专用回放、实机结果与默认策略决定见 [headroom 验收报告](../../docs/headroom-layered-acceptance.md)。普通开发与默认 CI 使用离线入口，实机实验单独运行。

## 当前方案：生产插件四组消融

A（关闭两项）、B（RTK）、C（headroom）、D（组合）均调用生产使用的 `createPluginRuntime`。每份 fixture 分四个阶段送入，阶段内两次独立宿主调用均从原始宿主数组重新克隆：首次触发后台任务，`drain()` 后再次调用以应用持久视图。工具输出通过 `toolAfter`，检索通过 `createRetrieveTool`，不在评测中重新实现视图替换算法。

```sh
bun run eval --invariants --headroom-strategy layered --retain-recent-turns 1 \
  --retrieval-strategy query-only --report-path /tmp/layered-query.json
bun run eval --invariants --headroom-strategy layered --retain-recent-turns 1 \
  --retrieval-strategy eager-recovery --report-path /tmp/layered-eager.json
bun run eval --check --headroom-strategy legacy --skip-latency \
  --report-path /tmp/legacy-regression.json
```

`--headroom-strategy legacy|layered` 与 `--retain-recent-turns N` 传入真实插件，N 为非负整数，0 始终保留当前轮次。历史回放的省略值仍固定为 legacy / 4，独立于生产 layered 的一轮默认值。`--benchmarks` 同样接收显式轮数。报告的 `meta.headroomStrategy/retainRecentTurns` 与每行 `replay.headroom` 来源于实际配置，另记录持久活动视图策略。

当前一轮 query-only 四组输入为 **582,501 / 464,781 / 391,029 / 338,584**，组合降低 **41.87%**；eager-recovery 组合输入 **428,885**，降低 **26.37%**，两组均通过绝对门禁。一轮相对四轮组合进一步减少 **8.30%** 输入，0 轮额外减少三条可见事实，因此采用 1。原 `baseline.json` 未覆盖，四轮的 36.61% / 19.72% 继续保存在[历史实验](../../docs/headroom-ablation.md)。

`bun run eval:retention` 重跑 0～4 轮全部对照并更新 `retention-results`：11 份 fixture × 四组 × 两种检索，共 440 条；专用历史 24 × 五档，共 120 条。原有消融按 o200k_base，专用历史按字符数 / 4，不能合并数字。新驱动记录提交号、工作区源码差异摘要和驱动摘要。选择依据、五档表格和仍存在的六例自然检索问题见[轮数报告](../../docs/headroom-retention.md)。

`--report-path` / `EVAL_REPORT_PATH` 和 `--baseline-path` / `EVAL_BASELINE_PATH` 可分别注入目的路径；API `writeReport(report, path)`、`readReport(path)`、`checkBaseline(update, {reportPath, baselinePath})` 同样支持隔离。测试在临时目录建立自己的报告和基线，不替换或恢复仓库跟踪文件。`--update-baseline` 必须完整运行且所有绝对门禁通过；比较旧基线的相对回归门禁是另一项检查。

## 四组消融的计量口径

这是本地、确定性的回放代理指标，不代表外部模型真实 usage 或实际软件任务解决能力。精确 token 计数采用 o200k_base，对明确的角色标记与可见消息文本表示计数；不估计提供商隐藏的聊天模板。所有固定宿主调用、十个问题的调用、实际返回的检索工具输出和此后重复输入这些证据的成本都累计。`outTokens` 和 `compressionRatio` 单独表示最终上下文；不得把最终比例称为总成本节省。

两种检索策略在执行前固定，均不读取 golden answer 决定是否继续检索：

- `query-only`（默认）：每道自然问句调用真实 query 工具，最多五个排名命中，必要时跟随 query cursor；同一排名命中的续页按 hash/chunkId 与连续 source offset 拼接，第五个命中也会读完全部续页；偏移缺口明确报错。返回的原文 snippet 直接成为模型可见证据。之后才使用预先给定的期望标识符评分。
- `eager-recovery`（压力场景）：在同样的 query 操作后，对所有前五命中的不同文档强制逐页展开完整内容，每页均成为一次实际模型输入。额外成本单独报告，不能替代默认策略或隐藏其失败。

档案完整性探针是评测器验证操作，不作为模型证据或任务成功来源：RTK 按项目/会话命名空间分页读回，拼接后与原始终端文本的 sanitized 版本逐字比较；headroom 按 history cursor 读回，允许页内切分消息，对每条 source ID 的原始角色、文本、工具输入/输出/错误渲染逐字比较。不能只以 `found: true` 判定恢复成功。

旧十份 fixture 的 `mustHit` / `niceToHave` 指标保留为普通上下文保留率；其中包含工具清单与终端瞬态状态，不冒充关键约束。新增工程回放含三个明确关键约束、十八个完整轮次和活动请求、十个独立自然问句/期望标识符。`critical`、`naturalRecallAt5`、`tasks` 与 `archiveRecovery` 分开计数；无 query 的 A/B 使用 null，不报告虚构的 100% 检索率。

## 四组消融的绝对门禁与边界

关键约束 100%、档案逐字恢复 100%、确定性答案标识符比较 100%，跨命名空间、旧计划替换新编辑、检索结果被再次 RTK 压缩各 0 次违规；要求非空实际探针。C/D 自然 Recall@5 ≥90%，D 总输入相对 A 至少降低 20%。基线再弱也不会降低这些目标。先检查每条 fixture 的质量与安全结果，再从各行重算所有 replay 聚合字段（包含调用数、检索 token、探针及 RSS）和档案计数/率；组级摘要必须与重算结果完全一致，不能用成功摘要掩盖失败行。相对基线仍比较压缩比例、上下文回忆、档案数量和延迟回归。

每个 fixture 的延迟不包含客户端 create/connect 启动握手；吞吐与冷启动不能从这些值直接推断。延迟分为工具 hook、transform、等待后台 planning drain、实际检索和档案探针的端到端耗时。现有公开客户端没有暴露 RPC 队列/服务内部分段，故 `queueMs` / `serviceMs` 明确为 null，不能从总耗时伪造分解。`deadlineMs` 是 RTK 配置预算，hook p50/p95 是实测经过时间。RSS 是评测主进程采样峰值，不含独立 sidecar，也不是操作系统级精确峰值。

`--benchmarks` 使用真实共享客户端和同一个插件实例测量 1/8/32 并发。记录完成调用、计划、过载、降级、RSS、延迟，允许真实队列饱和和 40ms 超时出现，不使用脆弱的墙钟性能断言。CI 在 Linux/macOS、Bun 1.4.0 下执行冻结依赖安装、类型检查、测试、依赖方向门禁以及一次完整回放；共享硬件仅跳过相对 p95 延迟门禁，报告始终上传。Linux 的实测状态以 CI 运行结果为准。

## Headroom 分层离线对照

```sh
bun run eval:headroom --output /tmp/headroom-layered-results.json
```

8 类场景各覆盖 50、200、1,000 轮，共 24 份确定性历史。每个策略使用生产 runtime 与独立启动的 daemon，在四个历史前缀各执行两次 transform，计入尚未发布规则计划的第一次输入。查询先返回至多五个短命中，再展开首命中的一页；检索内容进入后续输入，其重复成本一并累计。原文 hash 完整性探针单独计量，不计入模型输入。

计数采用 `ceil(UTF-16 字符数 / 4)`，与冻结基线的 o200k_base 和实机 provider usage 分开解释。报告记录分析缓存命中、扫描量、daemon CPU、采样 RSS 以及规划队列／服务耗时；这些字段不是 provider 缓存命中或账单。压缩超时即停止该组剩余回放，标记 `incomplete`，不参与收益比较。

提交结果中分层版完成 24/24，新旧可比较 17/24，累计估算输入降低 **71.99%**；旧版七个 1,000 轮组超时。重复输出 50/200 轮分别增加 **2.79% / 12.20%**，自然查询证据为 18/24，须保留这些回归。每组一个预选原文来源逐字恢复为 24/24，不等同于矩阵已逐项恢复全部档案；另有独立测试在第 2、5、20 代重启后恢复此前所有确认来源。

同一报告中的工程回放使用“查询＋首命中展开”，累计输入 197,686 → 181,048，降低 **8.42%**，两组事实 10/10、约束 3/3。其绝对输入不能与冻结基线的其他检索策略直接比较。[完整结果](headroom-layered-results.json)

## 真实 OpenCode 对照

以下为已完成实验使用的入口与上限；运行前应在当前环境配置对应密钥变量。模型的可用性和收费状态应在新实验开始前重新核实，不能将一次历史免费记录视为后续调用的价格保证。

```sh
bun run eval:live --model opencode/mimo-v2.5-free \
  --api-key-env OPENCODE_ZEN_API_KEY --max-requests 720 \
  --max-input-tokens 80000000 --max-output-tokens 1474560 \
  --concurrency 4 --task-timeout-ms 600000 \
  --output /tmp/headroom-live-results.json
```

12 个固定小型编码任务 × 三种策略（`legacy`、分层规则、规则＋增强尝试）× 两次重复，共 72 次。每个任务先导入 14 轮合成材料，再由真实 OpenCode 调用模型完成编码；导入历史不是模型生成的生产会话。宿主使用隔离目录与 npm 缓存，RTK 统一关闭，每个任务最多 8 次主模型请求。实机压力配置为 40,000 token 输入窗口、2,048 输出上限、128 token 历史记忆预算，不能代表默认 4,096 记忆配置。

任务通过以可执行测试为准，另外验证关键约束；非测试修复任务要求原验证器不变，测试修复任务要求修复后的测试在正确实现上通过、对应错误实现上失败。事实、文件状态、下一步和决策依据四类续接探针单独报告，不用工具退出码或摘要长度代替任务成功。

`OpenCode tokens.input` 不含缓存，完整输入按 `input + cacheRead + cacheWrite` 汇总。摘要 usage、实际应用的增强候选和主模型 usage 分列，未知值为 `null`。输入按完整 UTF-8 请求字节加包装余量保守预约，输出按请求上限预约；预约量不是实际消费。预算耗尽或必要 usage 缺失时，实验标记未完成。

提交结果的 72 次主任务全部通过。分层规则版相对旧版累计完整输入降低 **36.71%**，缓存外输入增加 **29.62%**，输出增加 **13.58%**。因此不能把总输入缩减直接当作付费账单同比下降。可选摘要共尝试 32 次，31 次收到 Zen 的 `MissingSessionID`、1 次传输失败，**没有增强候选实际应用**；增强对照保留 `incomplete: true`，CLI 按设计退出 2。主任务完成与增强效果验收是两项独立结果。[实机原始记录](headroom-live-results.json)

历史实机入口显式固定 `retainRecentTurns=4` 并记录在报告中，避免新默认值改变旧对照；本轮轮数实验没有真实模型调用。当前默认策略仍为 `legacy`，LLM 增强继续关闭；配置、候选校验和回退方式见[使用指南](../../docs/headroom-layered.md)。
