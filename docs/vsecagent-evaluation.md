# VSecAgent 离线验收与性能评估

本报告针对公开学习重构，不代表 vivo 私有 VSecAgent。原始结果见
[`packages/eval/security-results.json`](../packages/eval/security-results.json)，
每轮保留独立的环境、分类统计、样本判断和错误；首次失败不会被复测结果覆盖。

## 数据和统计口径

开发集来自 [`security-core/fixtures/development.ts`](../packages/security-core/fixtures/development.ts)，
8 类各 10 条风险、10 条正常，共 160 条。验收集来自
[`security-fixtures.ts`](../packages/eval/src/security-fixtures.ts)，8 类各 20 条风险、20 条正常，共 320 条。
验收集在运行扫描器之前单独冻结于提交 `ed8848b`；源文件 SHA-256 为
`ba147421497ce9263d1be3a9da1cb16268a0d191057eedc89b8b30ad0ff32c54`。
类别、风险标签、结构族 / 模板 ID、支持范围、critical 预期均在冻结文件中；此后没有改标签。

验收结构包括配置格式、秘密字段位置、shell 包装器和控制流、解析后的路径与操作角色、
计算属性、可选调用、TypeScript 类型包装、函数 / 类 / 回调内语法、edit 与 patch 的新旧来源。
它们与开发集存在规则家族共享，部分病例在相同危险原语上改变结构上下文，因此不是 320 个独立随机样本。
编制时可以看到开发集与声明的支持范围，也读取了公开路径/严重级别边界；这是先冻结后运行的独立模板集，
不是第三方盲评。所有 160 条风险预先归入支持范围；运行时的 partial 或扫描失败不能把它们从分母移除。

`detected` 表示出现该样本目标类别的 finding；另一个类别的告警不增加该类别召回。
`warned`、`denied` 按决策分别计数；警告不是阻止。
`uncovered` 表示 partial / unsupported / 无结果；不等于漏检，已识别风险也可能有局部覆盖缺口。
召回分母为预标记 supported 风险；critical 阻止分母为预标记 78 条验收输入。
已有凭证被无关编辑保留的两条风险只要求检测，未标记为新引入的 critical。
正常误警告与误阻止分别按全部 160 条正常输入计算；不可用响应也独立失败。
所有阈值均由 [`security-eval.ts`](../packages/eval/src/security-eval.ts) 根据结果计算，未硬编码通过。

这些是合成离线语法质量数据，不能估计漏洞发生率、整个 SAST 系统准确率、真实仓库风险分布、
跨函数 / 跨文件污点追踪能力或实际回答质量。所有危险命令只作为扫描字符串，未执行。
没有调用外部模型、在线秘密验证服务或真实外部 API。

## 首次验收与修复后复测

首次运行记录为 JSON 的 `phase: first-pass`：

| 数据集 | 风险检测 | critical 阻止 | 正常误阻止 | 正常误警告 | 覆盖不完整 |
| --- | ---: | ---: | ---: | ---: | ---: |
| development160 | 80/80 | 39/40 | 0/80 | 0/80 | 2/160 |
| acceptance320 | 158/160（98.75%） | 74/78（94.87%） | 0/160 | 0/160 | 10/320 |

首次 critical 阻止门槛未通过。四条验收输入（credential risk.09/.10/.13/.17）中，
明确敏感字段的长高熵字面量只触发 `credential.assignment` 警告；开发集也有一条同类情况。
两个完整覆盖漏检分别是 `db.query(("SELECT " + input) as string)` 与
`crypto.createHash(("md5" as string))`。

生产修复由主任务完成：对明确敏感赋值的长高熵非占位符字面量采用 critical，
保留模糊赋值的警告；统一解包括号、`as`、类型断言、non-null 与 `satisfies` 表达式。
主任务另外添加独立正负回归。验收标签保持不变。**修复后的结果属于由保留集发现问题后进行的复测，
不能作为全新、未接触的保留集证据。** 中间 `reproduction` 轮保留了修复前性能和质量记录。

复测最终测量基于 `b4e0c2d`，时间 `2026-09-17T06:30:13Z`；运行前后 18 个生产源文件摘要一致。
结果文件保留五轮记录，包括首次失败、修复前复现和后续复测，最后一轮统计如下。

