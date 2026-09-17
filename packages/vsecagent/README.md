# VSecAgent 离线扫描进程

本包是公开学习重构，提供独立 Bun 子进程中的离线安全扫描；不是企业私有
VSecAgent 产品，也不执行被扫描的命令或代码。

```ts
import { VsecClient } from "@bluecode/vsecagent/client"
const scanner = await VsecClient.create({ dataDir: "/absolute/local/data" })
const result = await scanner.sanitize({ namespace, fields, policy })
const decision = await scanner.evaluateTool(params)
const health = await scanner.health()
await scanner.shutdown()
```

`client` 入口不导入 TypeScript、WASM 解析器或 SQLite。默认扫描入口按包内
`bin.ts` 定位；`entry` 可指定自定义入口（包括测试故障进程）。编译宿主内使用
PATH 中的 Bun；普通 Bun 进程使用当前解释器。

启动独立使用 10 秒预算，并预热 TypeScript 5.9.3 与本地 Bash WASM 后发送
JSONL v1 ready 帧。默认请求截止时间 1000ms，计入验证、排队、IPC 和服务时间；
重启等待也计入该请求时间。最多接受 32 个待处理请求（含正在处理请求），其
序列化负载及帧预留共计不超过 8MiB，单个文本字段不得超过 1MiB。超时立即
SIGKILL 当前子进程，以中断同步解析；该代未完成请求失败，下一次调用自动
预热新进程。进程代和随机请求 ID 共同隔离旧回复。传输错误仅返回固定的
`VsecUnavailableError.reason`，不透传 stderr、原始异常或错误帧。

结果包含 `requestId/queueMs/serviceMs/policyVersion`；health 提供进程 PID、
协议、运行时间、缓存字节/命中数、最近服务耗时和 RSS。请求按顺序服务。

内存 LRU 缓存上限 16MiB；键覆盖项目、会话、完整内容、完整策略、解析器和
可选提供方版本。缓存只保存结果 JSON，并在最近有效例外到期时失效；扫描
期间到期的例外不会产生无限缓存。没有持久化原始扫描输入或结果缓存。

`dataDir/audit/vsec.{0,1,2}.jsonl` 每个文件上限 1MiB，目录模式 0700、文件
0600。审计只投影固定操作/决策/错误类别、已知规则 ID、数值行列、请求 ID、
时间和版本指纹；省略路径、消息、参数、代码、凭据和 namespace 原文。
超大 finding 列表只记录前 16 项。审计写入失败会令本次请求失败。

`adapters` 导出相互独立的 `FirewallAdapter` 与 `RedactionAdapter`，通过
`VsecEngine.create` 可选注入（自定义 child entry）。它们是 SDK 抽象，未猜测
企业 HTTP/鉴权格式。适配器使用 AbortSignal 和默认 250ms 超时，异常及格式
错误映射为固定类别。防火墙失败返回 unavailable；脱敏适配器失败或覆盖不全
时替换全部字段，成功结果再经本地脱敏。服务端若同步阻塞，仍受父进程强制
终止机制保护。默认客户端和默认入口不加载任何外部服务。

测试使用真实子进程、临时目录和本地假提供方，覆盖生命周期、截止时间、
恢复、队列/帧/递归边界、缓存隔离与到期、审计轮转和故障脱敏。执行：

```sh
bun test packages/vsecagent/test
bun run --cwd packages/vsecagent typecheck
```
