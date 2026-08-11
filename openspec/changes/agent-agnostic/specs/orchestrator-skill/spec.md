## ADDED Requirements

### Requirement: 编排视角角色判定

内核 SHALL 以「编排视角」角色字段替代硬编码 agent 名字符串（openspec-orchestrator）做权限校验（assertOrchestrator）与视图路由，13 处 ORCHESTRATOR_AGENT 引用全部收敛。

#### Scenario: 主代理以编排视角操作

任意 agent 的主代理以编排视角调用 opx_agent_submit 提交任务时，独占工具校验与状态视图路由与旧 openspec-orchestrator 行为一致，无 agent 名依赖。

### Requirement: 编排主代理 skill

SHALL 新建 orchestrator skill，承载编排者身份定位、行为准则、禁止事项、分派范式与无人值守行为约定；frontmatter 声明 capabilities，MUST NOT 包含具体阶段流转与工具内部实现，供各 agent 主代理加载。

#### Scenario: claude code 主代理加载 skill

claude code 主代理注入 orchestrator skill 后，按 skill 定义执行分派范式与行为准则，替代原 openspec-orchestrator.md 的角色语义。

### Requirement: 独立编排者角色移除

openspec-orchestrator SHALL NOT 再作为独立 agent 角色注册；其 frontmatter（mode/permission）迁移至各适配器主代理注入定义，动态流转决策仍由 opx_status 权威产出。

#### Scenario: 无 orchestrator 代理列表

各 agent 的注入定义中不再包含 openspec-orchestrator 代理条目，编排流程由主代理承载全部编排者职责。