| 数据集 | 风险检测 | critical 阻止 | 正常误阻止 | 正常误警告 | 警告 / 阻止 | 覆盖不完整 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| development160 | 80/80 | 40/40 | 0/80 | 0/80 | 40 / 40 | 2/160 |
| acceptance320 | 160/160 | 78/78 | 0/160 | 0/160 | 82 / 78 | 10/320 |

开发集、验收集与文本质量门槛均通过。验收集按类统计（每类风险20、正常20）：

| 类别 | 检测 | 警告 | 阻止 | 覆盖不完整 | critical 阻止 |
| --- | ---: | ---: | ---: | ---: | ---: |
| credential | 20 | 2 | 18 | 0 | 18/18 |
| dangerous-command | 20 | 0 | 20 | 9 | 20/20 |
| sensitive-file | 20 | 0 | 20 | 0 | 20/20 |
| path-traversal | 20 | 0 | 20 | 0 | 20/20 |
| dynamic-execution | 20 | 20 | 0 | 0 | 无预标记项 |
| sql-injection | 20 | 20 | 0 | 0 | 无预标记项 |
| xss | 20 | 20 | 0 | 0 | 无预标记项 |
| weak-crypto | 20 | 20 | 0 | 1 | 无预标记项 |

10条局部覆盖缺口仍保留：危险命令中4条风险已阻止，5条正常输入允许但报告partial；
另1条是冻结的 weak-crypto benign.16，内嵌引号使该数据对象示例成为无效TS。该正常样本作为解析错误保留，
没有修改冻结文本或将其冒充完整覆盖样本。所有风险分母仍为160。

固定机器为Apple M2（8逻辑核、16GiB内存），macOS/Darwin25.6.0 arm64、Bun1.4.0。
以下单并发结果均为32次warm请求；单位ms，命中/未命中分别测量：

| 输入 | 未缓存请求 p50 / p95 | 未缓存完整钩子 p50 / p95 | 钩子子进程service p95 | 钩子queue p95 | 缓存命中钩子 p95 | 目标p95 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 简单命令 | 0.29 / 0.78 | 0.32 / 0.65 | 0.47 | 0.03 | 0.25 | 30 |
| 简单路径 | 0.20 / 0.38 | 0.30 / 1.14 | 0.78 | 0.06 | 0.30 | 30 |
| 64KiB TS | 5.38 / 10.83 | 5.06 / 10.23 | 8.03 | 0.46 | 0.98 | 150 |
| 1MiB TS | 66.35 / 79.59 | 66.52 / 81.03 | 71.17 | 3.04 | 12.30 | 500 |

所有单并发目标通过，未缓存单并发组cacheHits均为0、命中组均为32。8/32并发下的简单输入及64KiB均成功，
1MiB因每次请求同时携带args和候选源码（序列化后超过2MiB）而触发8MiB队列上限。具体如下：

| 1MiB边界 | 缓存 | 并发 | 成功 / 请求 | 过载率 |
| --- | --- | ---: | ---: | ---: |
| scanner-request | miss | 8 | 12/32 | 62.50% |
| scanner-request | miss | 32 | 3/32 | 90.62% |
| scanner-request | hit | 8 | 12/32 | 62.50% |
| scanner-request | hit | 32 | 3/32 | 90.62% |
| full-toolBefore-hook | miss | 8 | 12/32 | 62.50% |
| full-toolBefore-hook | miss | 32 | 3/32 | 90.62% |
| full-toolBefore-hook | hit | 8 | 14/32 | 56.25% |
| full-toolBefore-hook | hit | 32 | 4/32 | 87.50% |

全部1,536次计时请求中193次过载、0次超时；冷启动范围121.8–246.7ms。
父进程抽样RSS最高685.0MiB，子进程边界抽样RSS最高596.3MiB。整组耗时11.55s，
父CPU user/system分别1371.5/556.8ms；各子进程累计CPU时间保存在JSON。
完整钩子拒绝过载写入时还会扫描诊断文本，导致未缓存evaluation组也可能出现附加sanitize缓存命中。
JSON逐组记录evaluationRequests和sanitizationRequests，并明确health.cacheHits涵盖所有子进程操作；
这些附加命中不表示不同源码的evaluation被缓存。


