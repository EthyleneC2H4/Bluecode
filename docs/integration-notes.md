# integration-notes — opencode 上游 hook 核实记录

## 2026-09-05 实现接线更新

生产入口为 [plugin/src/index.ts](../packages/plugin/src/index.ts)，通过实例级
[runtime](../packages/plugin/src/runtime.ts) 注册九类表面：chat.message、chat.params、
experimental.chat.system.transform、tool.execute.after、experimental.chat.messages.transform、
experimental.session.compacting、event、自定义检索工具和 dispose。模型元数据来自实际
hook/SDK provider 信息，未知窗口暂停规划，不再使用固定的大窗口兜底。

每次 transform 以宿主本次提供的可见数组为准；idle 只调度该快照，不能直接以
session.messages() 的完整旧历史替换它。持久视图通过 namespace、epoch、消息 ID、
完整内容 digest 校验后才可应用；compacted 清理旧状态，compacting 只注入仍匹配当前可见来源的记忆。

MCP 路径只修改 text，图像/附件保留；未知 part、工具附件及运行中工具保护原样保留。
session.deleted 按上游 properties.info.id 清理。宿主 bundle 检查确保客户端与纯适配入口不引入
bun:sqlite；旧 helper 仅保留用于兼容测试。详见[架构](architecture.md)及[验收](reliability-implementation.md)。

适配器还保护宿主可见性语义：ignored文本、带error的assistant、state.time.compacted工具、
interrupted metadata.output均保留原宿主消息，不将隐藏正文变成普通摘要。
生产工厂通过spawn.args显式传入headroom的dataDir，不依赖进程级环境修改；
无全局BLUECODE_DATA_DIR的真实冷启动由专用子进程回归覆盖。

以下为历史上游源码核实记录；SDK 方法“存在”不表示当前实现会用它读取完整会话做规划。

核实对象：**刷新后**的 opencode 源码快照 `opencode/opencode-dev/`（版本 **1.18.21**，tag v1.18.21，2026-08-22 由 `scripts/refresh-upstream.sh` 刷新）。基线对照：v1.18.10。

---

## ⚠️ 与 v1.18.10 基线的差异（刷新后实测）

1. **`experimental.chat.messages.transform` 新增第二个调用点**（compaction.ts:379）：除 prompt.ts:1255 外，自动 Compaction 构建摘要对话前也会对 `structuredClone(selected.head)` 触发该 transform。插件的原地 mutate 语义不变，但 compaction 路径现在也会被同一插件逻辑影响。
2. **`DEFAULT_TAIL_TURNS = 2` 硬编码常量已不存在**。`tail_turns` 改为用户配置项 `compaction.tail_turns`（core/src/v1/config/config.ts:157）；未配置时遍历全部 turns，保留量仅受 token 预算约束（`preserveRecentBudget` = clamp(usable×0.25, 2k..15k)，compaction.ts:115-118、228-232）。
3. **usable() 公式扩展**（默认路径仍与基线一致，见第 ④ 条）：新增 `cfg.compaction.reserved` 覆盖项与无 `limit.input` 时的 `context − maxOutputTokens` 回退分支，并加 max(0, …) 截断。
4. 各 hook 调用点行号整体漂移（如 compacting 343→374、autocontinue 454→501），语义未变。

其余结论与基线一致。

---

## 八条核实结论

### ① `tool.execute.after` 的 output 引用传播 — 成立
- 签名：`(input: {tool, sessionID, callID, args}, output: {title, output, metadata}) => Promise<void>`（packages/plugin/src/index.ts:274-283）。
- 核心触发器把同一个 `output` 对象引用传给每个 hook，忽略 hook 返回值，最后原样返回该对象（packages/opencode/src/plugin/index.ts:284-296）。
- 内置工具路径在 session/tools.ts:100-132 中只构造一次 `output`，以同一引用传入 trigger（tools.ts:122），随后用同一对象 `completeToolCall` / `return output` —— 插件原地修改即生效。
- **结论：output 引用传播成立，插件必须原地 mutate（返回值被丢弃）。**

### ② `experimental.chat.messages.transform` 返回值被忽略 — 成立
- 调用点 1：packages/opencode/src/session/prompt.ts:1255 —— `yield* plugin.trigger("experimental.chat.messages.transform", {}, { messages: msgs })`，返回值未接；后续 `MessageV2.toModelMessagesEffect(msgs, model)` 直接消费被 hook 改写后的 `msgs`。
- 签名为 `Promise<void>`（plugin/src/index.ts:285-294），且 trigger 实现统一丢弃 hook 返回值 → 插件必须对 `output.messages` 原地增删改。
- 调用点 2（新增）：packages/opencode/src/session/compaction.ts:379，同样不接收返回值，作用于 clone 后的消息数组，结果序列化为 compaction 对话文本。
- **结论：两处调用点均必须原地 mutate；注意新增的 compaction 路径。**

