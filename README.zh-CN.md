# BlueCode

为 [OpenCode](https://github.com/anomalyco/opencode) 提供上下文优化：通过一个插件挂载 RTK 工具输出压缩与 headroomd 历史归档。

[English](README.md) · [架构](docs/architecture.md) · [操作手册](docs/operations.md) · [实现与验收记录](docs/reliability-implementation.md)

本仓库是独立学习实现，不是 vivo 的 BlueCode 私有源码。评测使用本地合成数据。

## 工作方式

| 组件 | 职责 |
|---|---|
| RTK | 保守压缩已识别的命令输出，保护代码、diff 变更行和完整失败诊断。512 token 是软目标，保护内容允许超额。 |
| headroomd | 归档已完成轮次，构建证据记忆，持久化能够反复应用到新宿主消息数组的视图；保护近期轮次、活动工具及未知内容。 |
| 插件 | 每实例拥有客户端与状态，以真实 project/session 隔离检索；根据模型窗口规划，与上游 compaction 协调。 |
| 检索 | 全文分片、FTS5/BM25 搜索、经校验的归档恢复和有界游标分页；返回内容绕过 RTK。 |

RTK 使用 stdio 协议 v3，headroomd 使用 Unix socket 协议 v2。持久数据与临时 socket 分离。故障保留宿主可见内容或暂停规划；归档缺失、损坏会显式报告。RTK 保存实际收到文本的 sanitized 版本，无法恢复进入 hook 前已被宿主截去的内容。

## 本地运行

使用 **Bun 1.4.0**。目标平台为 Linux/macOS；本次本地验证在 macOS 完成，Linux 已配置 CI，执行状态以实际流水线为准。

```sh
bun install --frozen-lockfile
bun run verify
bun run eval --check --skip-latency
```

verify 包含全工作区 strict 类型检查、测试、依赖方向，以及宿主 bundle 不引入 SQLite 的检查。评测不需要模型密钥。

在 OpenCode 配置中挂载当前 checkout：

```json
{
  "plugin": [["file:///absolute/path/Bluecode/packages/plugin/src/index.ts", {
    "mode": "on",
    "rtk": {"budgetTokens": 512, "timeoutMs": 40, "minBytes": 512},
    "headroom": {"triggerRatio": 0.7, "targetRatio": 0.55, "retainRecentTurns": 4}
  }]]
}
```

宿主适配以已核实的 OpenCode **1.18.21** 为基准，部分 hook 属于 experimental API。参见[集成记录](docs/integration-notes.md)与[操作手册](docs/operations.md)，后者涵盖 off/shadow/on、配额、迁移和恢复。

## 回放实测

11 份 fixture、四组配置均使用生产 runtime；o200k_base 计数包括所有固定调用的重复上下文、问题和实际检索返回。

| 配置 | 总输入 token |
|---|---:|
| A：关闭优化 | 582,501 |
| B：仅 RTK | 464,781 |
| C：仅 headroomd | 529,923 |
| D：组合 | 435,436 |

默认 query-only 回放中，组合总输入减少 **25.25%**。C/D 自然问题 Recall@5 为 10/10；每组明确关键约束 3/3、确定性答案检查 10/10；D 归档逐字恢复 108/108。普通旧 fixture 上下文事实 B/D 为 102/104，单独披露。

这些是确定性内容检查，不能等同于真实 LLM 解题率或 provider 账单。主动展开全部命中文档的压力场景仅节省 **6.95%**，未达到 20% 成本门槛；32 并发时 RTK 在 40ms deadline 下发生13次降级。[完整口径、证据与限制](docs/reliability-implementation.md)、[评测 CLI](packages/eval/README.md)。

## 开发

七个工作区包分离协议、基础原语、RTK 纯策略、RTK 传输与存储、headroomd、插件及评测。评测直接依赖生产 runtime，两个 sidecar 互不依赖。旧插件 helper 保留用于兼容测试，不在生产工厂导入链路内。

参见[贡献指南](CONTRIBUTING.md)、[协议](docs/protocol.md)、[设计](docs/superpowers/specs/2026-09-05-reliability-design.md)、[实施计划](docs/superpowers/plans/2026-09-05-reliability.md)。

MIT，见 [LICENSE](LICENSE)。实现和文档由 AI 辅助完成；参考项目及许可边界列于验收记录。