## 性能方法与资源限制

性能仅在显式 `--performance` 下运行。实际使用 `VsecClient` 的 Bun 子进程，
分别测扫描请求完整往返与真实 `createPluginRuntime().toolBefore`。
后者包括参数适配、路径规范化、候选内容准备、队列、JSON 传输、子进程扫描和决策。
只调用钩子，没有执行底层工具。RTK/headroom 压缩关闭，安全模式为 enforce。

四种输入为简单命令、简单路径、64 KiB TS、1 MiB TS。TS 文本由多个实际声明组成，
不是只填充注释；每个未命中请求改变源文本头部，命令 / 路径也变化。
每组记录 32 个请求，覆盖 1/8/32 并发与缓存 miss/hit，合计 48 组、1,536 个计时请求。
每组另有一个不计入 warm 统计的首次未缓存请求；缓存命中组先预热相同输入。
单并发miss/hit由实际 `health.cacheHits` 差值核对；过载钩子的附加sanitize调用单独计数。冷启动单独记录，包含 ready 和一次 health 往返；
第一次解析器实际工作的代价在 `firstUncachedRequest` 中保留。

p50/p95 使用 nearest-rank。JSON 同时保存成功请求与全部 settled 请求的延迟，
并分别保留 queue、child service、timeout/overload 比率与每个错误原因的数量。
30/150/500 ms 的目标只针对固定机器单并发 warm p95；达到目标也要求该组全部请求成功。
并发组不套用单请求目标、不把过载伪装成快速扫描结果。
共享 CI 仅门控功能质量；机器依赖的时间不作为 CI 通过条件。

父进程 RSS 每 5 ms 抽样，子进程 RSS 在各组边界通过 health 读取，后者不是峰值。
父进程 CPU 来自 `process.cpuUsage`，子进程 CPU 是 `ps` 的累计 user+system 时间；
重启会重置子进程时钟。结果保留启动次数、是否重启、缓存大小和缓存命中数。
RSS 包含运行时、解析器、测试输入与结果，并非只包含缓存；16 MiB 缓存上限不能解释为总进程内存上限。

## 安全开启的文本质量与成本记账

真实子进程经真实 plugin runtime 处理 user message、system、tool output 和 retrieval 四个面：
12/12 条非敏感约束保留，秘密泄漏 0，脱敏 4 个，隐藏 0 个。
使用 `o200k_base` 精确计数，原文本 228 tokens，模型可见文本 96 tokens；
差值 -132 记录为安全过滤带来的 token 变化，**压缩节省记为 0**。
此组没有运行模型，不能推断回答质量或实际付费模型成本。

不可用扫描器测试保留为单独降级组：1/1 字段隐藏，泄漏 0，原有约束保留 0/1。
43 个输入 tokens 对应 11 个可见占位 tokens，43 个 tokens 被计入 withheldInputTokens；
差值 -32 也不计为压缩节省。隐藏证据带来的信息损失被显式记账。
security-off 的现有 RTK/headroom 消融与真实 OpenCode 1.18.23 宿主验收由主任务另外运行。

## 复现

```sh
bun test packages/eval/test/security-eval.test.ts
bun run --cwd packages/eval typecheck
bun packages/eval/src/security-cli.ts --phase reproduction
bun packages/eval/src/security-cli.ts --performance --phase reproduction
# 单独保存新测量，避免改变提交的历史记录
bun packages/eval/src/security-cli.ts --performance --output /tmp/vsec-reproduction.json
```

默认只运行离线质量和文本记账；质量门槛失败退出 1，基础设施异常退出 2。
结果文件按轮追加；不覆盖首次结果，拒绝覆盖不同结构的文件。
CLI 使用 `import.meta.main`，被测试或其他程序导入不会启动评估。
每轮记录主机 / CPU / Bun / Node、解析器版本、策略、配置、命令、fixture SHA-256 和 Git 状态；
修复后复测还保存 18 个生产源文件摘要，用于识别工作区尚未提交的具体实现。
首次评估时工作区存在并行开发修改，因此其 Git HEAD 不是完整工作区快照；JSON 明确记为 `gitDirty: true`。

本套样本、评估器和报告由 AI 编制，生产修复与结果按仓库自动化测试验证；合成数据和方法边界已在上文披露。
