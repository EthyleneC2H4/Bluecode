# @bluecode/security-core

离线安全分析与脱敏的纯函数边界。此学习实现不等于 vivo 私有 VSecAgent。

- `evaluateTool(params)`：八类规则，输出仅含安全元数据的 allow/warn/deny/unavailable。
- `sanitizeFields(params)`：按凭据跨度替换，保留换行和相邻要求；幂等；失败时明确隐藏内容。
- `defaultSecurityPolicy()`：默认策略，例外为空。
- `@bluecode/security-core/sanitize`：轻量脱敏入口，不导入 TypeScript 或 Bash 解析器。

规则包括凭据、危险命令、敏感文件、项目边界逃逸、动态执行、SQL 注入、XSS 和弱密码学。
JS/TS/JSX/TSX 使用 TypeScript 5.9.3 AST；Shell 使用 web-tree-sitter 0.25.10
和 tree-sitter-bash 0.25.0 的本地 WASM。唯一文件读取是解析器初始化加载这两个固定资产；
不读取待分析项目、不执行代码、不联网。

路径必须由调用方经 realpath 或最近存在父目录规范化后传入 `resolvedPath`。
核心仅验证该规范化证据的路径边界，不声称能从纯字符串识别符号链接。
edit/apply_patch 的新旧内容由适配层生成；已有命中降级为警告，新增的高置信 critical 命中拒绝。
候选文件存在时，旧 edit 字符串和原始 patch 不会被二次认定为新增凭据。
例外需要规则、路径子树或 `tool:<name>` 范围、原因和未来到期时间；例外不能跳过脱敏。

文本字段上限 1 MiB UTF-8，总输入上限 8 MiB，结构深度及数量有界。未知工具、
不完整文件、错误语法、不支持的可执行语言、动态 Shell 展开和递归深度以 partial 报告。
Shell 可遍历链、管道、重定向、常见包装命令和两层字面量 shell -c。
规则是语法检查，不做跨函数污点跟踪、模块解析或凭据在线验证。
不覆盖混淆/编码后才还原的凭据、跨文件别名、动态生成的命令和宿主沙箱隔离。
`complete` 表示受支持输入的扫描完成，不是安全证明。

开发集包含每类 10 风险 + 10 正常输入，并附带边界回归测试。独立保留集、宿主集成、
进程终止、缓存、队列和固定机器性能验收属于后续集成任务，不能由此开发集替代。
