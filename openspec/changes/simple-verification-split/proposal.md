## Why

simple 模式下 reviewer（quality_review）全量重复 dev（implement）已执行的验证：确定性工具全量重跑、全量 API 测试重跑与服务重启、同批维度 skill 同 diff 锚点审查。代价有二：

- **执行重复**：确定性检查幂等可复现，reviewer 重跑的增量信息仅为「dev 是否虚报」，但为此付出整轮工具执行与输出解读的 token/时间成本；服务启停、SQL 前置数据、环境清理整个循环在 dev 提交前刚跑过一遍，reviewer 立即原样重走。
- **视角同构（过拟合）**：dev 自检与 reviewer 审查使用同一批 skill 清单、同一 diff 锚点、同一工具链。dev 的优化目标退化为「过清单」而非真实质量；reviewer 的注意力被重复执行与清单核对占据。重复执行防不住真正的作弊模式——弱断言、删断言、Mock 被测对象，重跑一万遍结果都是绿的，只有读脚本对照 spec 才能发现；重复执行反而挤占了本可用于发现这些问题的判断资源。清单之外与清单本身的盲区，双方同构地覆盖不到。

机制层根因：`self_check_results` 存入 metadata（`src/core/tools/submit.ts:311`）但视图层不渲染，reviewer 看不到 dev 的自检证据，复用在机制上不可能；质量门必做清单门禁（`src/core/tools/gate.ts`）仅对 review 提交生效，dev 的质量门执行是提示词级约束——「确定性执行」的事实责任落在 reviewer，「亲自重跑」成为唯一可通过门禁的形态。

## What Changes

核心原则：**验证按性质分流——确定性检查「dev 执行留痕、reviewer 分级复验」；对抗性判断「reviewer 独立视角、不重走 dev 路径」；两者以视图化的自检申报通道衔接。**

### P0（本期，一处最小代码改动 + 配置/文档同步）

- **自检申报视图化**：`opx_status` 的 quality_review 视图新增「开发者自检申报」区块，渲染 dev 提交的 `self_check_results` 与 `test_results`（metadata 事实源 → 视图渲染，非编排者转述）。这是分流的前提通道。
- **reviewer 分级复验**（`assets/workflows/task-simple.yaml` quality_review 指令重写）：
  - 低成本确定性工具（env/compile/format/architecture/static_analysis/unit_test/config_check，分钟级）：保留全量实跑——防虚报成本最低的锚点。
  - 高成本项改为「核验申报 + 抽样重放」：深度扫描（deep_scan）核验 dev 申报证据并抽验命中项，不重扫；全量 API 测试改为按 spec 验收标准选样的核心链路抽样重放 + `.http` 脚本质量审查（断言覆盖/放水/Mock 过度——防作弊主力），服务健康并入抽样重放。
  - 升级条件回退全量重跑：dev 申报缺证据 / 抽验失败 / 发现断言放水类 issue / 修复轮波及接口契约。
  - 对抗性判断不减：task 产出完整性、测试代码质量、业务行为真实性、关键数据产出核验、维度拓展审查全部保留；维度审查锚点调整为「spec 验收标准与行为组/数据产出要求为锚，skill 清单兜底抽查 dev 申报遗漏」。
- **修复轮次收敛**：复核轮聚焦被修复 issue 相关面 + 修复 diff 波及面 + dev 再自检申报；同步改写「逐项验证①-⑥」与「全量代码覆盖」两条表述为首轮/复核轮分口径，消除指令自相矛盾。
- **同步**：`openspec-reviewer.md` 角色定位（分级复验 + 对抗审查，不写分流细则）、`openspec-developer.md`（执行责任人 + 申报人定位）、`gate.ts`/`submit.ts` 头注释的必做覆盖口径（核验申报是 completed=true 的合法形态，仅限高成本必做项）、README、相关测试（视图渲染、门禁回归、simple 流程行为）。

### P1（二期，需工具代码改动，依 P0 实施效果另行立项）

- **dev 申报门禁对称化**：`handleImplementParams` 增加 dev 侧验证申报的校验与存档（独立 metadata key，与 reviewer 的 `validation_steps` 隔离，避免同 key 覆盖与 giveup 读点污染），schemas/types 参数语义扩展。dev 申报不完整时 quality_review 直接触发全量复验升级，P0 的升级条件已兜住该窗口，故门禁化可后置观察。

## Capabilities

### New Capabilities

- `verification-split`：simple 模式验证分流契约——确定性检查与对抗性判断的划分标准、低成本/高成本分级复验规则（实跑 / 核验申报 + 抽样重放）、升级回退全量的触发条件、修复轮次收敛口径、自检申报区块的跨角色可见性语义。

### Modified Capabilities

无。`openspec/specs/` 当前为空，本变更不修改任何既有 capability。

## Impact

- 编排核心：`src/core/views.ts`（自检申报渲染函数）、`src/core/workflow/status.ts`（quality_review 视图组装调用）；`gate.ts`/`submit.ts` 仅注释口径同步。
- 配置：`assets/workflows/task-simple.yaml`（implement 申报要求强化、quality_review 分级复验与复核轮分口径重写）。
- agent 定义与文档：`assets/agents/openspec-reviewer.md`、`assets/agents/openspec-developer.md`、README.md。
- 测试：`tests/opx_status_workflow.test.ts`、`tests/workflow.views.test.ts`、`tests/orchestrate.simple-e2e.test.ts`、`tests/must-do-gate.test.ts`。
- 风险权衡：simple 收尾为裸合并无回归，quality_review 是唯一防线——收窄执行面后防线依赖「低成本实跑 + 抽验 + 脚本审查 + 升级条件」组合，残余虚报窗口（非核心链路接口申报虚报仅间接防御）在轻量变更定位下接受；详见 design.md。
