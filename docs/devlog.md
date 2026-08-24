# BlueCode 开发日志 —— 困难、错误与解决记录

> 维护方式：控制器（主会话）集中维护，随任务推进持续追加。每条记录包含：现象 → 根因 → 解决思路 → 解决方法 → 教训/预防。
> 存放位置：执行期暂存于 SDD 工作区（git 外）；M7 文档收尾时并入 `bluecode/docs/devlog.md` 一并提交入库。
> 时间基准：2026-08-22 项目启动。

---

## 2026-08-22 · M0 上游刷新

### 1. opencode-dev 快照不是 git 仓库，「更新代码库」无从下手

- **现象**：README 要求「根据 opencode 源码进行开发（记得更新代码库）」，但 `opencode/opencode-dev/` 是解压目录（v1.18.10），无 `.git`，无法 pull/fetch。
- **根因**：快照以 zip 分发，天然脱离版本控制。
- **解决思路**：把「更新」定义为可重复执行的脚本化重建，而非一次性手工操作；同时保留 zip 作为回滚来源。
- **解决方法**：编写 `bluecode/scripts/refresh-upstream.sh`——`git clone --depth 1` 上游 → 解析最新 release tag 并校验 semver ≥ 1.18.10 → `rsync -a --delete --exclude '.git'` 原地替换快照 → 打印刷新后版本号。实际刷新结果：**v1.18.10 → v1.18.21**。
- **教训**：对外部快照的任何变更都应脚本化、幂等、留有恢复路径；刷新后必须重跑集成点核实清单（已产出 integration-notes.md 的 8 条结论 + 4 处基线差异）。

### 2. 实现环境缺 Bun，实现者正确报 BLOCKED

- **现象**：Task 1 实现者执行 `bun --version` 得到 command not found (exit 127)，按纪律报告 BLOCKED 而非绕过。
- **根因**：规划选定 TypeScript 运行于 Bun，但宿主机未安装。
- **解决思路**：工具链是已批准规划的既定前提，属用户级可逆安装，不需要重新决策；安装后恢复原实现者（保留其上下文）。
- **解决方法**：官方脚本 `curl -fsSL https://bun.sh/install | bash` 装 Bun 1.4.0 至 `~/.bun`；后续所有命令显式 `export PATH="$HOME/.bun/bin:$PATH"`。账本记录裁决与代价（可 `rm -rf ~/.bun` 完全移除）。
- **教训**：子代理遇阻不绕行是对的；控制器裁决要连同「为什么/代价」一起落账本，保证可追溯可回滚。

### 3. zsh 将 `====` 当作 glob 展开导致报错

- **现象**：shell 中 `echo ====` 直接报错（zsh no matches found 类错误）。
- **根因**：zsh 对未加引号的 `=word` 形式做 =command 展开/glob 处理，bash 无此行为。
- **解决方法**：分隔线改用其他字符或加引号 `echo '===='`。
- **教训**：跨 shell 脚本与交互命令默认按最严格者（zsh）写。

### 4. opencode-dev 内 `bun install` 首次失败 1 个包

- **现象**：2319 packages installed 后提示 `Failed to install 1 package`（未指明包名）。
- **根因**：复跑 `bun install` 全程无任何 fail/error 行、退出码 0——判定为首轮网络/postinstall 瞬态抖动，非依赖本身问题。
- **解决方法**：重跑一次安装确认干净；报告如实记录该瞬态。
- **教训**：「Failed to install N」先复跑再定性的成本极低；不可复现的一次性失败不应触发依赖版本改动。

### 5. macOS（BSD）sed 不支持 GNU 风格 `,+Np` 地址

- **现象**：`sed -n "$(grep -n … | cut -d: -f1),+25p" file` 报 `sed: 1: ",+25p": invalid command code ,`。
- **根因**：`,+N` 地址区间是 GNU sed 扩展，BSD/macOS sed 不支持。
- **解决方法**：改为显式行区间 `sed -n 'X,Yp'`（先用 grep 求起止行号）。
- **教训**：本机是 Darwin；文本处理一律按 POSIX/BSD 子集写，或改用 awk。

---

## 2026-08-22 · Task 1 审查发现（M0 产出的缺陷）

### 6. `set -euo pipefail` 下管道无匹配会杀死脚本，使错误防护成死代码

- **现象**（审查 Minor #1）：`refresh-upstream.sh` 中 `LATEST_TAG="$(… | grep -E '^v…$' | sort -V | tail -1)"` 在上游无 release tag 时，grep 返回 1 经 pipefail 传播，脚本在到达 `[ -z "$LATEST_TAG" ]` 友好报错分支前就退出——防护分支永不可达。
- **根因**：pipefail 让「无匹配」这一预期内情况以未处理失败的形式短路了它自己的兜底逻辑。
- **解决思路**：让预期内的空结果不再是管道失败。
- **解决方法**：grep 段追加 `|| true`（Task 2 前置修复，commit 109b6a5）；修复后用忠实模拟验证：有 tag 时选出最高 semver，无 tag 时 LATEST_TAG 为空且防护可达、退出码 0。
- **教训**：`set -o pipefail` 脚本里每个「允许为空」的过滤段都要显式吞掉退出码；写完防护分支要真的走到一次它。

### 7. 版本号提取可能静默为空字符串

- **现象**（审查 Minor #2）：VERSION 由 sed 提取，若 package.json 格式变化则静默得空串，脚本打印「refreshed to version: (tag …)」这类残缺输出且不报错。
- **解决方法**：提取后加 `[ -n "$VERSION" ] || { echo "ERROR…" >&2; exit 1; }` 防护（109b6a5）。
- **教训**：从结构化文件抓取的关键值，取完立刻校验非空。

### 8. @types/bun 与 bun-types 版本范围漂移

- **现象**：devDependencies 中 `@types/bun: ^1.2.0` 而 `bun-types: ^1.4.0`（lockfile 都解析到 1.4.0，暂未实际错位）。另：实现过程中曾出现 bun-types 类型解析失败，自愈方式是将其显式列入 devDependencies 后恢复正常。
- **根因**：两个包本是一体（@types/bun 只是 bun-types 的转发壳），分别声明范围就会漂移。
- **解决方法**：统一为 `^1.4.0`（109b6a5）。
- **教训**：互为转发的类型包保持同一版本范围；类型解析问题优先怀疑 types 包缺失而非 tsconfig。

---

## 2026-08-23 · M1 contracts + shared 执行期

### 9. shell 模拟验证连续两次因「测试输入形状失真」误判管线有问题

