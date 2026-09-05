# RTK / headroomd 可靠工程版实现与验收

日期：2026-09-05。实现范围对应[设计](superpowers/specs/2026-09-05-reliability-design.md)与[六阶段计划](superpowers/plans/2026-09-05-reliability.md)。这是公开学习仓库的独立重构，不是 vivo 私有源码或企业线上效果复现。源码、文档与回归测试由 AI 辅助编写，并经独立审查、实际命令验证。

## 已实现的工程链路

| 阶段 | 结果与代码证据 |
|---|---|
| 1：RTK | [纯策略](../packages/rtk-core/src/strategies)保护代码、diff变更及完整失败块；来源行与省略区间可追溯；[客户端](../packages/rtk/src/client.ts)提供入队起算deadline、32请求/8MiB边界、代际隔离和卡住进程恢复；[引擎](../packages/rtk/src/engine.ts)确认CAS发布后授予namespace所有权。 |
| 2：headroom | [完整内容digest](../packages/headroomd/src/turns.ts)、[六类证据记忆](../packages/headroomd/src/memory.ts)、[manifest和持久视图](../packages/headroomd/src/store/manifests.ts)、[全文分片](../packages/headroomd/src/store/fts.ts)、有界检索、多代恢复；[规划](../packages/headroomd/src/engine.ts)使用70%触发/55%目标，保留最近4个完成轮次及活动/未知内容。 |
| 3：宿主接入 | [生产runtime](../packages/plugin/src/runtime.ts)每实例拥有状态和客户端，使用真实项目/会话/模型信息；[adapter](../packages/plugin/src/host-adapter.ts)保留完整宿主字段并验证来源后重放；MCP只处理text，检索绕过RTK，未知窗口暂停规划。 |
| 4：升级与运维 | [系统数据路径](../packages/shared/src/paths.ts)、[离线迁移CLI](../scripts/migrate-storage.ts)、[临时文件GC](../scripts/gc-storage.ts)、off/shadow/on、独占writer及有界重连；锁定依赖和[宿主SQLite边界门禁](../scripts/check-host-imports.ts)。 |
| 5：评测 | [生产runtime回放](../packages/eval/src/runner.ts)、[独立工程问题](../packages/eval/src/fixtures.ts)、[质量门禁](../packages/eval/src/reliability.ts)、隔离报告/基线路径；全部固定调用与检索成本计入总输入。 |
| 6：交付 | 架构、协议、接入、迁移、恢复、双语README和本记录更新；Linux/macOS [CI](../.github/workflows/ci.yml)配置与独立最终审查。 |

## 审查中修正的边界

- RTK 失败诊断里的 checkmark 不再误判为结束失败块；combined diff 安全旁路；单个畸形迟到响应不再永久占据传输槽。[RTK回归](../packages/rtk/test/review.test.ts)、[策略回归](../packages/rtk-core/test/reliability.test.ts)。
- RTK 使用独立 SQLite 发布锁覆盖 reserve→CAS→grant。reservation 在对象发布前持久提交；仅持锁时回收缺少对象的pending记录，崩溃后自动释锁；已发布对象继续占用配额，其他活跃writer不会被误回收。列迁移在IMMEDIATE事务内重查，避免并发ALTER竞态。[ownership](../packages/rtk/src/ownership.ts)。
- headroom 的writer锁绑定持久根，防止不同socket并发写同根；真实同socket双进程冷启动竞争验证12轮，落后进程限时探测获胜daemon，损坏数据库等其他错误仍明确失败。[server测试](../packages/headroomd/test/server.test.ts)。
- 持久view保存发布时完整plan快照；新候选不能覆盖旧view的epoch。查询cursor绑定排名内容快照；部分全文分片缺失能够触发重建；tool input/error 纳入证据及预算。[headroom审查回归](../packages/headroomd/test/review.test.ts)。
- 上游可见消息数组是规划来源，idle不直接读取完整SDK历史。源消息的编辑/删除事件立即取消旧snapshot及在途generation；修改readyview来源还清除view。compacting不得仅凭互相一致的旧view/旧snapshot注入摘要。[runtime回归](../packages/plugin/test/runtime.test.ts)。
- 宿主ignored文本、错误assistant、已compacted工具及interrupted metadata.output保留原宿主形态，整条消息受保护，避免隐藏正文重新进入摘要或丢掉唯一诊断；标志切换会失效旧计划。[可见性回归](../packages/plugin/test/host-visibility.test.ts)。
- 真实插件工厂显式传入headroom数据根，冷启动不依赖全局环境变量；收到hello后立即连接，避免短idle配置下先等待再丢失daemon。[真实入口回归](../packages/plugin/test/factory-live.test.ts)。
- RTK初次create失败会收敛所有定时器；半启动进程按TERM、3秒宽限、KILL处理并等待退出。握手期间退出由spawn调用者处理，避免双重重启；已返回客户端仍可在运行期自动恢复。[真实故障回归](../packages/rtk/test/review.test.ts)。
- 离线迁移在副本重映射项目，最终索引生成后再检查限额。marker记录来源路径和映射，重复请求身份不一致则拒绝；源库保持原样。[RTK迁移测试](../packages/rtk/test/migration.test.ts)、[headroom迁移测试](../packages/headroomd/test/review.test.ts)。
- 评测逐页拼接同一命中的连续snippet，包括第5个命中的尾页；行级观测和组级汇总一致性也必须通过，矛盾报告不能刷新基线。[评测测试](../packages/eval/test)。

