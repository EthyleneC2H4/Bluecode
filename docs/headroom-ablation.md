# RTK＋当前分层 headroom 四组消融

2026-09-11 在同一代码版本 `e1c1781289090550cb024d77befc445ae8427c93` 上重新运行原有 11 份 fixture。正式方案为 `layered` 规则版，LLM 摘要关闭。分别运行旧版 query-only 对照、分层 query-only 正式组和分层 eager-recovery 压力组，每次均完整执行 A/B/C/D，共 132 条 fixture／组记录；未调用外部 LLM。

原始记录：[旧版对照](../packages/eval/ablation-legacy-query.json)、[当前 query-only](../packages/eval/ablation-layered-query.json)、[当前 eager-recovery](../packages/eval/ablation-layered-eager.json)。[运行清单](../packages/eval/ablation-summary.json)保存代码版本、fixture 名称与摘要、报告 SHA-256、配置和门禁结果。

## 固定实验配置

| 项目 | 设置 |
|---|---|
| 历史 | 原有 11 份 fixture，内容未改；包括长会话、九类工具输出和工程回放 |
| 回放 | 每组四个历史阶段，每阶段两次从原始宿主数组创建的 transform；包含计划尚未发布的第一次输入 |
| 计数 | o200k_base；显式角色、文本、工具输入／输出／错误，计入问题、检索及后续重复输入 |
| 模型窗口 | context 8192、输出预留 1024；runtime 再扣除系统提示估算和 512 余量 |
| Headroom | C/D 选择 layered，70% 触发、55% 目标，保留近期四个完整轮次及活动轮次；记忆上限 4096、比例 15%；摘要关闭 |
| RTK | B/D 启用，512 token 软预算、40ms 时限、512 字节门槛 |
| 检索外层限额 | 各组均显式请求 8192 token / 32768 字节；各策略内部格式和预算换算保持其实际实现 |
| 隔离与执行 | 每次回放使用新的临时数据目录、真实插件 runtime 与 sidecar；三次回放顺序执行，无并发压力测试混入 |
| 环境 | macOS，Bun 1.4.0；运行时报告 Node 兼容版本 v26.3.0 |

query-only 固定为每个自然问题检索前五命中的片段，消费 query cursor 以接全已选中的命中，不自动展开原文档；eager-recovery 在相同查询后，逐页展开这些命中的所有不同文档。搜索 query 不含评测期望答案，原文完整性验证不作为模型证据或解题成功依据。分层策略的命中卡片与旧版 segments 属于各自方案，实验评估包含检索在内的整个 headroom 路径，而非单独隔离摘要算法。

## 正式 query-only 结果

| 组别 | 总输入 token | 相对 A 减少 | 检索返回 token | 计量的输入调用 |
|---|---:|---:|---:|---:|
| A：关闭优化 | 582,501 | — | 0 | 98 |
| B：仅 RTK | 464,781 | 20.21% | 0 | 98 |
| C：仅分层 headroom | 434,209 | 25.46% | 3,390 | 108 |
| D：RTK＋分层 headroom | 369,220 | **36.61%** | 3,487 | 108 |

D 相对 B 进一步减少 **20.56%** 输入，相对 C 减少 **14.97%**。这些比值按累计输入计算，不使用最终摘要长度代替总成本，也不是 provider usage 或账单。

| 质量与边界 | A | B | C | D |
|---|---:|---:|---:|---:|
| 关键约束 | 3/3 | 3/3 | 3/3 | 3/3 |
| 确定性答案检查 | 10/10 | 10/10 | 10/10 | 10/10 |
| 自然问题 Recall@5 | 未检索 | 未检索 | 10/10 | 10/10 |
| 已选归档逐字恢复 | 未归档 | 32/32 | 30/30 | 62/62 |
| 普通上下文事实 | 104/104 | 102/104 | 104/104 | 102/104 |

三类实际安全探针的违规均为零：跨项目／会话访问、过期计划应用、检索返回再次被 RTK 压缩。C/D 在长会话与工程回放中实际发布并应用分层视图，各记录 12 次应用；其他短工具 fixture 没有强行压缩。所有 fixture 的降级记录和 runtime 错误均为零。

恢复计数是各方案实际选择的档案，分层版主要归档工具材料并保留用户原文，因此其来源集合与旧版不同；不能把 108→62 解释为丢失 46 项证据。验证按每个当前 manifest 的来源及 RTK 原文逐项比较，并检验命名空间隔离。query-only 的全部绝对门禁通过，CLI 退出 0。

## 旧版对照与压力组

本轮旧版 query-only 对照得到 A/B/C/D 输入 **582,501 / 464,781 / 529,923 / 435,436**，与冻结基线完全一致。A/B 在三次实验中也完全一致。当前 D 从旧版 435,436 降至 369,220，即相对旧组合进一步减少 **15.21%**；相对 A 的降幅由 25.25% 增至 36.61%。[baseline.json](../packages/eval/baseline.json)继续保持原样。

| 分层压力组 | C：仅 headroom | D：组合 |
|---|---:|---:|
| eager-recovery 总输入 | 531,773 | 467,608 |
| 检索返回 token | 7,089 | 7,186 |
| 计量的输入调用 | 118 | 118 |

eager-recovery 质量、归档恢复及安全检查通过，但 D 相对 A 只减少 **19.72%**，低于 20% 门槛。`--invariants` 退出 1，唯一失败项为 `combinedNetInput`，不将其描述为全部通过。相对正式 query-only，多次重新输入完整文档使组合输入增加 98,388 token。

## 复现与验收

从仓库根目录运行；以下相对 `--report-path` 由 `bun run eval` 在 `packages/eval` 下解析：

```sh
bun run eval --invariants --headroom-strategy legacy \
  --retrieval-strategy query-only --report-path ablation-legacy-query.json
bun run eval --invariants --headroom-strategy layered \
  --retrieval-strategy query-only --report-path ablation-layered-query.json
bun run eval --invariants --headroom-strategy layered \
  --retrieval-strategy eager-recovery --report-path ablation-layered-eager.json
```

如只复查实验而不更新提交记录，改用 `/tmp/` 下的绝对报告路径。`--headroom-strategy` 省略时保留 legacy，兼容冻结基线；当前正式实验须显式指定 layered。每行 `replay.headroom` 记录实际配置及活动视图策略，报告顶部的策略由这些行聚合得出。

首轮试运行发现检索包装预算可能将 RTK 的 `maxTokens` 请求放大到协议上限 8192 以上，导致 B/D 的 RTK 回取被拒绝。修复仅限制传给下游的 token 参数，保留外层字节预算与完整分页；新增真实 RTK 子进程回归先复现失败，再验证 Unicode 原文多页恢复。修复前数据未作为正式结果，三组均在修复后的同一提交重跑。

修复后 `bun run verify` 通过 **580 项测试、11369 条断言、84 个测试文件**，以及七个包的类型检查、依赖方向和宿主 SQLite 边界检查。三份报告的逐行计数、聚合与原文恢复计数均重新校验；压力组的失败门槛单独保留。

本次确认标准 4096 记忆预算下的离线消融效果；它不替代默认配置的真实模型验收，也不验证 LLM 摘要增强。插件默认仍为 legacy，摘要仍关闭。早期 128 token 记忆预算的实机压力实验及其 36.71% 输入降幅保持独立，见[分层验收记录](headroom-layered-acceptance.md)。

实现、文档与核验由 AI 辅助完成；所有数值来自以上实际离线运行记录，不将合成历史当作生产会话。
