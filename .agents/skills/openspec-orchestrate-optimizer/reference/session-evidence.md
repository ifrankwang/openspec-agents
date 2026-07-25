# Session 证据

主代理有 sessionID 时，分派一个 `general` 子代理完成 session 导出与事件提取，返回结构化事件时间线。

## 子代理执行步骤

### 1. 导出 session

执行 `scripts/export-session.sh <sessionID>`：

- 依赖 `jq`（macOS 预装）和 `opencode` CLI
- 递归深度上限 5 层，主 session 和子 session 合并到同一 JSON
- 输出两个文件：精简 JSON（默认删除 tool output 和 reasoning text）+ `<output>.summary.jsonl` 摘要文件
- 需保留 tool output 作为状态转移证据时设 `KEEP_TOOL_OUTPUT=1`
- 导出声失败向主代理报告错误信息

### 2. 读取与提取

估算 JSON 大小（`wc -c`）：

- ≤ 30KB → 全文读取
- > 30KB → 先读摘要文件，按 session 边界制定分段策略再分段读取

从各消息中提取关键事件，输出结构化时间线：

```
[msg_idx] | session(前20字符) | agent | event_type | tool_name | key_params(≤80字符)
```

一个子代理无法全文读完时，分派多个 `general` 子代理并行读取不同段，主代理合并时间线。

### 3. 返回给主代理

- 结构化事件时间线（纯文本，非原始 JSON）
- 导出文件路径（主代理后续比对使用）

## 比对使用

主代理将事件时间线与当前代码、agent 定义、skill 定义、治理原则比对，识别偏差点进入根因分析或差距分析。
