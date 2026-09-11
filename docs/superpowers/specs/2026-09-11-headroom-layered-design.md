# headroom 分层上下文设计（用户已批准）

依据：2026-09-11 对话中用户完整批准并要求执行的优化方案。基线 main 为 62589ac；本次实现独立于 vivo 私有源码。

## 目标

把全文分类去重改为有预算的分层上下文管理：规则为主、可选后台 LLM 增强；需求、约束、修正保留原文；明确的大段材料归档；不明确时保护原文。默认开发、测试和 CI 离线。实机对照必须显式指定模型和总调用预算。

## 绑定行为

- 保留近期四个完整轮次与活动轮次。运行中工具、附件、未知内容保持宿主原状，不阻塞其他安全片段。
- 四层数据：近期原文、带来源的任务状态、有预算的历史记忆、可恢复的原始证据。
- 任务状态记录约束、当前事项、决策、文件修改与验证。只有明确修正或可验证的同一事项状态变化可以替代旧状态；历史证据仍保留。不能把不同版本或不同命令的成功当作失败已解决。
- 只外置明确属于材料的日志/文件代码块，保留周围要求。不确定是否是待实现代码时保留全文。
- 旧工具观察可转换为路径/命令/执行状态/关键诊断与来源引用。去重键包含 namespace、工具、规范化参数、输出摘要；同参数不同输出不合并。
- 原文确认发布后才允许替换模型可见内容。保持项目/会话隔离、源摘要校验和上游可见性边界。
- 设可用输入 B、必留内容 P、近期原文 R、包装 O，历史预算为 min(4096, floor(0.15B), max(0,floor(0.55B)-P-R-O))。各部分去重计数。超额保护内容保持原样并报告原因。
- 候选按未解决事项/必要决策、当前文件状态、当前请求相关证据、其他历史排序；层内按相关性、时间、稳定 ID 选择完整块。
- TokenCounter 可替换且按内容摘要缓存。daemon 使用对应 tokenizer 或明确标记的估算；实际 provider usage 单独报告。
- 叶节点源块约 8K token，摘要至多 512；同层至少四个相邻节点且有预算压力时可合为至多 1024 token 的父节点。不可变节点记录来源、子节点、策略版本与 token 数。规则模式不把所有子文本拼回上下文。
- 增量分析和缓存消除逐前缀重建，规划目标为输入扫描加候选排序；仍允许线性宿主快照验证。
- 视图支持安全整段替换、已完成工具结果替换、明确材料文本范围替换。操作不重叠、绑定源 ID/摘要/版本，在一次验证后原子应用；支持 fresh 宿主数组反复重放。
- 保留 70% 触发、55% 目标，准备节点不立即改变活动视图；稳定序列化并批量发布。
- 检索兼容 hash/historyHash/query，增加 nodeId 与展开层级，先给相关短片段和定位信息，按需展开。最多五个查询命中，合并重叠；默认 2048 token 与字节上限包含 JSON。history cursor 保存遍历位置。检索结果绕过 RTK。
- LLM 默认关闭。独立文本适配器不经 Agent Loop。每会话一项在途、daemon 两项；单次输入 8192、输出 1024 token、超时 10000ms；会话累计输入 32768、输出 4096。相同源/提示词/模型/预算复用结果。失败、膨胀、缺失来源、过期候选保持规则结果。
- LLM 等待不占用数据库写锁或全局压缩串行队列。compress 先给规则计划；候选通过后台 getCandidate 获取、宿主校验、setView 确认后发布。来源校验不等于语义保证；LLM 不覆盖原文约束。

## 接口与交付

headroom wire v3；操作式视图与节点类型；getCandidate RPC；retrieve nodeId/detail；配置 strategy=legacy|layered 与 summary provider；off/shadow/on 保留。存储增量升级，旧 hash 和归档继续读取，旧视图转为单段操作。版本不匹配旁路并提示重启，不强杀其他实例。

顺序：冻结基线/计量 → 规则分层和视图 → 检索/可选摘要 → 离线与实机对照。layered 只有验收后才默认启用；摘要继续默认关闭；保留 legacy 回退。外部项目仅参考机制，不复制 AGPL 实现。

## 验收

- 完整现有 verify 和离线回放；新增八类 × 50/200/1000 轮，共 24 份 headroom 历史。
- 覆盖独特代码、重复结果、失败修复、要求修正、多文件、大段材料、受保护片段、多代恢复；2/5/20 代；编辑/删除/重排/重启/上游压缩；坏摘要/超时；分页连续性与 namespace；操作计数及 daemon CPU/RSS/队列。
- 可归档长会话累计输入较当前 headroom 降低至少 25%；消除 engineering-replay 检索净成本回归。不可压缩场景独立报告，不弱化保护规则。
- 实机 12 个小型编码任务，缺陷修复/跨文件修改/测试修复/长日志各三项；legacy、layered、layered+LLM 各两次。同模型/快照/权限/任务/RTK设置。记录测试结果、约束、usage/cache、摘要调用、时间、重复读取与四类续接探针。明确模型和总预算缺失时不发模型请求。
- 小样本报告不确定性。通过数不低于旧版、无新增关键约束违例且有净收益才作为上线候选；LLM 无额外收益则继续关闭。预算耗尽标记未完成。

## 参考

- https://github.com/Opencode-DCP/opencode-dynamic-context-pruning
- https://github.com/headroomlabs-ai/headroom
- https://github.com/Martian-Engineering/lossless-claw
- https://arxiv.org/abs/2508.21433
- https://blog.jetbrains.com/research/2025/12/efficient-context-management/
- https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
- https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus
- https://arxiv.org/abs/2510.00615
- https://factory.com/news/evaluating-compression
- https://aclanthology.org/2024.findings-acl.57/
- https://arxiv.org/abs/2608.16370
