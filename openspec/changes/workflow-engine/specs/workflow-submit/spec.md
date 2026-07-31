## ADDED Requirements

### Requirement: opx_agent_submit 按 step_id 路由
`opx_agent_submit` SHALL 接受 `step_id` 与 `agent_tag` 参数，按 step_id 路由到对应 workflow 的 step 配置，并校验调用者 agent 属于该 step 的 agents 列表。提交后 SHALL 以 `{step_id}:{agent_key}:{verdict}` 更新对应 tag。

#### Scenario: 合法 step 提交
- **WHEN** 属于某 step 的 agent 以对应 step_id 提交 passed
- **THEN** 该 agent 的 tag 被更新为 passed，并据此计算 step 裁决

#### Scenario: 越权 agent 提交被拒
- **WHEN** 不属于该 step agents 列表的 agent 提交该 step_id
- **THEN** 提交被拒绝并返回错误，不产生任何状态变更

### Requirement: 提交内执行门禁与 children 更新
`opx_agent_submit` SHALL 在提交时执行 phase 门禁（正向前进检查当前 phase 全部 step passed，反向回退按规则处理）并更新 children：声明 fixed 的 child 置为 done、声明 exempt 的 child 挂 exempt 标记等待对应 reviewer 裁定、传入的 new_children 写入 children。

#### Scenario: 正向推进时校验 phase 门禁
- **WHEN** 提交使得该 step 内全部 agent 均 passed 且目标跨 phase
- **THEN** 仅当当前 phase 全部 step passed 且 Low+ children 达到目标 phase 才放行进入下一 phase，否则停留

#### Scenario: fixed children 置为 done
- **WHEN** 提交声明某 child 为 fixed
- **THEN** 该 child 的 phase 被置为 done

#### Scenario: exempt 等待裁定
- **WHEN** 提交声明某 child 为 exempt
- **THEN** 该 child 在自身 metadata 记录 exempt 标记，等待对应 reviewer 裁定，不直接改变终态且不写入 tags

### Requirement: 豁免路由与裁定
提交的 issue child SHALL 在其 metadata.source 记录报 issue 的 agent_id。workflow YAML 的 review step SHALL 通过 reviewer_for 声明其裁定来源的 agent_key 列表；豁免申请 SHALL 依据 issue 的 metadata.source 匹配 reviewer_for 路由到对应 reviewer step，无匹配时交由 orchestrator 处理。reviewer 裁定 dismissed 时 child 置为 cancelled，裁定 rejected 时 child 置为 todo。

#### Scenario: 豁免路由到对应 reviewer
- **WHEN** 某 agent 提交 issue child 并声明 exempt
- **THEN** 引擎依据 issue 的 metadata.source 匹配 reviewer_for 声明，将该 issue 的裁定推荐给对应 reviewer step

#### Scenario: 无匹配 reviewer 时提示人工
- **WHEN** 某 issue 的 metadata.source 与任何 review step 的 reviewer_for 均不匹配
- **THEN** 豁免申请不被自动路由，opx_status 提示 orchestrator 手动处理

#### Scenario: dismissed 取消 issue
- **WHEN** reviewer 对带 exempt 标记的 issue 裁定 dismissed
- **THEN** 该 child 的 phase 被置为 cancelled

#### Scenario: rejected 打回重做
- **WHEN** reviewer 对带 exempt 标记的 issue 裁定 rejected
- **THEN** 该 child 的 phase 被置为 todo

### Requirement: 写回调度
提交触发的外部写回 SHALL 以非阻塞异步方式执行；失败时记录 lastAttempt 与 error，并 SHALL 在下次状态变更时重试；成功时记录 lastSuccess。

#### Scenario: 写回失败延迟重试
- **WHEN** 某次状态变更触发的写回失败
- **THEN** writeback 记录 lastAttempt 与 error，且后续状态变更自动重试

#### Scenario: 写回成功记录
- **WHEN** 写回执行成功
- **THEN** writeback 记录 lastSuccess 时间戳
