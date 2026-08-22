## Purpose

定义 simple 模式验证分流契约：确定性检查与对抗性判断的划分标准、低成本/高成本分级复验规则（实跑 / 核验申报 + 抽样重放）、升级回退全量重跑的触发条件、修复轮次收敛口径，以及自检申报跨角色可见的语义。

## ADDED Requirements

### Requirement: 验证按性质分流

simple 模式的验证 SHALL 按性质划分归属：确定性检查（给定相同输入结果恒定的工具链、构建、静态分析、深度扫描、既有 `.http` 脚本重放）由开发者执行并申报，审查者分级复验；对抗性判断（断言是否放水、Mock 是否过度、行为是否真实生效、数据是否落对位置、清单外缺陷）SHALL 由审查者以独立视角承担，不重走开发者路径。

#### Scenario: 确定性检查由开发者执行并申报
- **WHEN** simple 模式变更进入实施环节
- **THEN** 确定性检查与接口测试由开发者执行，执行命令与结果摘要经自检申报留痕

#### Scenario: 对抗性判断保持审查者独立视角
- **WHEN** simple 模式变更进入合并审查环节
- **THEN** 测试代码质量、业务行为真实性、关键数据产出核验等对抗性判断由审查者独立执行，不以重跑开发者路径替代

### Requirement: 自检申报跨角色可见

开发者提交的自检申报（`self_check_results` / `test_results`）SHALL 在合并审查（quality_review）视图中渲染为「开发者自检申报」区块，作为审查者分级复验的事实输入；两字段皆缺失或为空时 SHALL NOT 渲染空区块；implement 视图 SHALL NOT 渲染该区块。跨角色可见是正式提交参数存档的设计意图，不构成编排者向子代理转述动态上下文。

#### Scenario: 申报存在时审查者视图渲染
- **WHEN** 开发者已提交自检申报且流程处于 quality_review 环节
- **THEN** 审查者的状态视图渲染「开发者自检申报」区块，含自检申报与接口测试结果两段

#### Scenario: 申报缺失时不渲染空区块
- **WHEN** 流程处于 quality_review 环节但 `self_check_results` 与 `test_results` 均未提交
- **THEN** 状态视图不渲染「开发者自检申报」区块

#### Scenario: implement 视图不渲染申报区块
- **WHEN** 流程处于 implement 环节（含审查回退后的修复轮）
- **THEN** 开发者视图不渲染「开发者自检申报」区块

### Requirement: 低成本必做项全量实跑

审查者对分钟级低成本必做项（env / compile / format / architecture / static_analysis / unit_test / config_check 一类）SHALL 全量实跑并逐项申报（completed=true 附执行结果）；低成本必做项 SHALL NOT 以核验申报形态替代实跑。

#### Scenario: 低成本项实跑申报
- **WHEN** 合并审查进入「有变更」分支
- **THEN** 低成本必做项由审查者实跑后逐项申报执行结果，工具输出映射为统一 issue 结构

### Requirement: 高成本项核验申报与抽样重放

高成本项（deep_scan 及全量 API 测试）SHALL 按核验申报与抽样重放执行：deep_scan 核验开发者申报（证据完整性、命中项与 diff 的合理性）并抽验命中项，不重扫全量；全量 API 测试与服务健康按 spec 验收标准选样 1-2 条端到端核心链路抽样重放（覆盖创建-检索-变更-删除闭环中 spec 声明的关键行为，能重放即视为服务健康）并审查 `.http` 脚本质量（对照 spec 核断言覆盖/放水/Mock 过度）。核验申报的申报形态 SHALL 为 step 名首段命中必做项 token、completed=true、描述注明核验方式与抽验样本；该形态仅限高成本必做项（deep_scan）使用。纯测试代码变更豁免分支（豁免抽样重放，仅验证 task 产出完整性与测试代码质量）SHALL 保留。

#### Scenario: deep_scan 核验申报通过必做清单门禁
- **WHEN** 审查者以 step 名首段为 deep_scan、completed=true、描述注明核验方式与抽验样本的 validation_steps 条目申报
- **THEN** 该必做项视为已覆盖，通过必做清单覆盖度门禁

#### Scenario: 核心链路抽样重放替代全量重跑
- **WHEN** 合并审查验证接口行为
- **THEN** 审查者按 spec 验收标准选样核心链路抽样重放并审查脚本质量，不独立重放全量 API 测试、不重复启动服务检查健康

#### Scenario: 纯测试代码变更豁免分支保留
- **WHEN** 本轮变更仅含测试代码且无生产代码、接口契约与构建/测试配置变更
- **THEN** 豁免抽样重放，仅验证 task 产出完整性与测试代码质量，豁免项以 completed=false + 结构化 skip_reason 申报

### Requirement: 升级回退全量重跑

以下四类触发条件 SHALL 统一触发高成本项回退为实跑全量重跑：开发者申报缺证据或不完整；抽验失败；发现断言放水类 issue；本轮为修复轮且修复波及接口契约或数据口径。

#### Scenario: 申报缺证据触发升级
- **WHEN** 开发者自检申报缺少可核验证据或申报不完整
- **THEN** 本轮高成本项改为实跑全量重跑

#### Scenario: 修复轮波及契约触发升级
- **WHEN** 修复轮的修复 diff 波及接口契约或数据口径
- **THEN** 本轮高成本项改为实跑全量重跑

### Requirement: 修复轮次收敛

首轮审查 SHALL 按分级复验与对抗判断全项执行；复核轮（二轮起）SHALL 聚焦被修复 issue 相关面、本轮修复 diff 波及面与开发者再自检申报；首轮已通过且无波及的维度与低成本工具结论 SHALL NOT 重审，但低成本工具实跑 SHALL 保留（防修复引入回归）。

#### Scenario: 复核轮聚焦收敛
- **WHEN** quality_review 失败回退 implement 后开发者修复并重新提交
- **THEN** 复核轮审查聚焦被修复 issue 相关面与修复 diff 波及面，不重审首轮已通过且无波及的维度结论

#### Scenario: 复核轮保留低成本实跑
- **WHEN** 复核轮判断首轮已通过的维度无波及
- **THEN** 低成本工具仍实跑以防修复引入回归

### Requirement: 必做清单门禁兼容核验申报

必做清单覆盖度门禁 SHALL 仅按 validation_steps 的 step 名首段 token 命中判定覆盖，不区分实跑与核验申报形态；核验申报（completed=true）SHALL 视为合法覆盖形态。低成本项误用核验申报形态由 workflow 指令白名单约束，门禁错误提示 SHALL 明示「低成本必做项必须实跑后申报；核验申报仅限高成本必做项」口径。

#### Scenario: 门禁错误提示明示低成本口径
- **WHEN** review 提交遗漏必做项被门禁拒绝
- **THEN** 错误提示包含低成本必做项必须实跑、核验申报仅限高成本必做项的口径说明
