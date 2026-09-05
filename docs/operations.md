# 安装、升级与恢复

使用 Bun **1.4.0** 与锁定依赖：

```sh
bun install --frozen-lockfile
bun run verify
bun run eval --check --skip-latency
```

`verify` 包含全包 strict typecheck、全部测试、包依赖方向与宿主 bundle 的 SQLite 边界检查。Linux/macOS CI 配置分别执行这些命令；本次本地验收平台与实际命令见 [验收记录](reliability-implementation.md)。

## 插件配置

在 OpenCode 配置中使用当前 checkout 的绝对路径：

```json
{
  "plugin": [["file:///absolute/path/Bluecode/packages/plugin/src/index.ts", {
    "mode": "on",
    "rtk": {"budgetTokens": 512, "timeoutMs": 40, "minBytes": 512},
    "headroom": {"triggerRatio": 0.7, "targetRatio": 0.55, "retainRecentTurns": 4}
  }]]
}
```

`off` 不启动组件；`shadow` 计算与记录结果、保持模型可见内容；`on` 应用优化。`rtk.mode` / `headroom.mode` 可分别覆盖；全局 off/shadow 优先。首次接入可使用 shadow 检查诊断后切 on，直接配置 on 也是支持的默认路径。`enabled:false` 保留兼容关闭行为。[配置 schema](../packages/plugin/src/config.ts)。

每个工厂拥有独立客户端和会话状态。headroomd 共享同一根时采用一个 writer，RTK 子进程之间使用共享 ledger 仲裁。项目 ID 使用宿主 `project.id`，缺失时对 worktree 路径求 digest。工厂不会修改 `process.env.BLUECODE_DATA_DIR`。`rtk.entry/headroom.entry`、`sidecarDir` 和只读环境覆盖由每次配置独立解析。

## 路径和限额

macOS 默认 `~/Library/Application Support/bluecode`；Linux 默认 `$XDG_DATA_HOME/bluecode` 或 `~/.local/share/bluecode`。显式 `dataDir` 覆盖默认。新根下有 `storage-v2/rtk`、`storage-v2/headroom`；socket 位于用户私有 runtime 目录，与持久对象分离。[路径实现](../packages/shared/src/paths.ts)。

插件 `maxStorageBytes` 默认 1GiB，两个组件各获得一半 allowance。RTK 计量 canonical payload 与持久 reservation，headroom 计量文件并保守预留数据库开销；SQLite 额外开销意味着这不是文件系统硬限额。容量不足停止新归档，已有引用仍可读取。不要删除 meta ledger 或 CAS 来腾空间；它们保存归属和原始证据。

```sh
bun run gc --dataDir /absolute/path/to/data
```

GC 只删除超过24小时的 `.tmp-` 发布文件，不删除以内容 hash 命名的对象。RTK 在独占发布锁内恢复 pending reservation：缺少对象时回收，已发布对象仍计量，绝不按超时时间猜测另一 writer 是否仍在工作。[GC](../scripts/gc-storage.ts)、[配额恢复](../packages/rtk/src/ownership.ts)。

## v1 → v2 离线迁移

先停用插件并停止对应 sidecar。根据实际 OpenCode project ID 明确归属；旧插件通常使用 `default`，多个项目混用同一旧归属时，应先核对归属，不能自动猜测映射。

```sh
bun run migrate --offline \
  --legacyDataDir /absolute/path/to/old-data \
  --dataDir /absolute/path/to/new-data \
  --projectId ACTUAL_OPENCODE_PROJECT_ID \
  --legacyProject default
```

`--component rtk|headroom|both` 可单独迁移。CLI 默认将 allowance 分半用于 both。RTK 将旧 session grants 映射到指定项目；headroom 将指定旧 project 映射到实际 ID。helper 也支持显式多项 `projectMappings`。仅在副本上更新归属；源目录保留，旧引用地址不变。[RTK 迁移](../packages/rtk/src/migration.ts)、[headroom 迁移](../packages/headroomd/src/migration.ts)。

迁移顺序：排他迁移标记 → 副本/引用对象验证 → 归属映射 → 派生索引构建 → 关闭并核对最终限额 → rename。目标已经初始化时拒绝覆盖，不自动合并；可选一个空的新 dataDir 完成迁移后再更新插件配置。两组件分别切换，某组件失败时已完成部分会保留，修复问题后按 component 重试。没有自动运行或修改你的旧数据。

重复迁移必须匹配 marker 中记录的来源绝对路径和规范化项目映射；相同请求幂等，不同来源/项目明确拒绝。旧 marker 如果没有身份记录也拒绝自动承认，需核对后选择新目标。只读 legacy reader 可恢复 hash/history；旧全文查询需要迁移后重建 v2 索引。读取旧数据仍必须提供正确 namespace，不能绕过隔离。

## 故障恢复

- **RTK 超时/过载**：当前调用保持原文。40ms 包含队列时间；高并发下旁路是预期的保护行为，具体降级数据单独记录。持续无响应的 generation 会被退休并重启。
- **headroom 连接失败**：保持宿主可见历史；后续事件可触发带30秒冷却的重连。模型窗口未知时暂停自动压缩。
- **派生 index.db 损坏/分片缺失**：下次启动由经校验对象、ledger 和 manifest 重建。坏 SQLite 会隔离保留用于诊断。操作前停止 daemon。
- **CAS 损坏/丢失**：hash 读取报错，history 返回 partial 和缺失 hashes；不要把 partial 当完整恢复。修复应来自可信备份/源数据，系统不会伪造内容。
- **meta.db 损坏**：停止归档并保留宿主内容，需从可信备份恢复；派生索引不能替代归属 ledger。
- **writer lock**：不同 socket 也只能有一个进程写同一持久根。SQLite 独占 lease 在进程退出后自动释放，不需要凭 PID 猜测或随意删除活锁。
- **并发冷启动**：同 socket 的 headroomd 败者在2秒内探测获胜实例；不同 socket 指向同根时明确拒绝。只有明确的 SQLite busy/locked 才进入仲裁，损坏数据库不被伪装为已有实例。
- **query cursor 失效**：重新发原查询；hash/history 的不可变来源分页可继续。

验证实验使用冻结的本地合成数据与确定性回答检查，不等同于真实模型任务准确率或 provider 账单。默认 redactor 是 identity；敏感内容策略由既有 redaction 接口承载。[测量说明](reliability-implementation.md)。
