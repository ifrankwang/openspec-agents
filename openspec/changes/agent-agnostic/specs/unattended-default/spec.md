## ADDED Requirements

### Requirement: 非 OpenCode agent 默认无人值守

claude code / codex / zcode 适配器初始化会话时 SHALL 自动开启 unattended（state.unattended = true），agent 自行决策、不向用户提问；MUST NOT 引入 workflow 配置按 agent 特化机制。

#### Scenario: claude code 首轮编排

用户在 claude code 发起编排，会话初始化即处于无人值守，检查点与门禁裁决由主代理依据 skill 行为准则自行执行，全程无提问。

### Requirement: 无人值守不抑制检查点决策

无人值守 SHALL 仅影响 analyze 确认模式视图渲染与 agent 行为准则，MUST NOT 抑制检查点决策——检查点决策是 opx_agent_submit 工具调用，主代理可自行执行，不依赖提问；tools.ts 中 unattended 工具描述 SHALL 与实现保持一致。

#### Scenario: 检查点照常提交

无人值守会话中，各层完成审查后由主代理调用 opx_agent_submit 推进检查点，状态机流转与有人值守一致。
