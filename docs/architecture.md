# BlueCode 架构

基于 opencode 插件机制的上下文工程组件库。核心原则：**零核心改动**——`opencode-dev/` 上游快照不被修改，全部能力经插件 hook 与 sidecar 进程注入。

## 包布局

```
packages/
  contracts/   协议层：zod schema（rtk/headroomd 两套 wire 协议、消息投影）
  shared/      基础层：JSONL 分帧、CAS 存储、ANSI 剥离、token 计数、脱敏钩子位
  rtk-core/    纯函数压缩管线：分类器 + 六策略 + 锚点保护 + 预算裁剪
  rtk/         进程层：stdio JSONL server + RtkClient（预热/超时/重启/熔断）
  headroomd/   守护进程：UDS server + 轮次切分 + 确定性摘要 + SQLite/FTS 归档
  plugin/      opencode 插件：六类 hook 挂载，连接两个 sidecar
  eval/        评测 harness：四组 runner + 五维指标 + 基线门禁
```

依赖方向：`plugin → {rtk, headroomd, contracts, shared}`；`{rtk, headroomd} → {contracts, shared}`；叶子包不互相依赖。

## 数据流

### rtk：工具输出压缩（同步热路径）

```
tool.execute.after ──> RtkClient（常驻预热进程池）
                        │ classify → strategy ∈ {read, ls/glob, grep, bash, stream, noise}
                        │ anchor 保护关键行 → budget 裁剪至预算 token
                        └─> 原地改写 output + metadata.bluecode{rawHash,strategy,…}
```

- 输出原文按字节 sha256 存 CAS（`sha256:` 前缀寻址），模型可经 `headroom_retrieve` 按 hash 回取。
- 失败降级矩阵：spawn 失败 / 超时 / crash / 协议错 → passthrough 原样放行，熔断器连续失败后 OPEN 直接旁路。

### headroomd：长会话历史压缩（idle 异步路径）

```
event(session.idle) ──> SDK 取消息 → 水位判定(tokens ≥ contextWindow × triggerRatio)
                          └─> daemon compress：turn 切分 → 确定性摘要 → 旧轮次归档
                                ├─ objects（gzip CAS，逻辑地址 = 内容 hash）
                                ├─ meta.db cas_meta（归属，持久）
                                └─ index.db histories/chunks/chunks_fts（全派生，可删自愈）
                          └─> pending plan ──> messages.transform 原地应用
                                （压缩块替换旧轮 + COMPACTION_MARKER + 检索提示）
```

- `headroom_retrieve` 工具双模式：`hash`（精确回取归档原文）/ `query`（FTS5 BM25 检索片段）。
- daemon 空闲退出（默认 15 分钟宽限）；死亡后插件侧连接失败 → 该会话静默降级，对话不受影响。
- 双重压缩防护：上游 Compaction 进行中（结构化 tool-part 或 COMPACTION_MARKER 前缀）则跳过。

## 关键设计决策

| 决策 | 理由 | 记录 |
|---|---|---|
| meta/index 双库拆分 | 删 index.db 自愈重建时不丢归属；原子性由写入顺序表达（objects → meta tx → index tx） | devlog #17/#18 |
| headroom 对象用逻辑 contentHash 寻址（gzip 仅为存储编码） | 字节寻址使索引重建必然落空；统一命名空间后重建按 contentHash 可达 | devlog #18 |
| 插件入口只留 default 导出 | opencode legacy loader 遍历全部命名导出要求皆函数 | devlog #29 |
| 编译宿主 spawn 回退 PATH bun | `process.execPath` 在编译版宿主不是解释器 | devlog #32 |
| 无 usage 模型估算回退 | 免费档网关 tokens 全零时以 chars/4 估算保水位判定可用 | devlog #34 |

完整错误与教训清单见 [devlog.md](./devlog.md)；上游 hook 核实记录见 [integration-notes.md](./integration-notes.md)。