- **现象**：验证 refresh-upstream.sh 修复效果时，同一管线第一次模拟输出为空、第二次仍为空，看似修复无效。
- **根因**：两次都是测试输入造错了，而非管线错——① 第一次漏掉 sed 阶段，输入仍是 `refs/tags/vX.Y.Z`，当然匹配不上 `^v…$`；② 第二次给 awk `{print $2}` 喂了单列输入，而真实 `git ls-remote` 输出是 `<SHA>\t<ref>` 两列，$2 取的是 ref 列，单列输入下 $2 为空。
- **解决方法**：按真实数据形状构造输入（两列、制表符分隔）后一次通过：多 tag 选出 v1.18.21，无匹配时空串且防护可达。
- **教训**：模拟验证的第一嫌疑人是输入保真度——逐段核对每级管道假设的字段数/分隔符/加工阶段，再怀疑被测逻辑。

### 10. zod schema 测试草稿中关于默认值经判别联合传递的错误断言

- **现象**：contracts 测试草稿里一条断言预期「params 内的默认值会在 response/request 判别联合解析时生效」，实际不会。
- **根因**：`.default()` 只作用于所在 schema 被直接 parse 的层级；外层信封 schema 用 `z.unknown()` 占位 params 时，per-op 的默认值要等 server 侧按 op 二次校验才会应用。
- **解决方法**：修正断言语义——信封层不展开 params；默认值的生效点在 per-op params schema（M3 server 实现），contracts 注释注明该约定。
- **教训**：zod 的 default 是「parse 时填充」，不是「类型系统常量」；分层校验架构里要明确每一层负责哪些约束。

### 11. 实现者子代理反复「宣布下一步就停」（流程性困难）

- **现象**：实现者多次只输出一行中间状态说明（如「现在开始构建骨架」「第三步：安装 js-tiktoken」）即结束回合，而非持续推进到 DONE。
- **根因**：后台长任务的回合终止条件未被充分约束；模型把「汇报进度」误当作回合终点。
- **解决思路**：不改工作内容，只修正终止契约——每次恢复消息明确列出剩余待办清单 + 「一直干到 DONE 或 BLOCKED 为止，不要在中间状态停下汇报」。
- **解决方法**：SendMessage 恢复原实现者（保留上下文），附剩余待办与终止契约。此模式在本会话已使用三次，均有效恢复。
- **教训**：派发简报里应一开始就写入显式终止契约（本会话新派发已在做）；对已跑偏的在途代理，用「待办清单 + 终止语句」恢复比重派更省。

---

## 2026-08-23 · Task 2 审查发现

### 12. 控制器简报中的 shell 修复建议本身是优先级错误

- **现象**：Task 2 简报前置修复第 1 条建议「grep 段追加 `|| true`」并给出字面写法 `… | grep -E '…' || true | sort -V | tail -1`。实现者没有照抄，而是改用分组形式 `{ grep … || true; } | sort | tail` 并说明理由；任务审查者随后实证验证：字面写法下 happy path 输出**未经排序的多行**（`|` 运算符优先级高于 `||`，导致 `a | b || true | c | d` 实际是 `(a|b) || (true|c|d)`——grep 成功时 sort/tail 根本不在管线里）。
- **根因**：shell 中重定向与管道运算符的绑定优先级高于 `||`/`&&`；把 `|| true` 插进管道中间改变了整个管线的分组。
- **解决方法**：采用实现者的分组写法（commit 109b6a5）；审查者以最小复现确认两种形式的输出差异。
- **教训**：①简报里的「修复建议」同样是被审查对象——实现者对明显可疑的指令提出更优方案并验证，是正确行为；②`|| true` 注入管道必须用 `{ …; }` 分组或放在独立语句里；③审查环节的实证复验（跑一条最小命令）抓住了双方都险些放过的错误。

### 13. zod `.default()` 与分层校验架构的语义错位（设计期发现）

- **现象**：contracts 测试草稿最初断言「信封 schema 解析时 params 内默认值生效」，失败。
- **根因**：`.default()` 只在该 schema 被 parse 时填充；rtk 信封层 params 为 `z.unknown()` 占位，per-op 默认值（budgetTokens=512 等）要等 server 侧按 op 二次校验才应用。
- **解决方法**：修正测试语义；contracts 文件头注明「per-op params 由 server 按 op 再校验、默认值在该层生效」约定；全部默认值以 zod `.default()` 编码在 per-op schema 中（M3 server 直接 parse 即得）。
- **教训**：分层校验体系里，「哪一层负责哪个约束」必须显式成文，否则类型系统不会替你发现语义错位。

### 14. bun test 通过但 `bunx tsc --noEmit` 对测试文件报错——元组数组字面量被拓宽

- **现象**：rtk-core 首轮全量验证中，`bun test` 全过，但 workspace typecheck 在 test/classify.test.ts 报 TS2769（`Argument of type 'string' is not assignable to parameter of type 'StrategyName'`）。
- **根因**：`const cases: Array<[string, string, string]> = [...]` 把第三个元素声明为宽泛 string，解构出的 `expected` 失去字面量类型；bun:test 运行时不做类型检查所以测试照常通过，tsc 才暴露。
- **解决方法**：元组类型改为 `Array<[string, string, StrategyName]>` 并从 @bluecode/contracts import 该类型——表驱动用例的期望值在编译期即受约束。
- **教训**：bun 的「运行时过」与 tsc 的「类型过」是两道独立闸门，verify 必须两者都跑；表驱动测试的期望列应标注精确联合类型而非 string。

---

## 流程备注（非代码错误）

- **SDD 脚手架脚本与本计划格式不匹配**：skill 自带脚本要求 git 仓库且只识别 `# Task N` 标题，而规划为里程碑表格、仓库由 Task 1 才创建。裁决：控制器手写各任务简报（内容等效）、review-package 在 bluecode/ 仓库内运行并显式传 OUTFILE、BASE 用空树哈希 `4b825dc6`。已记入账本 Ruling R2。
- **上游 v1.18.21 与基线结论的差异**（重要发现，非操作失误）：transform 新增 compaction.ts:379 第二调用点；DEFAULT_TAIL_TURNS 常量改为 compaction.tail_turns 配置项；usable() 增加 reserved 覆盖与回退分支；调用点行号整体漂移。全部记入 `bluecode/docs/integration-notes.md`，并影响 M4/M5 设计前提（applyPlanInPlace 幂等性升级为硬要求）。

---

## 2026-08-23 · Task 4 审查期

### 15. 子代理免费模型日配额耗尽——审查者连续两次 429 终止