## 测量口径与结果

旧基线使用一次性sidecar变换、gold原文查询和found/hash恢复判据。本次 `semanticsVersion=2` 改为生产插件多步回放、独立自然问题、检索成本计账和逐字恢复。旧9%最终上下文比例与新总输入节省不具有可比性；未通过扩大“可检索即没丢”定义来提高上下文保留成绩。

每份fixture分4阶段，每阶段2次fresh宿主数组调用；11份×4组共44行。自然问题与期望标识符独立定义，期望答案只在事后评分时使用。两种检索策略在执行前固定：

- **query-only**：每题query，最多前5命中，跟随分页得到原文snippet证据。
- **eager-recovery**：同样query后，将前5命中不同文档逐页展开全文；不按期望答案决定是否展开。

精确计数使用o200k_base对角色标记和模型可见文本计数，包括固定宿主调用、问题、每页返回和之后重复输入证据的成本。档案完整性探针仅用于验证，不参与任务证据或成本节省分母。详见[评测说明](../packages/eval/README.md)。

| 组 | 总输入token | 检索返回token | 模型调用 | 最终上下文比例 | 普通must-hit | 关键约束 | 自然Recall@5 | 确定性答案 | 档案逐字恢复 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| A：关闭优化 | 582,501 | 0 | 98 | 100.00% | 104/104 | 3/3 | 未测 | 10/10 | 0/0 |
| B：RTK | 464,781 | 0 | 98 | 76.33% | 102/104 | 3/3 | 未测 | 10/10 | 32/32 |
| C：headroom | 529,923 | 4,835 | 108 | 61.72% | 104/104 | 3/3 | 10/10 | 10/10 | 76/76 |
| D：组合 | 435,436 | 4,869 | 108 | 48.01% | 102/104 | 3/3 | 10/10 | 10/10 | 108/108 |

主场景D总输入比A减少 **25.25%**，达到≥20%目标。关键约束、确定性答案和归档恢复均满足100%，C/D自然Recall@5满足≥90%；实际跨项目/跨会话检索、旧计划、retrieval再压缩探针均无违规。[完整基线](../packages/eval/baseline.json)。

普通must-hit的两项缺失为 `tool-ls-large: file_0219.ts` 与 `tool-grep-hits: spawnHandler`，未放宽旧断言，也不能宣称全部104项均在上下文中。RTK保存的是sanitized输入，headroom逐项比较角色、文本、工具input/output/error；恢复成功不能只凭found为true。

主动全文展开压力场景A/B/C/D总输入为582,501 / 464,781 / 636,410 / 542,029。D仅节省 **6.95%**，因此成本门禁预期失败，检索及任务检查仍10/10。这意味着检索范围会显著影响总收益，不能把最终上下文比例直接当账单节省。[压力报告](../packages/eval/evidence/eager-recovery.json)。

