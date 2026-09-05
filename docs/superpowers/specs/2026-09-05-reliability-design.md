# BlueCode RTK / headroomd 可靠工程版设计

用户于 2026-09-05 确认实施。基线 7aed67d；完整评审及方案见当前 Codex 任务。

## 目标与约束

保留 OpenCode 插件、双 sidecar、Bun 1.4.0、TypeScript strict、SQLite/CAS；优先信息保真、可恢复、稳定性，再降低包含检索开销的总 token。上游 OpenCode 1.18.21 快照只读。不引入模型摘要、向量服务或 Rust 引擎。源码事实、实测和目标分别标注；不声称还原私有 BlueCode。

## 关键设计

1. 插件实例持有客户端、配置、连接及会话状态，移除共享单例和全局环境修改；使用真实 project.id/sessionID。支持内置 output 和 MCP content[]，保护附件、未知 part、正在运行的工具。提供 off/shadow/on 分组件模式。
2. RTK 结构化解析为含来源行范围、分组、保护级别的块。read 保留源码，diff 保留变更，test 保留完整失败诊断，unknown/低置信解析保守直通。消除 test/budget 平方路径。目标预算512 tokens为软预算；小于512 bytes跳过；无收益正常unchanged。
3. RTK 40ms deadline包含排队，队列最多32请求/8MiB；超限旁路。JSONL按单帧UTF-8字节限制8MiB，解决粘包边界；握手/EOF/关闭必须收敛。进程重启generation隔离迟到事件。
4. retrieval结果绕过RTK。分页默认2048 tokens/32KiB，硬上限8192 tokens/128KiB，先达到者生效。cursor绑定ref与偏移，严格前进；完整性错误显式返回。
5. headroom使用ContextSnapshot版本和持久活动视图，每次宿主重新读取历史后重放；覆盖消息顺序、content digest和upstream epoch必须匹配；尾部追加不影响应用，覆盖范围改动令计划失效。模型按provider/model/config缓存，未知窗口暂停自动压缩。
6. 70%触发、55%目标、保护最近4个完整轮次及当前轮。仅正收益归档，无法达标标记预算状态。idle与完成事件合并异步规划，应用阶段只使用就绪计划。
7. 摘要分约束/决定/变更/验证/失败/未完成事项，附来源引用；用户要求保留原文。manifest包含有序源消息版本、子归档、完整性；摘要版本独立；多代压缩合并记忆，不能摘要包装文字。
8. CAS以完整有序投影（含status/input/error）计算版本化hash。统一schema/hash/解压限额校验；引用发布前确认对象及ownership/meta持久化。完整摘要不能被partial rebuild覆盖；坏派生SQLite隔离重建，坏meta停止归档。
9. 持久数据与socket分离，显式dataDir保持有效，默认系统应用数据目录；默认1GiB quota，满额停止新归档，已有引用不删除。GC只处理无引用临时对象。
10. 全文按自然段/代码/诊断块切分，目标512 tokens/重叠64 tokens，记录来源位置，BM25加标识符/路径/错误码索引及中文处理；检索归并重叠命中，支持有界history展开。
11. RTK wire v3、headroom wire v2，新存储v2目录与旧版本并存；旧hash只读；迁移复制校验后切换，保留原目录。插件使用client/pure子入口避免加载数据库模块。
12. eval通过真实plugin adapter和连续会话回放，区分上下文召回、自然问题检索、取回恢复、归档逐项相等、全部token/usage/queue/RSS。测试不改仓库baseline。

## 验收

正确性门禁：保护内容/确认归档/确定性任务通过100%；跨会话访问、stale plan、retrieval再压缩为0；2/5/20代压缩；模型切换、重启、编辑/撤销、上游compaction；损坏对象/SQLite/部分归档恢复；1/8/32并发与随机分帧。拟定质量目标Recall@5>=90%、组合包含检索开销的输入token比A下降>=20%，只能由冻结语料实测验证。全仓verify、依赖方向、迁移及Linux/macOS smoke；不可运行的平台检查必须明确未验证。

## 参考

- RTK e53ec1cf180d801f33121855dce37b393ede258c：命令规则/过滤器测试。
- Headroom 73a6edbe83af716bb833da5d902dd55afa6dab40：稳定历史前缀/净收益。
- DCP 11f6517780a502512a3467645074be447cb0369e：内容保护，独立实现。
- QMD dbfd0b4736aeaf761d1a16ca8e424f071df8feb9：自然边界分块/全文检索。

AI使用声明：此设计由AI辅助源码审查生成，探针和原始基线已区分，目标并非实测承诺。
