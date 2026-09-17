# VSecAgent 宿主、归档与兼容性验收

本记录对应[批准设计](superpowers/specs/2026-09-17-vsecagent-design.md)的本地接入范围。规则质量、性能和首次失败见[独立评测报告](vsecagent-evaluation.md)。本轮全程使用合成数据与本地模拟服务，外部 LLM 调用为零；企业生产接口仍需单独验收。

## 真实 OpenCode 1.18.23

通过 [`security-host.ts`](../packages/eval/src/security-host.ts) 启动真实宿主及生产插件。本地 SSE 服务只返回预定工具调用，MCP 服务只操作临时目录；代码中的危险命令仅送入扫描器，不送入真实 shell。RTK/headroom 的全局压缩模式为 off，安全模式 enforce。

| 场景 | 实际检查 |
| --- | --- |
| standard | 凭证写入未创建文件；正常写入、读取、精确编辑和安全 printf 完成；MCP 敏感写入未执行、普通读取脱敏；general 子 Agent 的写入也经过同一 before Hook |
| patch | 含凭证的多文件 patch 整次阻断，安全配套文件也未创建；随后独立安全 patch 成功 |
| code-mode | execute 内调用 MCP save 时触发嵌套检查，敏感写入阻断；MCP read 正常执行并脱敏 |
| scanner-failure | 退出的扫描进程使 write 与未知 MCP 副作用阻断；明确 read 可以执行，返回文本被遮蔽 |

所有场景检查过滤后的真实模型请求中不存在合成凭证；健康场景父任务约束 `Keep PUBLIC_API.` 保留。故障场景连用户文本也不能完成脱敏，因此明确遮蔽，不声称约束仍完整。子任务使用自己的输入，不把父任务约束未复制到子任务计为压缩或安全能力。

[原始宿主记录](../packages/eval/security-host-results.json)包含固定宿主版本、运行环境、生产源码/驱动摘要、逐次请求的泄漏布尔值、工具 Hook 与 MCP 执行轨迹及无副作用检查，不保存原始模型消息。复现：

```sh
bun run eval:security:host /tmp/vsec-host.json
```

第一次实机运行发现：仅替换 `output.system/messages/context` 属性没有更新宿主保存的原数组，导致系统文本中的合成凭证进入 mock 模型。修复改为数组原地更新，加入保留数组引用的回归；随后四场景通过。该问题说明纯对象 mock 不能替代真实宿主链路。

## 脱敏证据贯穿压缩与归档

[`security-pipeline.test.ts`](../packages/plugin/test/security-pipeline.test.ts) 使用真实 VsecClient、RTK 子进程与 headroom 引擎，确认合成凭证不进入过滤后的工具返回、模型可见视图、RTK 逐字恢复、headroom 检索、解压后的 CAS 或 SQLite/FTS 文件，非敏感约束保留。

[`security-archive.test.ts`](../packages/headroomd/test/security-archive.test.ts) 另外检查原始凭证在持久化前被拒绝、策略绑定阻止降级和旧目录隐式迁移、可选摘要输入先过滤及新生成摘要在缓存和节点哈希前脱敏。摘要服务是本地注入模拟函数，无外部调用。分页源游标保持不变，检索继续绕过 RTK，并按当前策略检查。

扫描故障或超限导致的文本遮蔽明确设置 `metadata.vsec.withheld`，RTK 不接收该输出，也不把减少的长度记为压缩。故障元数据的内部键保持固定，仅可配置文本值再过滤，避免清洗键名导致该标记失效。

## 安全关闭的压缩回归

两轮各使用原有 11 份 fixture × A/B/C/D、o200k_base 累计输入口径。结果与已有相同策略记录逐组完全一致：

| 配置 | legacy／四轮 | layered／一轮 |
| --- | ---: | ---: |
| A 关闭压缩 | 582,501 | 582,501 |
| B 仅 RTK | 464,781 | 464,781 |
| C 仅 headroom | 529,923 | 391,029 |
| D 组合 | 435,436 | 338,584 |

[本轮 legacy 结果](../packages/eval/security-off-legacy.json)通过原[冻结基线](../packages/eval/baseline.json)门禁；[本轮 layered 结果](../packages/eval/security-off-layered.json)通过绝对验收，与[已有一轮确认记录](../packages/eval/retention-results/confirmed-query-only-1.json)一致。本轮不重定义旧指标，不把安全拦截当作压缩节省。

```sh
EVAL_SKIP_LATENCY=1 EVAL_REPORT_PATH=/tmp/vsec-off-legacy.json bun run eval --check --benchmarks
EVAL_SKIP_LATENCY=1 EVAL_REPORT_PATH=/tmp/vsec-off-layered.json bun run eval --invariants --headroom-strategy layered --retain-recent-turns 1
```

## 最终本地门禁

发布前 `bun run verify` 通过：**861 项测试、12,301 个断言、0 失败**，另有全仓严格类型检查、9 包依赖方向、宿主 bundle 排除 SQLite/安全解析器及 160/320 安全质量门禁。macOS 本地结果已确认；Linux/macOS CI 的远端状态以 GitHub 实际运行结果为准。

## 发布范围

本轮交付本地规则、独立扫描进程、Hook 接线、安全归档、企业 SDK 适配接口和模拟验收。完整系统沙箱、跨文件污点分析、手工 shell／提前执行的模板命令、后续插件修改、TOCTOU 和非文本附件不在已证明的强制控制范围。源码与证据由 Codex 辅助编写并经可执行测试和独立代码审查验证；这些结果不能外推为企业线上拦截率。
