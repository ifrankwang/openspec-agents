# Session 证据

导出编排会话数据用于精确定位根因或验证行为偏差点。

## 导出

```bash
scripts/export-session.sh <sessionID> [depth]
```

输出精简 JSON（默认删除 tool output 和 reasoning text）。设置 `KEEP_TOOL_OUTPUT=1` 保留 tool 返回值。同目录生成 `.summary.jsonl` 摘要文件。

递归深度上限 5 层，主 session 和子 session 合并到同一 JSON。

依赖 `jq`（macOS 预装）和 `opencode` CLI。

## 事件提取

分派子代理读取 JSON。≤ 30KB 全文读取；> 30KB 先读摘要文件分段。返回结构化时间线：

```
[msg_idx] | session(前20字符) | agent | event_type | tool_name | key_params(≤80字符)
```

## 比对使用

将 session 行为与当前代码、agent 定义、skill 定义、治理原则比对，识别偏差点。偏差点进入根因分析或差距分析。