- **现象**：Task 4 审查者子代理读完 diff 后以 `API Error: Request rejected (429) · Rate limit exceeded: free-models-per-day-stealth` 终止；约 4.5 小时后经 SendMessage 从转录恢复（上下文完好、diff 已读），下一个 API 请求立即再次 429。同期主会话（控制器）始终正常工作。
- **根因**：子代理走免费 stealth 模型池且按日限额计费；多日多任务的实现者+审查者消耗将当日池耗尽。主会话不受同一限额约束（或优先级不同）。
- **解决思路**：恢复原代理（保留其已读上下文）是首选且确实成功恢复过一次，证明「SendMessage 复活」路径可用；但配额是硬约束，恢复解决的是中断问题而非容量问题。审查门禁的价值在其实证性（独立复跑、交叉核对）而非执行者身份——代码是实现者写的，控制器代审不构成自我审查。
- **解决方法**：裁决由控制器亲自执行 Task 4 审查，沿用同一输入三件套与同一核对清单；实证手段照旧（独立复跑 verify、contracts 正则/枚举 grep 交叉验证、stdout 纯净性 grep、diff 范围核对）。审查报告 task-4-review.md 与常规审查同格式同深度。账本记录该偏离及代价。
- **教训**：①后台长流程要为「基础设施容量」这类失败预留裁决路径——四种报告状态之外还有第五种：执行者本身消失；②SendMessage 从转录恢复对「读材料读到一半被打断」的场景特别有效，值得在每次派发时记下代理 id 以备恢复；③代审的独立性边界要在账本里写清楚（谁写的代码、谁审的、为什么可接受），不能默认成立。

---

## 2026-08-23 · M4 实现与测试闭环期（控制器内联）

### 16. 管道吞退出码 + bun 不在默认 PATH

- **现象**：`bun test … | tail -4 && next_cmd` 中测试失败但 `&&` 后命令照常执行；另一处 `bun: command not found`。
- **根因**：①zsh/bash 中 `$?` 取管道最后一个命令（tail）的退出码，bun test 的失败被 tail 的 0 掩盖；②bun 装在 `~/.bun/bin`，非交互 shell 默认 PATH 不含它。
- **解决方法**：管道断言前 `set -o pipefail`；每次 Bash 调用开头 `export PATH="$HOME/.bun/bin:$PATH"`（Bash 工具环境不跨调用持久，逐次导出最可靠）。
- **教训**：CI 式「跑测试再判断」的复合命令，pipefail 必须与 PATH 一样视为环境前置条件。

### 17. 哈希命名空间分裂——重建按 contentHash 找对象必然落空

- **现象**：rebuild 一致性必测失败：删 index.db 重启后 afterHits 为空、byHash found:false。首次索引一切正常，仅重建路径全空。
- **根因**：对象按 **gzip 字节的 sha256** 寻址（writeObject 内部摘要），而 cas_meta/refs/retrieve 用消息的 **contentHash**（canonicalJSON 投影哈希）。两个命名空间之间没有映射；正常路径写读都走同一把哈希所以无感，重建从 cas_meta 出发按 contentHash 找对象 → 全部落空。这是设计级缺陷而非实现笔误——任何「补映射表」方案都要回答「映射本身存哪」，不如消灭第二命名空间。
- **解决思路**：内容寻址的本意是「地址即内容的名字」。对 headroom 而言消息的「内容身份」是 canonical 投影的 contentHash（turns.ts 已定义且 refs/cas_meta 已在使用）；gzip 只是存储编码（如同 HTTP 传输编码），不该参与命名。完整性保障改由 gzip CRC32 + JSON.parse 双重校验承担——损坏的对象要么解压失败要么解析失败，不会静默错配。
- **解决方法**：shared/cas.ts 新增 `writeObjectAs(dataDir, hash, content)` / `readObjectAs(dataDir, hash)`（保留原字节摘要变体给 rtk 用）；objects.ts 签名改为显式收 hash；engine 写对象传 `hashes[i]`；测试统一用 `contentHash(message)` 生成地址。
- **教训**：一个系统里同名概念（"hash"）出现两套生成规则时，必然在「只走一条路」的测试里相安无事、在交叉路径（重建/迁移/恢复）上爆炸。必测清单里「删派生存储重建」正是为暴露这类分裂而设——它值回票价了。

### 18. meta/index 拆库——单库设计使必测要求不可满足

- **现象**：与 #17 同一轮暴露：即使修好寻址，「删 index.db 自动重建」仍不可能——cas_meta 与 chunks 同库，删库连归属账本一起没了。
- **根因**：简报把两类存活语义相反的数据放进了同一个 SQLite 文件：归属账本（必须持久）与派生索引（随时可删）。文件是 SQLite 最小的原子单元，「删派生部分」在这个设计里没有可执行的操作。
- **解决思路**：按「谁能重建谁」划库——meta.db 只存不可再生的归属事实；index.db 存全部可再生数据。两库不能共享事务，原子性改由**写入顺序**表达：objects → meta tx → index tx。崩溃只会留下前缀步骤；「归属领先派生」是可修复方向（启动 heal / replay backfill），反向不可修复，顺序保证永不出现反向。行存在性蕴含对象持久性（index 行严格最后写）→ 稳态幂等回退为 N 次点查零 I/O。
- **解决方法**：db.ts 重写为 openMetaDb/openIndexDb/openStore 三入口 + rebuildFromObjects；engine 启动自愈条件 = schema 不符 ‖ FTS 损坏 ‖ chunk 计数 < cas_meta 计数。
- **教训**：「删掉 X 再重启应自愈」这类需求要在设计期翻译成「X 里有什么、X 外还剩什么」——若答案里有必须存活的东西，拆分就是前置条件而不是优化。

### 19. Bun.spawn 不透传运行时修改的 process.env

- **现象**：client spawn 集成测试失败：守护进程瞬死，错误信息 `--dataDir (or BLUECODE_DATA_DIR) is required`——而测试明明设置了 `process.env.BLUECODE_DATA_DIR`。
- **根因**：Bun.spawn 不传 env 选项时，子进程继承的是**启动时快照**的环境（或以其他方式绕过了运行时对 process.env 的修改），测试进程内后设置的变量子进程看不见。（对照：Node child_process 默认 env 即 process.env 引用，行为不同。）
- **解决方法**：connect() 显式 `env: { ...process.env } as Record<string, string>`。这同时是生产正确性的修复——插件进程可能在 connect 前才决定 dataDir。配套改进：spawn 启动确认失败时把子进程 stderr 摘录并入错误信息，此类问题从「猜测」变「直读」。
- **教训**：跨进程边界的隐式契约（环境变量）要显式搬运；错误信息携带诊断上下文（stderr/stdout 摘录）是一次投入、终身受益的基础设施。

### 20. 幽灵 "(unnamed) hook timed out"——close() 在已销毁 socket 上等待永不再来的事件

