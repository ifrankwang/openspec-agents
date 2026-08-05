## ADDED Requirements

### Requirement: 视图按 workflow 动态渲染
`opx_status` SHALL 按调用者角色与当前 WorkItem 的 workflow/step 动态渲染推荐、skill 加载建议与验证类别清单，不硬编码 agent 名；skill 引用 SHALL 通过 capability tag 语义匹配解析。

#### Scenario: 动态渲染推荐 agent
- **WHEN** 不同角色在相同 workflow 的不同 step 查询 opx_status
- **THEN** 视图按各自 step 推荐对应 agent 与能力类别，且不出现硬编码 agent 名的流程描述

#### Scenario: 无匹配 skill 优雅降级
- **WHEN** 某 step 的 capability_tags 无匹配 skill
- **THEN** 视图仍正常渲染，并提示该能力无对应 skill 加载

### Requirement: 检查点呈现
当 WorkItem 处于重试检查点时，`opx_status` SHALL 呈现检查点状态，并给出 continue / giveup 的决策入口提示。

#### Scenario: 检查点可见
- **WHEN** 某 WorkItem 的 metadata._checkpoint 为 true
- **THEN** opx_status 视图呈现检查点状态与 continue/giveup 决策选项

### Requirement: 操作指引按角色阶段渲染
`opx_status` SHALL 按调用者角色与当前阶段渲染操作步骤指引，操作步骤与技能清单为动态上下文，不含具体实施细节。

#### Scenario: 角色对应的操作步骤
- **WHEN** 某角色在特定 phase 调用 opx_status
- **THEN** 视图返回该角色在该阶段可执行的操作步骤与验证类别清单
