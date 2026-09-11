# headroom Layered Context Implementation Plan

**Goal:** 实现已批准的分层记忆、增量压缩、原文恢复及可选后台摘要。
**Architecture:** Bun 插件接入独立 RTK/headroomd。规则规划先返回，原文确认后发布操作式视图；增强任务只产生经宿主再次校验的候选。
**Tech Stack:** Bun 1.4.0, strict TypeScript, Zod, SQLite FTS5, CAS。
**Spec:** docs/superpowers/specs/2026-09-11-headroom-layered-design.md

## Global Constraints

- 不改 RTK 算法，不引入 GPU/向量数据库，不复制 AGPL 代码。
- 四个近期完成轮次与活动轮次受保护；用户要求和不明确材料原文保留；同命令不同结果不得误去重。
- headroom wire v3；旧归档可读；namespace/source digest/epoch 校验；原文确认后替换；宿主未知内容保持原样。
- 规则默认离线，LLM 默认关闭；显式模型和总预算缺失不执行实机请求。
- 测试先行；每组件真实边界测试；报告实测证据与尚未验证项。

### Task 1: 分层数据契约、预算规划与原子视图

负责 packages/contracts/src/headroom.ts、新 packages/headroomd/src/layered*.ts / token-counter.ts、packages/headroomd/src/compaction.ts / pure.ts 及对应新增测试。不修改 engine/server/client/plugin/eval。

实现规范：wire v3；新增三类 ViewOperation（安全 range、tool output、text range），带源摘要与原子不重叠验证；旧计划兼容。LayeredNode 含不可变 nodeId、children、source refs、policy version、text/tokens；规划结果提供 operations、nodes、memory、protected memory、预算/操作计量。buildLayeredPlan(messages, options) 接受 namespace、contextWindowTokens、targetTokens、retainRecentTurns、memoryMaxTokens、memoryRatio、缓存；不做 I/O。

保持现有 MemoryEntry 兼容；导出具体接口并向协调者说明。规划选择遵循 spec，目标 O(输入+候选排序)，保护岛之后仍有安全操作。read/grep/test/write 按证据骨架处理，失败诊断保留；只外置明确材料；原文要求 pin 在预算之外；0/负收益旁路。TokenCounter 独立接口可注入、摘要缓存有界；宿主 pure 导入不得加载数据库或 tokenizer。

测试先复现 300 个独特读取不压缩、保护岛阻塞、同参不同结果误合并、重复规划重做分析、原文约束丢失等缺陷；实现后验证预算、操作原子性、legacy 计划、多代节点。只提交本人拥有文件。报告包含 API、红绿证据、限制。

### Task 2: daemon 存储、通信、插件接线与检索

协调者负责 engine/store/server/client/bin 和 plugin runtime/config/host-adapter/retrieval/index；与 Task 1 契约对齐。新增节点/候选持久表、源确认、整段与局部视图发布、配置透传、incremental cache、节点 retrieval、可继续的 history 游标；旧归档迁移读取保持兼容。测试真实进程、损坏归档、隔离、分页、保护岛、fresh-array 重放、编辑/上游 compaction 失效和冷启动。

### Task 3: 独立后台摘要模块

工作者负责新 packages/headroomd/src/enhancement.ts / summary-provider.ts 及独立测试，不改 daemon/plugin 接线（Task 2 集成）。导出 SummaryProvider 和有界队列 manager；输入带 namespace/key/source IDs/pinned entries/budget，结果为 MemoryEntry[] 与 usage。非流式 OpenAI-compatible HTTP adapter，显式 baseURL/model/apiKeyEnv，不记录密钥。每会话一任务、全局二并发、8192/1024单次、32768/4096会话、10000ms；实际 envelope 输入计量，信号取消、错误/超预算/伪造来源/膨胀拒绝、缓存结果、状态可查询，关闭释放资源。先写失败测试，使用本地 HTTP fixture，不调用外部模型。协调者在 compress/getCandidate/setView 接入。

### Task 4: 专用回放、实机对照、文档和最终验收

工作者负责新增 packages/eval/src/headroom-*.ts / live-*.ts 与测试；协调者接 CLI、基线对照、文档。24 历史样例与生产 runtime 回放；12 可执行编码任务×三组×两次的显式预算实机 runner，不以模拟回答代替真实执行。报告 source/memory/retrieval/model input/output/cache/summary usage、daemon CPU/RSS/队列、约束/恢复/任务质量。基线版本冻结；回归不能通过覆盖旧数字隐藏。完成 verify、eval、新专用测试、独立代码审查；有实机配置则执行，否则交付可运行入口并明确缺失的外部验证。根据验收决定默认策略。