- **现象**：client.test 每轮确定性多出一个 `(unnamed) [5002ms] a beforeEach/afterEach hook timed out` 失败；文件里根本没有 beforeEach/afterEach。删除调试文件、重跑均无法消除，且总时长恰好 ≈5000ms。
- **排查**：逐文件隔离 → 锁定 client.test；连续三轮精确 5002.07ms → 是某个 5s 定时器到点被 bun 判定为钩子超时，而非真实钩子。审计该文件所有 5s 量级的悬挂点：afterAll 里 `await client.close()` —— close() 注册 `once("close")` 等 socket 关闭，但被 SIGTERM 的守护进程 shutdown 时已 destroy 了这条连接，socket 的 close 事件早已发过（或永不触发），promise 悬挂至 bun 兜底超时。
- **解决方法**：close() 开头 `if (this.socket.destroyed) return Promise.resolve()`（closed 标志无条件置位，保持「关闭后请求拒绝」语义不变）。
- **教训**：①「幽灵测试」先看时长——精确等于已知超时常量（5000/30000ms）即指向悬挂的 promise 而非测试逻辑；②等待一次性事件（once）前必须先问「这个事件是否可能已经发生过了」，node:net 的 socket 尤甚（destroy 不补发事件）。

### 附注：冒烟脚本两次踩 schema（预期内的正确拒绝）

- retrieve 参数误拍平 `{projectId, sessionId, hash}` 到顶层——strictObject 正确拒绝；by-hash/by-query 都须 `namespace: {...}` 包裹。此坑已写入 task-5-report 接口须知第 5 条，M5 派发时随附。
- server.test raw 帧漏传必填的 `contextWindowTokens` → E_INVALID_PARAMS；错误 detail 直接指出缺失字段名，协议层诊断信息设计生效。

### 21. M5 接管期：SDK mock 形状不符——源码静默早退而非报错

- **现象**：接管 M5 后水位触发与 in-flight 守卫两组测试同时失败：compress 从未被调用、pendingPlan 未落。mock 返回值看起来「合理」（裸消息数组）。
- **根因**：真实 opencode SDK 把所有响应包在 `{data: …}` 里（`client.session.messages()` / `session.get()` / `model.get()` 均然），插件源码读 `.data` 解包；mock 返回裸数组时 `.data` 为 undefined，解包结果 undefined → 源码沿「无消息」路径静默早退，不抛任何错。
- **解决方法**：createMockSdkClient 三个方法统一包 `{data}` 并注释说明该 SDK 约定。
- **教训**：对第三方 SDK 写 mock 前先读其真实返回形状（或从源码调用点反推）；「mock 合理」≠「mock 正确」——解包型代码的 mock 缺包装层时，失败模式是静默空转而不是显式报错，测试红得没有线索。

### 22. M5 接管期：tool() 包装器与 zod refine 的表达力断层 + 顺带发现真缺陷

- **现象**：简报要求 headroom_retrieve 参数满足「hash/query 二选一」refine 校验，但自研 `tool()` 助手只接受 ZodRawShape 并做 object parse——RawShape 无法承载 `.refine()`。
- **根因**：两层问题。①包装器类型面太窄（只认 shape 不认完整 schema）；②顺带审查实现时发现真缺陷：retrieve-tool 的 namespace 硬编码 `sessionId:"current"`，而归档历史按真实 sessionID 落库——by-query 在生产中永远查不到任何东西（测试全绿因为 mock 不校验 namespace）。
- **解决方法**：①tool.ts 的 execute 对外类型改 `z.input<ZodObject<Args>>`（调用方传 pre-parse 参数，default 尚未应用），内部 parse 后以 `z.infer` 传给定义的 execute；②retrieve-tool 自建 `RetrieveArgsSchema = z.object(shape).refine(...)`，execute 入口强制 re-parse——校验语义（二选一、hash 格式）与 default limit=5 应用时机都在这一层钉死。
- **教训**：「测试全绿」和「功能可用」之间隔着 mock 与真实的形状差——硬编码的查询键让检索工具变成永远空手的摆设，唯一能抓住它的是断言 mock 收到参数值的测试（default-limit 测试恰好捕获了 capturedParams，才暴露此缺陷）。包装器 API 设计时预留逃生门（接受完整 schema 或允许 re-parse）比事后绕路便宜。

### 23. M5 接管期：bun test 全绿 ≠ 类型安全——tsc 首跑全红的批量成因

- **现象**：M5 此前从未跑过 tsc（verify 链里 bun test 不查型），接管后首次 typecheck 报错遍布 plugin 包。
- **根因**：六类独立成因叠加——tsconfig paths 缺 @bluecode/rtk-core 传递映射（tsc 会跟随 rtk 源码进 rtk-core 的 import）；exactOptionalPropertyTypes 下条件字段直传 undefined；noUncheckedIndexedAccess 索引访问未守卫 ×2；导入来源写错包；可选挂载点未 ?. 调用；测试字面量缺显式注解导致收窄报错。
- **解决方法**：逐类批处理——paths 补映射、统一 `...(x !== undefined ? { x } : {})` 条件展开模式、守卫+非空断言、修正 import 来源、`hooks.dispose?.()`、八处 output 字面量加显式类型注解。修后 tsc 0 错误且 verify 保持 221 绿。
- **教训**：CI/验证链必须把 typecheck 放在与 test 同级的门禁位（本项目 verify 已含，但实现者从未跑到 verify 就掉线了）——「测试绿但没跑过 typecheck」的代码等于没验收；exactOptionalPropertyTypes/noUncheckedIndexedAccess 这类严格开关的价值恰在于把运行期 undefined 事故提前到编译期，代价是写法纪律要成模式地推广而不是逐处救火。

### 24. M5 审查轮：无会话标识的钩子里，「无条件清理」就是跨会话数据丢失

- **现象**：审查者报「transform 钩子会把 A 会话的 plan 误应用到 B 会话消息数组」。核实后发现真缺陷在另一处且更糟：B 会话的 transform 调用会把 A 会话的 pending plan **白白消费掉**——applyPlanInPlace 对不匹配 ID 返回 false（惰性），但 handleMessagesTransform 不看返回值、无条件 `pendingPlans.delete(sessionId)`，压缩结果永久丢失。
- **根因**：上游 opencode 的 transform 钩子两处调用点都传 `{}` 作为 input（compaction.ts:379 / prompt.ts:1255），插件拿不到 sessionID，只能遍历所有 pending plan。遍历本身安全（replacedMessageIds 是全局唯一消息 ID，外会话数组必然零匹配 → applyPlanInPlace 惰性返回），但「应用失败也删除」把惰性安全性整个击穿。
- **解决方法**：delete 改为仅在 applied===true 时执行；已应用的 plan 因 marker 幂等检测无害留存，dispose 兜底清理。配跨会话双向回归测试（B transform 应用 B 且保留 A → A transform 再应用 A）。
- **教训**：①钩子拿不到上下文标识时，「遍历 + 按内容匹配」的方案里每个副作用都必须以匹配成功为前提——清理动作也不例外；②审查者的 finding 描述与真实缺陷可能不同甚至例子全错，但方向成立时深挖代码往往能挖出比报告更严重的问题——裁决前必须亲自读代码。