最终基线benchmark的1/8/32并发RTK降级次数为0/0/13（早期同配置测到26次，说明该值受负载影响）；32并发完成32个hook、产生16个headroom计划，队列拒绝31次（操作次数，不等于丢弃会话数）。40ms含排队时间，实测hook墙钟可能更长。性能不设易受机器负载影响的绝对墙钟断言。单项计时区分hook、transform、planning drain、retrieve、archive probe；客户端内部queue/service没有公开观测，记录null。RSS只采样主进程，不含sidecars；启动握手不含在单fixture延迟中。[baseline concurrency字段](../packages/eval/baseline.json)。

## 验证与适用边界

macOS/Bun1.4.0最终执行 `bun run verify`：**473 pass / 0 fail，4681 assertions，60 files，44.32秒**；全部strict typecheck、7包依赖方向检查及生产宿主SQLite导入边界检查均通过。冻结依赖安装通过。独立最终审查发现的三项Important及最后分帧修复均已复核关闭，无未关闭Critical/Important。主基线刷新后，再次完整回放的相对检查通过；全文展开压力回放仅因combinedNetInput未达标按预期退出1。[机器可读验收记录](reliability-verification.json)。以下命令用于复验：

```sh
bun install --frozen-lockfile
bun run verify
bun run eval --update-baseline --benchmarks
bun run eval --check --skip-latency
bun run eval --invariants --retrieval-strategy eager-recovery --report-path /tmp/eager-report.json
```

最后一项压力场景应因总输入节省不足20%退出1，不能列为“全部场景通过”。

- 本地平台为macOS/Bun1.4.0；Linux已配置CI，尚未在本次本地会话实际运行Linux runner。
- 没有真实provider调用/usage或LLM任务求解实验。8192模拟窗口仅触发规划，A组部分输入超过该模拟窗口，没有发送给模型。
- 回放检索使用工具支持的8192 token页上限和32KiB maxBytes；不是对默认2048页大小的独立收益结论。
- 热路径token预算采用UTF-8字节保守上界；RTK保护优先、headroom近期轮次优先，无法保证每次都达到目标比例。
- 配额为应用层allowance。RTK规范化payload有额外SQLite开销；不自动驱逐引用对象，GC只删旧临时文件。
- history多代展开有深度保护；分页目前需要重复遍历先前叶节点，大型历史的CPU优化仍可继续，但本次分页连续性和逐项恢复已有回归。
- 保持既有identity redactor；本次没有虚构新的自动敏感信息检测能力。
- 旧helper仅用于兼容测试；宿主插件工厂使用实例runtime和client/pure子入口。实验性OpenCode API升级应重新运行集成验证。[操作手册](operations.md)、[集成说明](integration-notes.md)。

## 参考项目与取舍

本次借鉴架构和验证方法，保持本仓库独立实现；没有直接引入下列项目的运行依赖。

| 参考 | 借鉴与边界 |
|---|---|
| [RTK固定提交e53ec1c](https://github.com/rtk-ai/rtk/tree/e53ec1cf180d801f33121855dce37b393ede258c) | 按命令组织过滤策略和失败样例；本地增加来源行、软预算、宿主上下文与故障状态。上游Apache-2.0。 |
| [Headroom固定提交73a6edb](https://github.com/headroomlabs-ai/headroom/tree/73a6edbe83af716bb833da5d902dd55afa6dab40) | 可恢复上下文与稳定前缀的思路；本地实现source digest、活动view快照和检索成本门禁。上游Apache-2.0。 |
| [DCP固定提交11f6517](https://github.com/Opencode-DCP/opencode-dynamic-context-pruning/tree/11f6517780a502512a3467645074be447cb0369e) | 参考宿主生命周期与受保护内容的设计问题；独立实现，未复制AGPL-3.0代码。 |
| [QMD固定提交dbfd0b4](https://github.com/tobi/qmd/tree/dbfd0b4736aeaf761d1a16ca8e424f071df8feb9) | 借鉴全文分片和BM25检索的组织方式；未引入向量库、reranker或额外LLM调用。上游MIT。 |
