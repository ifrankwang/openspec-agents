## Purpose

定义 workflow 配置中 mode 字段（full / simple）的语义：模式在变更开始时固化、进行中不受配置改动影响，以及 simple 模式三步流程（implement → quality_review → done）下提交、审查、收尾各环节的可观察行为契约。

## ADDED Requirements

### Requirement: 模式配置与缺省值

系统 SHALL 支持通过 workflow 配置的 mode 字段选择 full 或 simple 两种流程形态；mode 未配置时 SHALL 按 full 处理。

#### Scenario: 未配置模式按 full 执行
- **WHEN** 变更开始时 workflow 配置未声明 mode
- **THEN** 该变更按 full 流程执行

#### Scenario: 配置 simple 模式
- **WHEN** 变更开始时 workflow 配置声明 mode 为 simple
- **THEN** 该变更按 simple 三步流程执行

### Requirement: 模式在变更开始时固化

系统 SHALL 在变更开始时读取 workflow 配置并将模式固化存档；已开始的变更 SHALL 不受后续配置改动影响；无模式存档的旧变更 SHALL 按 full 处理；恢复（recovery）中的变更 SHALL 沿用固化模式。

#### Scenario: 配置改动不影响进行中的变更
- **WHEN** 变更已开始后 workflow 配置的 mode 被修改
- **THEN** 已开始的变更仍按开始时固化的模式执行

#### Scenario: 旧变更无模式存档按 full 处理
- **WHEN** 恢复一个无模式存档的旧变更
- **THEN** 该变更按 full 模式执行

#### Scenario: 恢复沿用固化模式
- **WHEN** 变更中断后通过 recovery 恢复
- **THEN** 恢复后的流程沿用变更开始时所固化的模式

### Requirement: simple 流程步骤

simple 模式的变更 SHALL 依次经历 implement、quality_review、done 三个环节；SHALL 不执行 analyze 环节，开发者的执行边界 SHALL 覆盖整个工作区；SHALL 不执行工具验证、任务验证与收尾验证环节。

#### Scenario: simple 变更按三步流转
- **WHEN** simple 变更的 implement 环节完成并提交
- **THEN** 流程进入 quality_review 环节，审查通过后进入 done

#### Scenario: simple 变更无 analyze 环节
- **WHEN** simple 变更开始
- **THEN** 不执行 analyze 环节，开发者执行边界覆盖整个工作区

### Requirement: implement 失败自循环重试

simple 模式下 implement 环节失败 SHALL 回到 implement 环节重新执行。

#### Scenario: implement 提交失败
- **WHEN** simple 变更的 implement 环节被判定失败
- **THEN** 流程回到 implement 环节重新执行

### Requirement: quality_review 合并审查与整步重审

simple 模式的 quality_review 环节 SHALL 由单一审查者合并承担工具检查、任务验证与质量审查；quality_review 失败 SHALL 使流程回到 implement 环节，对全部内容进行整步重审。

#### Scenario: quality_review 通过进入 done
- **WHEN** simple 变更的 quality_review 环节通过
- **THEN** 变更进入 done 环节

#### Scenario: quality_review 失败回 implement 整步重审
- **WHEN** simple 变更的 quality_review 环节被判定失败
- **THEN** 流程回到 implement 环节，对全部内容整步重审

### Requirement: 提交时工作区干净强检查

simple 模式下开发者提交 implement 成果时，系统 SHALL 强检查工作区无未提交内容；存在未提交内容时 SHALL 拒绝提交。

#### Scenario: 工作区不干净拒绝提交
- **WHEN** 开发者提交时工作区存在未提交内容
- **THEN** 提交被拒绝并提示清理工作区

#### Scenario: 工作区干净允许提交
- **WHEN** 开发者提交时工作区无未提交内容
- **THEN** 提交通过，可进入后续环节

### Requirement: 收尾裸合并

simple 模式的收尾 SHALL 为直接合并分支并清理，不执行回归复验与环境清理；收尾合并产生冲突时 SHALL 由开发者解决冲突后直接收尾，不执行额外验证。

#### Scenario: 无冲突直接合并收尾
- **WHEN** simple 变更进入收尾且合并无冲突
- **THEN** 分支被合并、变更完成，且不执行回归复验

#### Scenario: 合并冲突由开发者解决后收尾
- **WHEN** simple 变更收尾合并时产生冲突
- **THEN** 由开发者解决冲突，解决后直接完成收尾且不执行额外验证