### 25. M5 审查轮：同名配置面下的异构默认语义——统一 resolver 反而埋雷

- **现象**：sidecar.ts 定义了漂亮的统一三段 resolver（显式选项 > 环境变量 > 包相对回退），但运行期零调用点——三个连接点各自硬编码路径。接线核查时发现更深一层：直接照原样接线会**劣化**行为。
- **根因**：两个客户端的默认解析语义根本不同。RtkClient 自解析「本模块同级 bin.ts」（布局稳定，注释明言 stable regardless of caller layout）——插件从自己目录猜 `../../rtk/src/bin.ts` 在安装布局下必然断裂，严格劣于客户端默认；HeadroomClient.connect 无 spawn 配方时只连接不拉起——原实现只在用户显式给 entry 时才传 spawn，默认配置下 headroomd 死了永远不会自愈。一个该「少传」（undefined 让客户端自决），一个该「必传」（不给配方就永不自愈），统一的 tier-3 无法同时正确。
- **解决方法**：sidecar.ts 拆成两个形状不同的 resolver 并在模块头写明为什么分叉：resolveRtkEntry 三段返回 `string | undefined`（tier-3 = undefined）；resolveHeadroomEntry 三段必有值。三个连接点全部接线后，rtk 尊重客户端自解析、headroom 默认配置获得 connect-or-spawn 自愈能力。
- **教训**：「为多个依赖写统一封装」前先逐个核对各依赖的默认行为差异——抽象层抹平 API 形状容易，抹平语义差异就会把某一方的关键行为静默关掉（这里是自愈拉起）。封装层的文档必须回答「为什么这两个分支不一样」，否则下一个维护者会把它「统一」回去。



### 26. M6 测试编写期：模块级求值让「进程内确定性测试」成为假阴性

- **现象**：fixtures 的字节相等测试（两次 buildFixtures() 逐字节比较）全绿，但探针发现生成器里散布 Math.random()——跨进程内容每次不同。
- **根因**：TOOL_OUTPUT_POOL 是模块级常量，import 时求值一次。同一进程内两次构建共享同一份 pool，字节相等必然成立；随机性被「冻结」进了本次进程的 pool，只有换个进程重跑才能看到漂移。而 baseline ±2pp 门禁恰恰是跨运行对比——随机 ls 文件大小、噪声选词会让压缩率逐次抖动，门禁迟早误报或漏报。
- **解决方法**：mulberry32 固定种子替换全部 Math.random；测试加 sha256 digest 锚点直接钉死全部 fixture 字节（内容有意变更时才更新 digest），把「跨进程确定性」从约定变成断言。顺带发现收集器五类错位（步长错位、扩展名映射矛盾、跨 fixture 事实混入、零埋点、Set 去重缺失）——测试守护的金线本身先要经得起测试。
- **教训**：「确定性」的验证必须跨进程边界才有效力；模块级求值 + 进程内断言是最容易造出假阴性组合的地方。凡是「构建一次、多次使用」的常量，其随机性缺陷会被进程生命周期掩盖。

### 27. M6 全量首跑：三个只在真实入口暴露的接线缺陷

- **现象**：单测与 smoke 全绿，`bun run eval` 首跑三连败：headroomd ENOENT → 报告路径双重解析 → baseline 写不出来。
- **根因**：①HeadroomClient 契约是无 spawn 配方只连不拉起、daemon 只读 BLUECODE_DATA_DIR env——runner-smoke 测试恰好显式设了两者，把这个缺口完美遮住；②report/baseline 路径写成了 CWD 相对，而 `bun run eval` 脚本带 --cwd packages/eval，resolve 后变成 packages/eval/packages/eval/...；③checkBaseline 里 loadBaseline() 为空的 early return 排在 freeze 分支前面——「还没有基线」恰是需要创建基线的时刻，逻辑顺序却要求它先存在。
- **解决方法**：CLI 默认供给 entry 与 env（注释说明契约来源）；路径改模块相对导出常量（测试同步改用导入）；freeze 分支提前并补「无基线时 --update-baseline 可创建」回归测试。
- **教训**：smoke 测试的环境准备越周到，越容易替生产入口挡掉它本该暴露的问题——关键接线至少要有一条「从真实入口原样走一遍」的验证路径；「缺省值分支」的先后顺序要专门审：任何 early return 都可能把初始化路径挡在门外。

### 28. M6 召回评估：评估面窄会把组件契约测成缺陷

- **现象**：全量首跑 must-hit 召回 B/C/D 仅 15-29/94，远低于组件设计目标，险些误判为压缩质量事故。
- **根因**：runner 的召回证据采集过窄——B 组只拿第一个工具输出的压缩结果做匹配（用户消息等未触及文本里的事实全部算丢失），C/D 组只 fetch 第一个 ref、只 query 第一条事实。而 headroomd 的契约是「细节移出上下文但保持可检索」：只采样一个 ref 等于只验证了契约的最小样本。
- **解决方法**：B 改判完整压缩后上下文；C/D fetch 全部 refs 拼接 + 逐 fact query 探查（每 fixture ~90 次 UDS 往返，亚秒级），并把探查移出延迟计时（测量开销不等于产品延迟）。修后 B 75/94、C 88/94、D 74/94，剩余 miss 经探针定性为 rtk 窗口截断的策略性取舍（read 中段 / ls 尾行 / 流式首帧 / 无锚点噪声），按简报 concern 路径如实记录而非调 fixture 掩饰。
- **教训**：评测 harness 的数字离谱时，先怀疑评估面再怀疑被测组件——「可检索=未丢失」这类契约语义必须在评估逻辑里完整展开，否则组件会被自己的规格冤枉；召回探查属于测量开销，必须与产品延迟的计时边界分开。

## 2026-08-24 · M7 实机冒烟

### 29. 真实 opencode 拒载插件：legacy loader 遍历全部命名导出

