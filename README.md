# BlueCode

基于 opencode 插件机制的 coding agent 上下文工程组件库：`rtk`（工具输出压缩）与 `headroomd`（长会话上下文守护进程）。

> **声明**：本文档及 `docs/` 下一切量化数字，以 `packages/eval` 产出的实测值为准；凡未实测处一律标注为「目标」，不得视为实测结论。

## 组件

| 组件 | 作用 | 路径 |
|---|---|---|
| contracts | 两套 wire 协议的 zod schema 与消息投影契约 | `packages/contracts` |
| shared | JSONL 分帧、CAS、ANSI 剥离、token 计数 | `packages/shared` |
| rtk-core | 纯函数压缩管线：分类器 + 六策略 + 锚点保护 + 预算裁剪 | `packages/rtk-core` |
| rtk | stdio JSONL sidecar + 客户端（预热/超时/重启/熔断） | `packages/rtk` |
| headroomd | UDS 守护进程：轮次切分 + 确定性摘要 + SQLite/FTS 归档 | `packages/headroomd` |
| plugin | opencode 插件：六类 hook 挂载两个 sidecar，零核心改动 | `packages/plugin` |
| eval | 四组对照评测 harness + 基线门禁 | `packages/eval` |

## 快速开始

```bash
bun install
bun run verify          # 全仓 typecheck + test（含 eval 门禁）
bun run eval            # 产出评测报告
bun run eval --quick    # 快速档
bun run eval --check    # 对照已固化基线门禁
```

插件接入真实 opencode：项目 `opencode.json` 以元组形式挂载本仓 plugin 包：

```jsonc
{
  "plugin": [
    ["file:///path/to/bluecode/packages/plugin", { "rtk": {…}, "headroom": {…} }]
  ]
}
```

实机冒烟清单见 `packages/plugin/scripts/smoke.md`。

## 实测基线（packages/eval/baseline.json，2026-08-23 固化）

| 组 | 配置 | 压缩率（越低越省）¹ | 关键事实召回 | 降级率 |
|---|---|---|---|---|
| A | passthrough 基线 | 100% | — | 0 |
| B | rtk only | **35.6%** | 75/94 must-hit | 0 |
| C | headroomd only | **36.5%** | 88/94 must-hit | 0 |
| D | combined | **9.0%** | 74/94 must-hit | 0 |

¹ 压缩率 = 最终上下文 token / 原始上下文 token（同一口径，四组可直接比较；o200k_base 计数）。已知近似：D 组对发生 compaction 的 fixture，摘要基于 rtk 处理**前**的历史计算（两阶段独立测量），而真实插件链路中 headroom 经 SDK 读到的是 rtk 改写后的会话——故 D 组数字是组合效果的下界近似。简历目标量级为**目标**值；上表为当前模板参数下的实测。

<100% 召回的逐项 miss 清单与定性分析见 eval 报告 perFixture.recallMisses 与 devlog；harness 口径为「可检索 = 未丢失」（fetch 全部 refs + 逐事实 query 探查）。

## 文档

- [docs/architecture.md](docs/architecture.md) — 包布局、数据流、关键设计决策
- [docs/protocol.md](docs/protocol.md) — 两套 wire 协议规范
- [docs/integration-notes.md](docs/integration-notes.md) — opencode 上游 hook 核实记录
- [docs/devlog.md](docs/devlog.md) — 开发全程困难/错误与解决记录（#1-#34）
- [opencode-dev/](opencode-dev/) — 上游快照（只读，零改动）
