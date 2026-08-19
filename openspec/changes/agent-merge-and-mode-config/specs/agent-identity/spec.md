## Purpose

定义物理 agent 合并后的逻辑身份模型：9 种逻辑身份经 _agent 参数承载的语义、身份自述的软约束与文档标注的安全边界，以及 simple 审查者上报 issue 的显式维度归属与名下待复核、待批准清单的可见性。

## ADDED Requirements

### Requirement: 逻辑身份经 _agent 参数承载

系统 SHALL 通过 _agent 参数承载全部逻辑身份，包括 architect、reviewer-tool、reviewer-task、各质量维度审查者与 simple 审查者；逻辑身份 SHALL 用于状态视图路由、issue 的来源与筛选、issue 裁定归属以及状态标识；各 harness 以 _agent 参数传递逻辑身份的行为 SHALL 一致。

#### Scenario: 按逻辑身份路由状态视图
- **WHEN** 调用者以 _agent 参数声明某逻辑身份查询状态
- **THEN** 系统按该逻辑身份返回对应的视图内容

#### Scenario: 多逻辑身份并行审查
- **WHEN** full 模式的质量审查以多个逻辑身份并行执行
- **THEN** 同一物理审查者可被多次分派，每次以不同的 _agent 参数承载

#### Scenario: 各 harness 行为一致
- **WHEN** 任一支持的 harness 以 _agent 参数传递逻辑身份
- **THEN** 系统以相同方式识别并处理该身份

### Requirement: 身份自述软约束与安全边界

系统 SHALL 不硬校验 _agent 身份的真实性，仅信任调用者自述的身份；相关文档 SHALL 标注身份自述、无硬校验的安全边界。

#### Scenario: 自述身份被接受
- **WHEN** 调用者以自述的 _agent 身份调用系统
- **THEN** 系统按自述身份处理，不进行真实性校验

#### Scenario: 安全边界写入文档
- **WHEN** 用户查阅身份语义相关文档
- **THEN** 文档明确标注身份为自述、无硬校验

### Requirement: simple 审查者 issue 显式声明 dimension

simple 审查者上报 issue 时 SHALL 显式声明归因维度；未声明维度的 issue 上报 SHALL 被拒绝；已声明的 issue SHALL 归入质量层，按报源身份裁定（谁提谁裁定）。

#### Scenario: 显式声明维度并归入质量层
- **WHEN** simple 审查者上报显式声明归因维度的 issue
- **THEN** 该 issue 归入质量层，由上报方（按 _agent 身份）裁定其豁免与复核

#### Scenario: 未声明维度被拒绝
- **WHEN** simple 审查者上报未显式声明归因维度的 issue
- **THEN** 上报被拒绝，并提示必须声明归因维度

### Requirement: simple 审查者名下清单可见

simple 审查者 SHALL 能通过状态查询看到自己名下的待复核与待批准 issue 清单。

#### Scenario: 查看名下待办清单
- **WHEN** simple 审查者查询状态
- **THEN** 返回其名下的待复核与待批准 issue 清单

#### Scenario: 非名下 issue 不出现在清单
- **WHEN** simple 审查者查询状态且存在其他身份名下的待复核或待批准 issue
- **THEN** 这些 issue 不出现在该审查者的清单中