- **现象**：插件在单测（56/56 绿）与 tsc 下完全正常，但真实 opencode 1.18.16 会话中 headroom_retrieve 工具不存在（TOOL_MISSING）；OPENCODE_LOG_LEVEL=DEBUG 后日志报 "Plugin export is not a function"。
- **根因**：三层叠加。①包缺 `main` 字段，file: 目标解析链落到「把包目录直接交给 Bun import」；②模块导出了 `const VERSION = "0.0.1"` 字符串；③尾部还挂着 14 个「Export internal functions for testing」命名导出。opencode 的 legacy 加载器 getLegacyPlugins 遍历模块的每一个运行时命名导出，要求每个值都是函数或带 .server 属性——字符串 VERSION 直接 throw，tool() 返回的定义对象（非函数）同样会炸。
- **解决思路**：opencode 插件的合法出口只有 default 导出的工厂函数；测试需要内部函数就改走子模块深路径 import，而不是污染入口模块的导出面。
- **解决方法**：package.json 加 `"main": "src/index.ts"`；删除 VERSION 导出与整个内部函数导出块，入口只留 default 工厂；smoke 测试改为断言 default 导出是 AsyncFunction（守护「入口导出面干净」这一约定本身）。
- **教训**：宿主的插件加载约定是隐式契约，单测环境（直接 import 模块）天然测不到它——集成面必须实机验证一次；「为测试而导出」是把测试便利泄漏进生产接口面的典型反模式。

### 30. headroom_retrieve 双缺陷：LLM 字符串数字 + found:false 守卫落空

- **现象**：实机会话中模型调用 headroom_retrieve 两连败：先是 limit 传字符串 "2" 被 zod 拒（Expected number, received string），模型转述成「必须传 64 位 hex hash」；修正传参后 query-only 调用又返回误导性的 "Unexpected result format"，而非正常的检索结果。
- **根因**：①严格 z.number() 不容忍 LLM 客户端把数字字符串化的常见姿势；②类型守卫 isHashResult 用 "content" in r 判别——但契约里 found:false 分支按构造就不携带 content 字段，miss 结果两个守卫都落空掉进 fallback；③单测 mock 写成了 {found:false, content:""}，多塞的 content 恰好让旧守卫蒙混过关——mock 与契约漂移把 bug 藏到了实机。
- **解决思路**：先直连 daemon 探针拿原始返回帧（{hits:[]} 正常），证明协议层完好、问题只在插件判别层，再动手改代码；mock 一律按契约字面构造。
- **解决方法**：limit 改 z.coerce.number().int().positive().default(5)；isHashResult 改判 "found" in r 并注释原因；not-found 测试 mock 改为契约忠实的 {found:false}（即守卫修复的回归测试）。复跑实机双探针：query-only → "No matches found"、hash miss → "No content found"，全通。
- **教训**：判别联合类型的运行时守卫要用判别字段本身（found/hits），不要用仅存在于部分成员的载荷字段；mock 数据多写一个「看起来无害」的字段就能让假阳性测试存活数个里程碑——mock 忠于 wire 契约是底线。

### 31. headroomd 「进程泄漏」误判：先读代码再定性

- **现象**：冒烟后清理时发现 5 个残留 headroomd 进程，疑似泄漏。
- **根因**：不是泄漏——server.ts 的 idleExitMs 默认 900_000（15 分钟宽限），born idle 即 arm timer，宽限未到进程自然还在；测试里看到的 "300ms exiting" 是显式传短超时的场景。
- **解决方法**：pkill 清理即可，无需改代码；分析结论纠正记录在案。
- **教训**：「看起来像缺陷」与「设计行为」之间隔着一层默认值配置——定性前先读实现里的默认参数，尤其是生命周期类逻辑。

### 32. rtk 实机静默失效：process.execPath 在编译版宿主里不是脚本解释器

- **现象**：实机会话中 read 4716 字节输出原样进模型——无压缩标记、无 metadata.bluecode，但 stderr 抓到真相：`[rtk-server] Error: Failed to change directory to .../src/bin.ts` → 握手失败 → 熔断器 OPEN → 永久 passthrough。单测 18/18 全绿。
- **根因**：RtkClient 用 `Bun.spawn([process.execPath, entry])` 拉起 server。execPath 只有在宿主本身就是 bun 运行时才是合法的 TS 解释器；真实 opencode 是编译版单文件可执行（内嵌 bun），其 execPath 是 opencode 二进制本身——`[opencode, bin.ts]` 直接报 "Failed to change directory"。而 HeadroomClient 用 `["bun","run",entry]` 从 PATH 找解释器所以幸存。两类组件 spawn 配方不一致，让缺陷只在其中一个身上显形。
- **解决思路**：先直接命令行复现 `[opencode二进制, bin.ts]` 得到一模一样的报错实锤根因，再把「解释器选择」收敛为一个可测的纯函数。
- **解决方法**：新增 bunSpawnArgv(entry, execPath)：basename 为 bun / bun-* 时沿用 execPath（真 bun 运行时），否则回退 PATH 的 `["bun","run",entry]`（编译宿主）；Windows 反斜杠路径一并处理。三态断言入 smoke 测试。复跑实机：read 输出 4716→1911 字节、metadata.bluecode.rawHash + strategy=read + compressed:true 全部到位。
- **教训**：「降级路径永不抛错」的设计让故障完全静默——熔断器日志是唯一线索，集成冒烟必须抓 stderr 而不只是看功能输出；`process.execPath` 的语义随宿主形态变化，凡是用它拼「运行另一个 TS 入口」的命令都要问一句：宿主一定是 bun 吗？

### 33. 非交互权限配置疑云：--auto 旗标绕过

- **现象**：给项目 opencode.json 加 `permission.read:"allow"` 后，非交互 `opencode run` 在 init 之后无限挂起（无网络连接、事件循环空转、无子进程）；去掉该块则恢复「无人批准即自动拒绝」的旧行为；改用 CLI `--auto` 旗标一切正常。
- **根因**：未深究（上游 opencode 1.18.16 非 TTY 权限路径的行为，与 BlueCode 组件无关）；相关性已三次复现，因果未验证。
- **解决方法**：smoke 场景统一用 `--auto` 旗标，permission 配置块从 smoke 配置移除。
- **教训**：集成冒烟遇到「挂起」时先做进程解剖（lsof/sample/pgrep -P）再定性；与宿主行为相关的怪象优先找官方旗标绕开，不恋战。

### 34. idle 链路五连错：SDK wire 形状与宿主事件信封的连环假设偏差

