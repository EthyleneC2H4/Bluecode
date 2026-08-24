# 协议规范

两套独立 wire 协议，schema 权威定义于 `packages/contracts`（zod，运行时校验）。共同约定：**JSONL** 帧格式（每行一个 JSON 对象，`\n` 分隔）、请求带协议版本 `v: 1` 与唯一 `id`、响应以同 `id` 关联、错误码共享 `contracts/errors.ts`。

## 通用帧形状（两协议一致）

```jsonc
// 请求
{ "v": 1, "id": "<uuid>", "op": "<见下>", "params": { … } }
// 成功响应
{ "v": 1, "id": "<同请求>", "ok": true, "result": { … } }
// 失败响应
{ "v": 1, "id": "<同请求>", "ok": false,
  "error": { "code": "E_PROTOCOL" | "E_UNKNOWN_OP" | "E_INVALID_PARAMS" | "E_INTERNAL", "message": "…", "detail?": … } }
```

错误映射约定：未知 op → E_UNKNOWN_OP；参数校验失败 → E_INVALID_PARAMS；帧解析失败 → E_PROTOCOL；其余 → E_INTERNAL。

## 握手

连接建立后 server 先发一行 hello 帧，client 在超时窗内未读到即判定 spawn/连接失败：

```jsonc
{ "proto": 1, "pid": <int> }   // rtk: contracts/rtk.ts helloSchema
                               // headroomd: 同形状（client.ts 按 {proto,pid} 解析）
```

## rtk ops（stdio：stdin/stdout）

| op | params → result | 备注 |
|---|---|---|
| `compress` | `{ output, tool }` → 压缩文本 + `{ rawHash, strategy, compressed, outTokensEst, rawTokensEst, degraded? }` | 热路径 |
| `fetch` | `{ hash: "sha256:<64hex>" }` → `{ found, content? }` | found:true 时 content 必填 |
| `ping` / `stats` | 空 → pong / 计数器 | **插件热路径禁用**（串行队列队头阻塞，Task 5 审查裁决） |
| `simulateCrash` | 空 | 仅测试注入：server 环境须 BLUECODE_TEST=1，否则答 E_PROTOCOL |

## headroomd ops（Unix domain socket）

| op | params → result | 备注 |
|---|---|---|
| `compress` | `{ sessionId, projectId, messages: ChatMessage[], contextWindowTokens, triggerRatio, retainRecentTurns }` → `{ compacted, historyHash, summary, refs[], replacedMessageIds[], rawTokens, summaryTokens, freedTokens }` | 水位不足或保留轮不足时 `compacted:false` 零副作用返回 |
| `retrieve` | hash 模式 `{ namespace:{projectId,sessionId}, hash }`（裸 hex）→ `{ found, content? }`；query 模式 `{ namespace, query, limit? }`（默认 5，协议上限 50，越界 → E_INVALID_PARAMS）→ `{ hits: [{ score, hash, projectId, sessionId, turnIndex, role, snippet }] }` | 二选一，都缺/都有 → E_INVALID_PARAMS；插件工具层把 LLM 传入的 limit clamp 到 50（截断而非报错） |
| `health` | 空 → `{ ok, pid, uptimeMs, sessions }` | 插件热路径禁用（同 ping/stats 裁决） |

## 哈希命名空间（wire 层不互通；插件工具层桥接）

| 组件 | 形式 | 寻址语义 |
|---|---|---|
| rtk | `sha256:` 前缀 + 64 位小写 hex | gzip 字节摘要寻址 |
| headroomd | 裸 64 位小写 hex | 内容逻辑寻址（对象存储编码为 gzip，完整性靠 gzip CRC + JSON.parse） |

两个 daemon 各自只认自己的形式（跨协议寻址会得到 found:false 或报错）。桥接发生在 `headroom_retrieve`
工具层：带 `sha256:` 前缀的 hash 直接路由给 rtk 的 `fetch`，裸 hash 走 headroomd——LLM 用单一工具即可
回取两类原文，无需感知底层归属。

## 消息投影契约（ChatMessage）

插件向 headroomd 投影 opencode SDK 消息时只携带契约已知内容：

```jsonc
{ "info": { "id": "msg_…", "role": "user" | "assistant", "tokens?": {…} },   // tokens 仅客户端使用，daemon schema 剥离
  "parts": [ { "type": "text", "text": "…" } | { "type": "tool", "tool": "<name>", "state": { "status": "…", "output?": "…" } } ] }
```

reasoning / step-start / step-finish 等上游 part 无 wire 表示，投影时丢弃（映射成伪 tool part 会被 daemon 以 E_INVALID_PARAMS 拒收——devlog #34）。
