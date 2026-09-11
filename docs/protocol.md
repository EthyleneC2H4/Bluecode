# 协议规范

权威定义：[RTK schema](../packages/contracts/src/rtk.ts)、[headroom schema](../packages/contracts/src/headroom.ts)、[共享错误](../packages/contracts/src/errors.ts)。RTK wire 为 **v3**，headroom wire 为 **v3**；旧进程需要停机后升级，不能混用握手版本。

## 公共传输

JSONL 一行一帧，限制单帧 UTF-8 字节数为 8MiB。多帧粘包不会按整块累计；字符串分片中的代理对/流式 decoder 尾部均有回归。请求与响应使用唯一 `id`；迟到响应不匹配后续请求。

若同次读取中先有完整响应、后有超大帧，FrameOverflowError.completedLines保留合法前缀；客户端先完成这些响应，再按组件策略计协议错误或关闭连接，不能因操作系统分块差异丢弃已完整接收的响应。

```json
{"v":3,"id":"request-1","op":"compress","params":{}}
{"v":3,"id":"request-1","ok":true,"result":{}}
```

上例仅展示 envelope，`params/result` 必须满足对应 op 的完整 schema。两组件均使用 `v:3`。启动 hello 为 `{"proto":3,"pid":123}`。headroom 连接握手采用绝对 1 秒期限和 64KiB 上限；EOF/close 立即失败。启动进程 stdout 支持分片 hello；已有兼容 daemon 的启动竞争以结构化状态处理。

## RTK ops

| op | 主要字段 |
| --- | --- |
| `compress` | `tool, output, title?, toolArgs?, source?, provenance?, metadata?, sessionId, callId?, budgetTokens?` |
| `fetch` | `hash: sha256:<64hex>, sessionId, cursor?, maxTokens?, maxBytes?` |
| `ping`, `stats` | 运维状态；测试专用故障 op 仅测试模式开放 |

生产插件将 session ownership 编码为 `JSON.stringify([projectId, sessionID])`。工具参数只跨越安全 scalar 投影；未知复杂参数不会迫使解析器采用低置信策略。

`compress` 返回实际 `status: compressed|unchanged|skipped|degraded`，同时保留 `compressed` 兼容字段、`rawHash`、strategy、token 估算、`targetTokens/actualTokens/budgetExceeded`、`omittedRanges`、diagnostics。`actualTokens` 是实际输出的快速估算，离线 exact token 指标另行计算。原始内容指经过既有 sanitize/redaction 管线后的规范化文本，默认 redactor 为 identity。

客户端 `CompressOutcome` 的 compressed/passthrough 分支遵守 wire 实际结果；`no_gain` 不算故障。超载、存储容量、存储错误独立可观测。`fetch` 返回 `found:true,content,nextCursor,truncated` 或 `found:false`。损坏对象返回错误，不作为成功原文使用。[客户端与引擎](../packages/rtk/src)。

## headroom ops

| op | 语义 |
| --- | --- |
| `compress` | `projectId,sessionId,messages,contextWindowTokens,targetTokens?,epoch?,protectedMessageIds?,triggerRatio?,retainRecentTurns?` → 计划 |
| `retrieve` | namespace 加 hash/historyHash/query/nodeId 四选一，以及分页预算 |
| `getCandidate` | `{namespace,jobId,epoch,sourceDigests}` → queued/running/ready/rejected/missing；ready候选不自动发布 |
| `view.get` | namespace → 已发布计划快照或 null |
| `view.set` | `{namespace,plan}` → null；计划必须匹配该 namespace 的确认归档 |
| `view.clear` | namespace → null；不删除原始对象 |
| `health` | PID、运行时间、已归档 namespace 数 |

消息投影只含已知 text/tool，工具包含 `callId/input/status/output/error`。宿主未表示的模型可见内容应由插件将整条消息标记 protected。内容 digest 对有序完整投影与版本求 SHA-256；headroom hash 为裸 64hex，和 RTK 引用前缀不同。

`compacted:true` 必须提供 `historyHash/summary/memory/sourceDigests/refs/replacedMessageIds`。源 digest、ref、ID 长度一致，逐项 digest=ref.contentHash，ID 唯一且 token 会计自洽；`freedTokens>0`。`compacted:false` 必须完全惰性，无替换引用、无释放量。`epoch` 由生产插件显式提供。

三种 retrieve 都有界；history 保留旧 `nextOffset`，新调用应使用可表示消息内部位置的 `nextCursor`。完整历史中的坏/缺失对象报告 `partial/missingHashes`；hash 读取发生完整性错误时抛出。query 返回 BM25 命中、namespace、chunkId、UTF-16 offsets、snippet 与 cursor；cursor 绑定查询、limit 与有序证据快照，失效后需重新查询。[引擎](../packages/headroomd/src/engine.ts)。

直接 daemon 响应预算约束原文内容；插件工具进一步约束最终 JSON。默认2048/32KiB、硬限8192/128KiB均采用UTF-8保守token上界。改变 cursor 所绑定的引用或 namespace 会被拒绝；分页不能截断返回后却越过剩余尾部。

## 分层计划与后台候选

`compress` 增加 `strategy:legacy|layered`、`memoryMaxTokens/memoryRatio`、`enhance` 与显式 `summaryProvider`。分层结果携带 `operations/nodes/taskState/protectedMemory/budget/metrics/sourceSnapshot`；后台提交成功时带 `enhancementJobId`，配置不匹配时带 `enhancementReason` 并保留规则结果。每项操作绑定来源摘要和位置，必须互不重叠、全部有效，才能原子应用。

节点恢复可选 `detail:summary|children|source`、`depth` 与游标。v3历史游标持久保存SQL seek位置，旧ordinal游标仍可读。query `cards` 返回短片段和路径、标识符、节点引用；legacy `segments` 兼容保留。layered最终工具JSON按明确字符估算及字节双预算，legacy沿用UTF-8保守上界。

后台摘要先消费持久预约额度，再返回规则计划；getCandidate读取已完成候选不会等待网络。所有服务配置在daemon启动时固定，插件请求配置必须一致。usage未知为null，与reservedUsage区分。view.set仍要求匹配同namespace确认的manifest。详情见[分层实现与配置](headroom-layered.md)。

## 持久版本与升级

新存储分别在 `storage-v2/rtk` 与 `storage-v2/headroom`。headroom 保留旧 hash 的校验读法，RTK 提供只读 legacy reader；项目 ownership 迁移需要显式映射，绝无跨项目 fallback。离线迁移保留源，复制/校验/重建/配额检查完成后才切换目录。[迁移说明](operations.md)。
