## ADDED Requirements

### Requirement: 5 列看板
看板 SHALL 按 WorkItem 的 phase 映射为 5 列：todo→待办、in_progress→处理中、review→审核中、done→完成、cancelled→已取消。suspended 的卡片 SHALL 留在其 phase 所在列。

#### Scenario: phase 映射看板列
- **WHEN** WorkItem 的 phase 为 review
- **THEN** 卡片显示在审核中列

#### Scenario: 暂停卡片保留原列
- **WHEN** WorkItem 的 suspended 为 true
- **THEN** 卡片仍显示在其 phase 对应列，并带暂停标记

### Requirement: 卡片信息
看板卡片 SHALL 展示标题、描述、labels、来源图标、currentStep 小字标注；suspended 卡片 SHALL 右下角显示暂停标记，展开时显示 metadata.suspend_reason 中的暂停原因；issue 卡片 SHALL 显示按 severity 的色条；多 agent step SHALL 汇总展示各 agent 的裁决 tag 进度。

#### Scenario: 卡片展示核心字段
- **WHEN** 渲染一张 task 卡片
- **THEN** 卡片展示标题、描述、labels、来源图标与 currentStep

#### Scenario: 汇总多 agent 进度
- **WHEN** step 内多个 agent 各有裁决
- **THEN** 卡片按 `agent:verdict` 汇总展示（如 style:passed、arch:pending）

#### Scenario: issue 卡片 severity 色条
- **WHEN** 渲染一张 issue 卡片
- **THEN** 卡片按 severity 显示对应颜色的色条

### Requirement: 卡片类型区分
task 卡片与 issue 卡片 SHALL 有明确的样式区分，便于一眼识别类型。

#### Scenario: task 与 issue 样式不同
- **WHEN** task 卡片与 issue 卡片并排渲染
- **THEN** 两者样式可区分（类型标识、色条、来源等视觉差异）