- **现象**：实机会话中 headroom 的 idle→压缩链路从未触发。BLUECODE_DEBUG=1 后逐门定位，五个静默 return 门各挡住一环：①事件里读不到 sessionID；②SDK 取消息返回空；③daemon 报 E_INVALID_PARAMS；④「no assistant token count」；⑤模型窗口解析三连败后落到默认值。
- **根因**：全部是对 wire 形状的假设偏差——①上游 opencode 的事件分发是 `hook["event"]({event:{id,type,properties}})`，载荷字段在 `properties` 下而非信封顶层；②hey-api 生成的 SDK 参数必须 `{path:{id},query:{limit}}` 嵌套，扁平键被静默忽略导致 404→ThrowOnError=false 时拿到空 data；③消息列表条目是 `{info,parts}` 包裹，且真实会话带 reasoning/step-start 等 part，映射成 tool:undefined 伪 part 被 daemon 拒收；④AssistantMessage.tokens 是组件形状 {input,output,reasoning,cache}，没有 total 字段；⑤Session 类型无 model 字段、model.get 方法不存在——模型信息只在最新 assistant 消息上。
- **解决思路**：不开断点也能逐门取证——给每个静默 return 门加 env 门控面包屑（BLUECODE_DEBUG），一轮实机跑完日志直接指出卡在哪扇门；每扇门的修法都先读上游源码/生成类型定义确认真实形状再动手。
- **解决方法**：①提取 eventToIdleInput 纯函数按 properties 解包 + 回归测试；②SDK 调用改嵌套参数；③sdkMessageToChatMessage 只投影 text/tool part；④tokens 优先 total、否则组件求和、全零时回退 estimateTokens 估算（免费档网关不报 usage）；⑤窗口解析改为从最新 assistant 消息取 providerID/modelID 再查 config.providers()。复跑实机：`compress done compacted=true refs=2` → cas_meta/chunks/histories 三表落库 → query 检索命中真实归档内容，全链路闭环；杀 daemon 后会话正常完成（client is closed 被捕获降级）。
- **教训**：单元 mock 与真实 wire 契约之间的距离就是集成缺陷的藏身之处——本条五连错每一个都能在单测绿光下存活到生产。「静默 return 门」是可观测性的头号敌人：与其争论要不要加日志，不如一开始就让每个早退分支都有 env 门控的出口理由；面包屑把实机调试从「猜测循环」变成「读日志」。

---

## 2026-08-24 · M7 最终验证与文档收尾

### 35. UTF-8 流式解码在分片边界截断多字节字符

- **现象**：headroomd UDS 连接在传输大块 JSON 时偶现乱码/解析失败；单测用单次 `chunk.toString("utf8")` 从未复现（测试数据恰好不跨字节边界）。
- **根因**：`socket.on("data")` 的 chunk 可能在多字节 UTF-8 序列中间截断；`Buffer.toString("utf8")` 会把不完整尾巴按替换字符渲染或抛错，后续拼接永不可逆。
- **解决思路**：Node `TextDecoder({stream:true})` 维护跨 chunk 状态机，不完整序列自动缓冲到下一片。
- **解决方法**：server.ts `attemptConnect` 与 client.ts `onData` 同步改用 `decoder.decode(chunk, {stream:true})`；保留 `createLineReconstructor` 做逐行切分。复跑 261 全量测试全绿，人工构造跨边界多字节帧验证解码完好。
- **教训**：流式协议里「一次性字符串化」是第 0 号坑；凡是 `socket.on("data")` 处理文本协议，默认动作即 TextDecoder stream 模式，除非明确知道不会跨边界（定长二进制除外）。

### 36. contentHash 跨会话碰撞：messageHashInput 缺失 `message.info.id`

- **现象**：对抗审查（academic-paper-reviewer）构造同字节不同会话消息，导致 contentHash 相同 → CAS 覆盖、历史归错档；单测无多会话并行场景。
- **根因**：`messageHashInput` 仅投影 `role + textParts + toolParts`，不含 `message.info.id`。同一用户在不同会话重复同样提问 → 逐字节相同 → 同一 contentHash → 写对象时第二次写入被 CAS 去重（幂等写入把新会话的归属账本覆盖为旧会话的）。
- **解决方法**：`turns.ts:83-99` `messageHashInput` 返回对象新增 `id: message.info.id`，规范投影含会话级唯一标识；contentHash 基于规范投影，天然把会话边界编码进地址。回归测试 `turns.test.ts` 新增跨会话同字节消息碰撞用例。
- **教训**：内容寻址的「内容」必须含上下文身份（会话 ID、轮次、角色等），否则不同上下文的同字节载荷会被错误合并。单测只覆盖单上下文时，这类碰撞零可见度。

### 37. CAS 重建时损坏对象静默通过 → 重建后索引带脏数据

- **现象**：`rebuildFromObjects` 从对象存储恢复索引时，若某对象文件损坏（截断/磁盘故障），`readMessageObject` 返回 null 被跳过，但后续若对象可读但 JSON 无效（如 UTF-8 截断残留），`JSON.parse` 抛错未捕获 → 整个重建事务回滚，索引留空。
- **根因**：重建循环只过滤 `null`（对象缺失），未校验「读出的对象能否安全 JSON 序列化」。
- **解决方法**：`db.ts:279-290` 新增二次校验——`JSON.stringify(r.message)` 强制序列化，失败则标记损坏并跳过（日志记录）。这把「损坏对象」从「炸毁重建」降级为「单条丢失、其余正常重建」。
- **教训**：CAS 的「地址即内容名字」保障的是写时完整性；读时若存储介质受损，必须显式二次校验并隔离，不能让单坏块拖垮全量恢复。

### 38. 原型链污染：TOOL_STRATEGY 无 hasOwnProperty 守卫

- **现象**：对抗审查构造 `tool="constructor"`/`toString`/`__proto__` 等 Object.prototype 属性名，`TOOL_STRATEGY[tool]` 命中原型链属性 → 返回 `"constructor" | "toString" | ...` 作为 StrategyName → 类型错误与错误分类。
- **根因**：`classify.ts:36` 直接 `TOOL_STRATEGY[tool]` 无自有属性守卫；攻击者可控制工具名字符串（如从用户输入或外部协议反射而来）。
- **解决方法**：改为 `Object.prototype.hasOwnProperty.call(TOOL_STRATEGY, tool)`；TS 类型收窄需显式 `as StrategyName` 断言（已验证安全）。
- **教训**：凡是「外部可控键 → 内部 Map/Record 取值」的路径，必须用 `hasOwnProperty.call` 或 `Object.hasOwn` 守卫；TypeScript 结构化类型无法自动推导该运行时约束。

### 39. diff 统计与发射逻辑不对称：`---/+++` 处理分歧

- **现象**：diff 策略的头部统计行 `+A/−D` 与实际保留的 hunk 体内 +/- 计数不一致；单测只验证「不炸」而非「数字准确」。
- **根因**：`collectStats`（预扫统计）在遇到 `--- ` 行时无条件 `continue`，把文件头计入非 hunk 区；但发射遍历只在 `inHunk===false` 且 `+++ ` 时才翻转文件边界。遇到只有 `--- a/file` 无后续 `+++ b/file` 的异常 diff（如 `/dev/null` 删除文件），统计把后续 +/- 归入上一文件或 other 组，发射却按当前 file 计数。
- **解决方法**：`diff.ts:41-50` 让 `collectStats` 完全镜像发射遍历的边界判定——只有 `inHunk===false && /^\+\+\+ /` 才翻文件、`--- ` 直接跳过且不翻边界。双方逻辑对齐后统计与发射逐行一致。
- **教训**：两遍扫描（预统计 + 正式发射）的边界条件**必须字面对齐**；单测应包含「只有 --- 无 +++」等异常 diff 样本，而非只喂标准 git diff。

