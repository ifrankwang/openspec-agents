## ADDED Requirements

### Requirement: 通用 MCP Server 承载工具

6 个 opx_* 工具 SHALL 由 agent 无关的通用 MCP Server（HTTP transport）承载，参数采用纯 JSON Schema，任意支持 MCP client 的 agent 均可发现与调用。

#### Scenario: MCP client 发现工具

claude code 配置 .mcp.json 指向 server 后，工具列表中出现 6 个 opx_* 工具，参数由 JSON Schema 驱动校验。

### Requirement: 单一 MCP 实现通吃多 agent

OpenCode 适配器 SHALL 也切换为 MCP client 形态（保留插件壳兼容入口），MUST NOT 与各 agent 的 MCP 支持情况绑定。

#### Scenario: 多 agent 同服务器

opencode 与 codex 同时连接同一 MCP server，各自按原生配置分发方式注册，服务器端无 agent 专属分支。
