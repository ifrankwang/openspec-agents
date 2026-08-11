## ADDED Requirements

### Requirement: 内核 Provider 抽象接口

内核 SHALL 提供 agent 无关的 Provider 接口：工具注册（参数采用纯 JSON Schema）、context 注入、agent/skill 注入、用户交互回调、可选 dashboard。各 agent 适配层实现该接口接入同一套编排状态机。

#### Scenario: 新 agent 接入

为 zcode 新增适配器时，实现 IRuntimeProvider（注册 6 个 opx_* 工具的 JSON Schema 与回调），无需修改内核状态机即可接入编排流程。

### Requirement: 纯 JSON Schema 工具定义

6 个 opx_* 工具的参数 schema SHALL 以纯 JSON Schema 定义（含嵌套 object/array 校验），OpenCode 链式 schema 仅作为适配层的转换目标，工具定义本身 MUST NOT 依赖任何 agent 专有 API。

#### Scenario: 跨 agent 工具一致性

claude code 与 opencode 通过各自 MCP/插件机制暴露同一份 JSON Schema，同一参数校验行为在两个 agent 下完全一致。

### Requirement: npm 多子导出与运行时兼容

包主入口 SHALL 导出 agent 无关内核，./opencode ./claude-code ./codex ./zcode ./mcp ./provider 为子导出；生产代码 MUST NOT 依赖 Bun 专属 API，MUST 可在 Node 运行时运行。

#### Scenario: Node 环境运行

在纯 Node 环境安装包并启动 MCP server（HTTP transport），工具可被任意 MCP client 发现与调用，无 Bun 运行时依赖报错。