### 40. 插件双 HeadroomClient 单例：retrieve-tool 与 headroom.ts 各持实例

- **现象**：`retrieve-tool.ts` 与 `headroom.ts` 各有一个模块级 `headroomClient`；插件工厂只 `setHeadroomClient` 给 retrieve-tool，headroom 内部 `getHeadroomClient` 再次尝试连接/拉起 → 可能产生两个连接、竞态、资源泄漏；单测 mock 只覆盖 retrieve-tool 侧，headroom 侧用真连接。
- **根因**：两模块独立演化，均未统一到「插件工厂负责唯一初始化、其余模块只消费共享实例」的契约。
- **解决方法**：
  1. `headroom.ts` 新增 `setSharedHeadroomClient`/`getSharedHeadroomClient`/`isHeadroomDegraded`/`setHeadroomDegraded` 导出，内部 `getHeadroomClient` 简化为只读共享实例。
  2. `retrieve-tool.ts` 删模块级变量与 `setHeadroomClient`，改 `import {getSharedHeadroomClient} from "./headroom"` 并在 execute 里取用。
  3. `index.ts` 工厂里 `setSharedHeadroomClient(headroomClientInstance)`、`dispose` 里 `setSharedHeadroomClient(null)`。
  4. 测试 `headroom.test.ts` / `retrieve-tool.test.ts` 同步改用 `setSharedHeadroomClient`。
- **教训**：跨模块共享有状态单例时，「谁拥有初始化权、谁负责清理」必须成文为显式 API（set/get/is），且所有消费侧只能通过 getter 拿实例——模块级私有变量是隐性耦合的温床。

### 41. bun spawn 配方回退 PATH 导致测试环境找不到 bun

- **现象**：`bunSpawnArgv` 回退 `["bun","run",entry]` 在测试环境（PATH 不含 `~/.bun/bin`）报 `ENOENT: Executable not found`；但真实宿主（opencode 内嵌 bun）PATH 里有 bun。
- **根因**：`bunSpawnArgv` 原设计「非 bun 宿主回退 PATH bun」假设 PATH 含 bun；CI/测试环境只通过 `~/.bun/bin/bun` 显式调用，PATH 里没有。
- **解决方法**：在 headroomd/client.ts 与 rtk/client.ts 的 spawn 调用处，显式传 `process.execPath`（当前运行的 bun 二进制路径），而非依赖 PATH 查找。保留 `bunSpawnArgv` 的三态逻辑供编译版宿主（opencode 等）使用。
- **教训**：子进程 spawn 的解释器解析要么用绝对路径、要么显式传运行时路径；依赖 PATH 是「本机能跑」的幻觉，在隔离环境（CI/容器/测试 runner）必现。

### 42. eval 基线随修复自然漂移：需显式更新而非忽略门禁

- **现象**：修复 UTF-8/哈希/原型链/diff 统计等缺陷后，压缩率、召回、延迟指标随之变化；`check-baseline` 报 10+ 项违规（compressionRatio +10pp、mustHitRecall -25%、latencyP95 3-5x）。
- **根因**：修复改变了真实行为（如 diff 统计准确化、原型链守卫去误判、UTF-8 不再丢字符），基线反映的是修复前的「含 bug 行为」，非预期目标。
- **解决方法**：跑 `bun run eval --update-baseline` 冻结新基线；check-baseline 测试组内部的受控场景（基线 0.5/1.0/100）依然全绿，证明门禁逻辑本身无误。
- **教训**：基线是「当前可接受行为」的快照，而非「理想目标」——每次行为变更（无论是修复还是优化）都要显式 `update-baseline` 并审查 diff，确认变化在预期内；「忽略门禁」等于把质量红线当装饰。

---

## 2026-08-24 · 发布前全维审计与加固

### 43. 五维审计 38 项确认问题的一次性清偿

- **现象**：v1.0 推送后做发布前系统审计（正确性 / 健壮性 / 安全 / 测试缺口 / 文档一致性五维并行 + 对抗验证），38 项确认问题横跨全部七个包——其中四项 HIGH：①apply-plan 幂等守卫过宽，二次压缩被永久拒绝；②rtk 原文不可经 headroom_retrieve 取回（文档承诺落空）；③共享 tmpdir 跨账号可挂载他方 daemon socket；④headroomd 启动自愈遇损坏 CAS 对象会崩溃循环。
- **根因**：共性有三。①守卫用「首元素」代表「全体」（apply-plan 只看第一条 located 消息）；②两个 sidecar 的存储互不知晓对方寻址空间，而桥接承诺写在工具层却无人实现；③「能跑」路径从未在对抗输入下压测（损坏对象、超限帧、跨账号挂载、boot 失败孤儿进程）。
- **解决思路**：按包分治——四个包级修复代理各持文件权并行作业（rtk/rtk-core、headroomd、plugin、eval），基础原语先行收敛进 shared（bunSpawnArgv、defaultSidecarDataDir、FrameOverflowError、redactLocalPaths）；桥接明确落在插件工具层而非协议层，两个 daemon 保持互不知晓。
- **解决方法**：守卫窄化为 every(isCompactionReplacement)；sha256: 前缀哈希在 retrieve-tool 直路由 rtk.fetch；dataDir 改 uid/XDG 命名空间 + dir 0o700 + socket 0o600；rebuildFromObjects try/catch 跳过损坏对象并记 skipped；index.db 加 rebuild_state(expected_chunks) 让自愈一轮收敛；boot 失败统一 settled-guarded fail()（SIGTERM + stderr 持续 drain + unref）；握手改字节级分帧（Bun 会静默丢弃 unshift 回灌的字节，改为 pending 缓冲同步回喂）；late-reply 环形缓冲让三次纯超时不再误杀健康子进程；retrieve limit 三层 clamp（contracts .max(50) → 插件截断 → engine Math.min）；模型可见错误经 redactLocalPaths 脱敏；zod 统一 v4。测试 261→298，基线重冻结后门禁全绿。
- **教训**：审计的价值密度集中在「不变量被局部推理破坏」处（守卫、水位、幂等）与「承诺无实现」处（检索桥接）——后者只有拿文档逐条对质才会现形。多代理按包分治的关键是先冻结共享接口（contracts/shared 先行提交），让并行修复不互相踩踏；而「对抗验证」环节驳回了 2/40 的候选发现，避免了对幻影问题的无效返工。