### ③ `experimental.session.compacting` 与 `experimental.compaction.autocontinue` — 仍存在
- compacting：调用点 packages/opencode/src/session/compaction.ts:374，output 初始 `{context: [], prompt: undefined}`，消费方式为 `compacting.prompt ?? [buildPrompt(...), ...compacting.context]`（compaction.ts:381-388）；签名 `(input:{sessionID}, output:{context: string[]; prompt?: string}) => Promise<void>`（plugin/src/index.ts:305-307）。
- autocontinue：调用点 packages/opencode/src/session/compaction.ts:501，output 默认 `{enabled: true}`，`.enabled` 决定是否插入合成 continue 用户消息（compaction.ts:513 起）；签名 input `{sessionID, agent, model, provider, message, overflow}` / output `{enabled: boolean}`（plugin/src/index.ts:316-330）。
- **结论：两 hook 均保留，语义与基线一致，仅行号漂移（343→374、454→501）。**

### ④ 自动 Compaction 触发水位与 prune 常量
- 水位：session/overflow.ts:10-17 `usable()`：
  - `reserved = cfg.compaction?.reserved ?? min(COMPACTION_BUFFER=20_000, maxOutputTokens)`（overflow.ts:8、12-14）
  - `usable = limit.input ? max(0, limit.input − reserved) : max(0, context − maxOutputTokens)`
  - 默认路径即基线公式 `input − min(20k, maxOutputTokens)`；差异是新增 reserved 配置覆盖、context 回退分支与 0 下限截断。
- 溢出判定 `isOverflow`：`tokens.total ≥ usable()` 且 `cfg.compaction.auto !== false`（overflow.ts:22-33）。
- prune 常量：`PRUNE_MINIMUM = 20_000`、`PRUNE_PROTECT = 40_000`（session/compaction.ts:28-29），与基线一致。
- **差异**：基线的 `DEFAULT_TAIL_TURNS = 2` 已移除，改为配置项 `compaction.tail_turns`（core/src/v1/config/config.ts:157）；未配置时不再固定保留 2 个 turn，而是仅按 token 预算 `preserveRecentBudget`（clamp(usable×0.25, MIN_PRESERVE_RECENT_TOKENS=2k, MAX_PRESERVE_RECENT_TOKENS=15k)，compaction.ts:31-32、115-118）从最新 turn 向回保留（compaction.ts:226-245）。

### ⑤ 插件 options 注入（`"plugin": ["spec", {…}]`）— 成立
- 解析：packages/opencode/src/config/plugin.ts:36-38 `pluginOptions(spec) = Array.isArray(spec) ? spec[1] : undefined`（spec 取 `spec[0]`，plugin.ts:32-34）。
- 传递链：loader 把 options 挂到加载结果（packages/opencode/src/plugin/loader.ts:79）→ `applyPlugin` 以 `server(input, load.options)` 调用插件工厂（packages/opencode/src/plugin/index.ts:118 与 legacy 分支 :123）。
- **结论：`["spec", {…}]` 第二元素作为第二参数注入插件工厂函数，机制与基线一致。**

### ⑥ 自定义工具注册与 ToolDefinition — 成立
- 注册方式：插件内使用 `tool()` 助手声明并随导出返回（packages/plugin/src/tool.ts:45-52，`tool.schema = z` 提供 zod 访问入口）。
- 形状：`ToolDefinition = ReturnType<typeof tool>`（tool.ts:54）＝ `{description: string; args: zod ZodRawShape; execute(args, context: ToolContext): Promise<ToolResult>}`；`ToolContext` 含 sessionID/messageID/agent/directory/worktree/abort/metadata()/ask()（tool.ts:4-27）；`ToolResult` 为 string 或 `{title?, output, metadata?, attachments?}`（tool.ts:37-43）。
- **结论：与基线一致 —— ToolDefinition = {description, args(zod), execute}。**

### ⑦ 截断常量与截断/hook 先后顺序 — 成立
- 常量：`MAX_LINES = 2000`、`MAX_BYTES = 50 * 1024`（packages/opencode/src/tool/truncate.ts:14-15）；可被 `cfg.tool_output.max_lines/max_bytes` 覆盖（truncate.ts:77-81）。
- 内置工具：truncation 在工具 execute 包装器内完成（packages/opencode/src/tool/tool.ts:99 wrap，:135 `truncate.output(...)`），因此 session/tools.ts:122 的 `tool.execute.after` hook 看到**已截断**输出 → 先截断后进 hook（同基线）。
- MCP 工具：session/tools.ts:390 起注册，hook 在原始 result 上先触发（tools.ts:421，传未截断 `result`），之后才拼接文本并 `truncate.output`（tools.ts:464）→ hook 先于截断（同基线，方向相反）。
- **结论：常量数值不变；「内置先截断后 hook、MCP 先 hook 后截断」的不对称性保持。**

### ⑧ SDK client 方法 — 均存在
- `client.session.messages()`：Session 类方法，GET `/session/{id}/message`（packages/sdk/js/src/gen/sdk.gen.ts:605-611）。
- `client.event.subscribe()`：Event 类方法，GET `/event`（SSE）（sdk.gen.ts:1149-1155）。
- 二者均挂载于 `OpencodeClient`：`session = new Session(...)`（sdk.gen.ts:1185）、`event = new Event(...)`（sdk.gen.ts:1196）。
- **结论：两个方法均存在，rtk/headroomd 可依赖此接口接入。**
