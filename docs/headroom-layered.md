# headroom 分层上下文管理

本实现保留 OpenCode 插件、RTK 子进程与 headroomd 守护进程。RTK 负责刚返回的工具输出，headroom 负责较早历史的保存方式。`layered` 使用本地规则，开发和默认 CI 无需 LLM；语义摘要是独立、默认关闭的增强服务。

## 开启与回退

```jsonc
{
  "plugin": [["file:///absolute/path/to/Bluecode/packages/plugin", {
    "headroom": {
      "strategy": "layered",
      "triggerRatio": 0.7,
      "targetRatio": 0.55,
      "retainRecentTurns": 4,
      "memoryMaxTokens": 4096,
      "memoryRatio": 0.15,
      "summarizer": { "enabled": false }
    }
  }]]
}
```

`off/shadow/on` 保持兼容。验收结果未满足默认切换条件前，默认策略仍为 `legacy`；显式设置 `layered` 即使用新算法。回退只需改回 `legacy` 并重启宿主；原始归档继续可读取。

wire 协议升级到 v3，旧 daemon 和新插件不能混接。遇到协议或摘要服务配置不一致，先结束相应 daemon 后重启；客户端不会擅自终止未知进程。首次验证应使用单独 `dataDir`，正常数据路径仍是 `storage-v2/headroom`，增量表升级不改变原文哈希。

## 历史怎样缩小

较早且完成的工具结果会被原文确认后替换为来源标记和简短观察记录。用户需求、修正和含义不明确的代码保持原文；只有明确标注为材料的文本范围可以外置。近期四个完整轮次与当前活动轮次受保护。相同工具参数但输出不同的结果保留版本区分；失败诊断不能仅按年龄或一条无关“通过”记录消失。

任务状态事件保存在带来源摘要的不可变叶子节点中。叶子覆盖至多8192估算token材料，文本目标512；上层节点引用四个子节点，文本目标1024。重新规划读取活动图所需节点，不把全部旧摘要重新拼回模型输入。分析缓存与token缓存有界，快照验证仍为线性扫描。

扣除系统与输出预留后的可用输入为 B，保护内容 P，近期原文 R，包装 O。历史可见记忆预算为：

```text
M = min(4096, memoryMaxTokens, floor(B × memoryRatio),
        max(0, min(targetTokens, floor(B × 0.55)) − P − R − O))
```

层内先保留未解决事项、修改与验证，再选择相关历史。完整块放不下就只保留归档入口；不会截断用户要求来伪造达标。返回的 `budget.reasons` 说明保护内容过多、无正收益或未达到目标等原因。

规则计划包括互不重叠的 `range/tool-output/text-range` 操作、源ID/摘要、快照和epoch。宿主一次校验所有操作，再应用到新建的消息数组，未知原生字段继续保留。归档保存先于计划发布；上游 compaction、源编辑和删除触发失效。

## 原文恢复

`headroom_retrieve` 保留 `hash/historyHash/query`，新增 `nodeId`：

```text
headroom_retrieve(query="src/auth.ts validation", maxTokens=2048)
headroom_retrieve(nodeId="<64hex>", detail="summary")
headroom_retrieve(nodeId="<64hex>", detail="children", depth=2)
headroom_retrieve(nodeId="<64hex>", detail="source", cursor="<nextCursor>")
```

搜索首包包含至多5个命中卡片、匹配片段、文件路径、标识符、来源和节点入口，不自动展开所有分页。节点与历史游标保存遍历位置，并用namespace隔离。默认2048token与32KiB字节预算；最终JSON包装也参与工具返回限额。hash恢复是完整原文分页，query首命中不能保证选中问题未明确指定的旧版本。

运行时默认 `ceil(UTF-16字符数/4)` 估算；daemon可注入 `TokenCounter`，并标记 estimated/tokenizer。provider输入、输出和缓存usage由实机单独记录，不能把离线估算当账单。

## 可选后台摘要

```jsonc
{
  "headroom": {
    "strategy": "layered",
    "summarizer": {
      "enabled": true,
      "baseURL": "https://your-provider.example/v1",
      "model": "explicit-model-id",
      "apiKeyEnv": "HEADROOM_SUMMARY_API_KEY",
      "timeoutMs": 10000,
      "maxInputTokens": 8192,
      "maxOutputTokens": 1024,
      "sessionInputTokens": 32768,
      "sessionOutputTokens": 4096
    }
  }
}
```

只配置环境变量名，密钥由启动环境提供。模型、端点和额度必须与已启动daemon一致；不一致时保留规则计划并提示重启，不向另一服务静默发送材料。

规则路径先返回；只有历史记忆仍有预算压力、且存在可缩短的可选节点时才提交摘要。单会话一个在途任务，全daemon两个；输入包含提示词和JSON包装。预约额度先持久化，provider实际usage已知时对账，未知时保留预约；重启不会重置消费。网络等待不占规则串行队列或数据库写锁。

输出必须是带合法sourceIds的条目，不能输出用户约束、覆盖失败证据或扩大可见内容。结果通过 `getCandidate` 取回，宿主再次验证最新来源后才 `setView`。超时、来源错误、输出膨胀、源历史失效继续使用规则视图。引用校验只证明可追溯，不能证明摘要语义正确。

OpenCode Zen 免费模型要求真实 OpenCode 会话；普通兼容HTTP摘要适配器可能收到 `MissingSessionID`。本实现不会伪造宿主身份。主任务可通过实际OpenCode使用免费模型；后台摘要失败应记录并回退，不能称为“增强已验证有效”。

## 验证入口

```sh
bun run verify
bun run eval:headroom --output packages/eval/headroom-layered-results.json
# 实机默认不进入CI；所有调用由明确的免费模型白名单和总预算约束。
bun run eval:live --model opencode/mimo-v2.5-free \
  --api-key-env OPENCODE_ZEN_API_KEY --max-requests 720 \
  --max-input-tokens 80000000 --max-output-tokens 1474560 --concurrency 4 \
  --output packages/eval/headroom-live-results.json
```

专用离线矩阵覆盖8类×50/200/1000轮，调用生产runtime和daemon；逐组报告超时、累计输入、恢复、缓存前缀、CPU/RSS和队列。实机入口导入14轮确定性材料，执行12个可验证的小任务×3策略×2重复。导入材料是测试fixture，后续任务才由实际模型完成。短会话、无法压缩、旧版超时、检索版本选择失败分别列出，不合并为平均收益承诺。

实机输入额度按完整 UTF-8 请求字节加包装余量保守预约，输出按请求上限预约；预约量与 provider 实际输入／输出／缓存 usage 分列，未知值为 `null`。测试修复要求修复后的测试在正确实现上通过、对应错误实现上失败；其他任务还检查原验证器未被修改。实测结论与适用范围见 [验收记录](headroom-layered-acceptance.md)。

本文件及实现由AI辅助编写；实验数字以提交的机器可读结果和验收报告为准。
