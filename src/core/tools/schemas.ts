/**
 * 6 个 opx_* 工具的纯 JSON Schema 参数定义（内核契约，agent 无关）。
 * 语义与 OpenCode 适配层既有链式 schema 逐一对齐（含嵌套 object/array 校验）；
 * OpenCode 适配层消费本文件后做链式 API 转换，MCP Server 直接按本文件暴露参数。
 */
import type { JSONSchema } from "../provider.ts"
import { SEVERITY_LEVELS } from "../constants.ts"
import { CODE_DIMENSIONS } from "../types.ts"
import { SKIP_REASON_FORMAT } from "./gate.ts"

export const executionBoundarySchema: JSONSchema = {
  type: "object",
  description: "developer 的执行边界",
  properties: {
    allowed_directories: {
      type: "array",
      description: "developer 只能修改/创建文件的目录列表（含实施与验证所需的测试代码目录）",
      items: { type: "string", minLength: 1 },
      minItems: 1,
    },
    allowed_packages: {
      type: "array",
      description: "developer 只能新增/修改代码的包路径列表（含对应的测试包路径）",
      items: { type: "string", minLength: 1 },
      minItems: 1,
    },
    notes: {
      type: "string",
      description:
        "实施建议：关键坑位提醒、组件复用指引、设计约束边缘场景、框架应用说明（如对象映射框架使用要点）；不含目录/包路径（见 allowed_directories/allowed_packages），无则留空",
    },
  },
  required: ["allowed_directories", "allowed_packages", "notes"],
  additionalProperties: false,
}

export const boundaryExpansionSchema: JSONSchema = {
  type: "object",
  description: "reviewer 声明的执行边界扩展",
  properties: {
    allowed_directories: {
      type: "array",
      description: "reviewer 声明的额外允许目录",
      items: { type: "string", minLength: 1 },
      minItems: 1,
    },
    allowed_packages: {
      type: "array",
      description: "reviewer 声明的额外允许包路径",
      items: { type: "string", minLength: 1 },
      minItems: 1,
    },
  },
  additionalProperties: false,
}

export const taskVerifyItem: JSONSchema = {
  type: "object",
  description: "验证失败的子任务项",
  properties: {
    task_id: { type: "string", minLength: 1, description: "子任务 ID（task 清单中 task 项的 id）" },
    reason: { type: "string", minLength: 1, description: "失败理由" },
  },
  required: ["task_id", "reason"],
  additionalProperties: false,
}

export const validationStepSchema: JSONSchema = {
  type: "object",
  description: "验证步骤执行摘要",
  properties: {
    step: { type: "string", minLength: 1, description: "验证步骤名称，对应 opx_status 操作指引中的步骤描述" },
    completed: { type: "boolean", description: "是否完成" },
    evidence: { type: "string", description: "执行结果摘要或证据，含关键输出指标" },
    skip_reason: {
      type: "string",
      description:
        `结构化降级理由 JSON（仅 completed=false 时必填），格式：${SKIP_REASON_FORMAT}；` +
        `adjudication 取值：user_response=用户答复 / unattended_auto=无人值守自动降级 / env_unavailable=环境不可用（须附尝试记录）`,
    },
  },
  required: ["step", "completed"],
  additionalProperties: false,
}

export const blockerItem: JSONSchema = {
  type: "object",
  description: "阻塞项",
  properties: {
    source_role: { type: "string", minLength: 1 },
    task_id: { type: "string", minLength: 1 },
    category: { type: "string", minLength: 1 },
    description: { type: "string", minLength: 1 },
    evidence: { type: "string", minLength: 1 },
    attempted_actions: { type: "string", minLength: 1 },
    options: { type: "array", items: { type: "string", minLength: 1 } },
  },
  required: ["source_role", "category", "description", "evidence", "attempted_actions"],
  additionalProperties: false,
}

export const exemptAdjudicationItem: JSONSchema = {
  type: "object",
  description: "豁免申请裁定项",
  properties: {
    issue_id: { type: "string", minLength: 1, description: "申请豁免的 issue ID" },
    action: {
      type: "string",
      enum: ["dismissed", "rejected"],
      description: "dismissed=豁免成立（issue 置 cancelled）；rejected=驳回（issue 回 todo 继续修复）",
    },
  },
  required: ["issue_id", "action"],
  additionalProperties: false,
}

export const recheckAdjudicationItem: JSONSchema = {
  type: "object",
  description: "待复核 issue 复核项",
  properties: {
    issue_id: { type: "string", minLength: 1, description: "已修复待复核（review 态）的 issue ID" },
    verdict: {
      type: "string",
      enum: ["passed", "rejected"],
      description: "passed=复核通过（issue 置 done）；rejected=复核驳回（issue 回 todo 继续修复）",
    },
    reject_reason: { type: "string", description: "复核驳回原因（verdict=rejected 必填，供 developer 修复参考）" },
  },
  required: ["issue_id", "verdict"],
  additionalProperties: false,
}

export const checkpointSkipReasonItem: JSONSchema = {
  type: "object",
  description: "giveup 决策的必做项结构化降级理由",
  properties: {
    item: { type: "string", minLength: 1, description: "对应的必做项（质量门 skill 的 must_do 清单项）" },
    category: { type: "string", minLength: 1, description: "降级类别，如环境不可用 / 用户裁定豁免 / 无人值守自动降级" },
    adjudication: {
      type: "string",
      enum: ["user_response", "unattended_auto", "env_unavailable"],
      description: "裁定方式：user_response=用户答复 / unattended_auto=无人值守自动降级 / env_unavailable=环境不可用（须附尝试记录）",
    },
    note: { type: "string", description: "降级说明" },
  },
  required: ["item", "category", "adjudication"],
  additionalProperties: false,
}

export const newChildIssueItem: JSONSchema = {
  type: "object",
  description: "提交时新增的 issue child",
  properties: {
    id: { type: "string", minLength: 1, description: "新 issue 的唯一 id（不可为空）" },
    title: { type: "string", minLength: 1, description: "issue 标题（不可为空）" },
    description: { type: "string", minLength: 1, description: "issue 描述（不可为空，参与去重 key）" },
    severity: { type: "string", enum: SEVERITY_LEVELS },
    dimension: {
      type: "string",
      enum: CODE_DIMENSIONS,
      description:
        "issue 归因维度：quality reviewer 报 issue 时由报源自动推断、无需填写（显式填写须与报源维度一致）；tool/task reviewer 报 issue 时必须显式填写",
    },
    file: { type: "string", description: "问题所在文件路径（相对于 worktree）" },
    line: { type: "integer", minimum: 0, description: "问题所在行号（0=整文件/待新建文件）" },
    suggestion: { type: "string", description: "修复建议" },
    rule: { type: "string", description: "工具规则名（如 PMD Rule / SonarQube rule），无则省略" },
    root_cause_guess: { type: "string", description: "根因猜测（仅特定维度需要）" },
  },
  required: ["id", "title", "description"],
  additionalProperties: false,
}

export const recoverySchema: JSONSchema = {
  type: "object",
  description: "进度恢复参数。提供后按 phase 恢复阶段状态，< phase 为 completed，== phase 为 in_progress，> phase 为 not_started。",
  properties: {
    phase: { type: "string", enum: ["task_analysis", "dev_impl", "review"], description: "恢复到哪个阶段" },
    review_layer: {
      type: "string",
      enum: ["tool", "task", "quality"],
      description:
        "恢复到 review 内某子层（仅 phase=review 时有效）。tool→从 tool 层开始（默认），task→tool 层标记完成从 task 层开始，quality→tool+task 层完成从 quality 层开始。已通过（passed）的审查层标记在恢复时保留，恢复自动跳到第一个未全部通过的子层",
    },
    reopenIssues: {
      type: "boolean",
      default: false,
      description:
        "完成后继续修 issue：将目标任务组全部非 verified issue 置为 rejected，重置 review 进度，回到 dev_impl 阶段。目标组必须为 completed。与 review_layer 互斥。",
    },
    reset_steps: {
      type: "array",
      description:
        "重置指定 verify step 的通过标记为 pending（仅 phase=review 时有效，与 review_layer 互斥）。用于已 passed 但被本层遗漏复核/裁定阻塞的 review step 强制重新审查；恢复后 currentStep 落在第一个未全部通过的 verify step，可能早于被重置的 step。",
      items: { type: "string", enum: ["verify_tool", "verify_task", "verify_quality"] },
    },
  },
  required: ["phase"],
  additionalProperties: false,
}

export const orchInitSchema: JSONSchema = {
  type: "object",
  properties: {
    change_id: { type: "string", minLength: 1, description: "OpenSpec 变更 ID" },
    task_group_id: {
      type: "string",
      minLength: 1,
      description: "要初始化的任务组 ID。无 recovery 重复调用当前组时保留进度；切换任务组时仅初始化目标组。",
    },
    base_branch: {
      type: "string",
      description: "基准分支名（如 main、develop），用于计算 merge-base 和 worktree fork 源。未传则自动从当前 git 分支推导。",
    },
    recovery: recoverySchema,
  },
  required: ["change_id", "task_group_id"],
  additionalProperties: false,
}

export const setWorktreeSchema: JSONSchema = {
  type: "object",
  properties: {
    change_id: { type: "string", minLength: 1, description: "change ID" },
    worktree_path: { type: "string", description: "git worktree 的绝对路径（可选，不传则按规范自动生成）" },
    branch_name: { type: "string", description: "worktree 对应的分支名（可选，不传则按规范 task-group/{changeId}/{taskGroupId}）" },
  },
  required: ["change_id"],
  additionalProperties: false,
}

export const statusSchema: JSONSchema = {
  type: "object",
  properties: {
    change_id: { type: "string", minLength: 1, description: "change ID" },
    resume_sessions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          agent: { type: "string", minLength: 1, description: "子代理 agent 名" },
          session_id: { type: "string", minLength: 1, description: "task 工具返回的子代理会话 id（<task id> 或取消错误文本中的 id）" },
        },
        required: ["agent", "session_id"],
        additionalProperties: false,
      },
      description: "子代理返回后登记最近分派会话（仅编排视角生效；按当前 step 待分派判定写/清记录）",
    },
  },
  required: ["change_id"],
  additionalProperties: false,
}

export const completeTaskGroupSchema: JSONSchema = {
  type: "object",
  properties: {
    change_id: { type: "string", minLength: 1, description: "change ID" },
  },
  required: ["change_id"],
  additionalProperties: false,
}

export const setUnattendedSchema: JSONSchema = {
  type: "object",
  properties: {
    change_id: { type: "string", minLength: 1, description: "change ID" },
    enabled: { type: "boolean", default: true, description: "true=开启；false=关闭" },
  },
  required: ["change_id"],
  additionalProperties: false,
}

export const agentSubmitSchema: JSONSchema = {
  type: "object",
  properties: {
    change_id: { type: "string", minLength: 1, description: "change ID" },
    step_id: { type: "string", minLength: 1, description: "workflow step 的 id" },
    verdict: { type: "string", enum: ["passed", "failed"], description: "裁决结果" },
    fixed_issue_ids: {
      type: "array",
      description: "声明已修复的 issue child id",
      items: { type: "string" },
    },
    exempt_issue_ids: {
      type: "array",
      description: "声明申请豁免的 issue child id",
      items: { type: "string" },
    },
    exempt_adjudications: {
      type: "array",
      description: "裁定的豁免申请列表：dismissed→cancelled，rejected→回 todo",
      items: exemptAdjudicationItem,
    },
    recheck_adjudications: {
      type: "array",
      description:
        "复核已修复待复核（review 态）issue 的结论列表：passed→done，rejected→回 todo + refix_count 递增 + 写 reject_reason（谁提谁裁定）",
      items: recheckAdjudicationItem,
    },
    checkpoint_decision: {
      type: "string",
      enum: ["continue", "giveup"],
      description: "重试检查点决策：continue=重置该 step tag 并回退 parent；giveup=未解决 children 强制 cancelled 并将 step 标记 completed",
    },
    checkpoint_skip_reasons: {
      type: "array",
      description: "giveup 决策配套：对当前 step 质量门必做清单未覆盖项的结构化降级理由（未覆盖项缺理由则拒绝 giveup）",
      items: checkpointSkipReasonItem,
    },
    new_children: {
      type: "array",
      description: "提交时新增的 issue child",
      items: newChildIssueItem,
    },
    execution_boundary: {
      ...executionBoundarySchema,
      description: "analyze step：架构预检产出的执行边界（verdict=passed 必传）",
    },
    blockers: { type: "array", description: "analyze step：新增 blocker 列表", items: blockerItem },
    blocker_updates: {
      type: "array",
      description: "analyze step：按 blocker_id 置 resolved 并记录用户答复",
      items: {
        type: "object",
        properties: {
          blocker_id: { type: "string", minLength: 1, description: "blocker ID" },
          user_response: { type: "string", minLength: 1, description: "用户答复" },
        },
        required: ["blocker_id", "user_response"],
        additionalProperties: false,
      },
    },
    blocker: {
      ...blockerItem,
      description: "implement step：outcome=blocked 等价，须配合 verdict=failed",
    },
    self_check_results: { type: "string", description: "implement step：提交前自检结果汇总" },
    completed_task_ids: {
      type: "array",
      description: "implement step：已完成的 task id（覆盖门禁：全部 open/rejected task 必须被覆盖）",
      items: { type: "string" },
    },
    test_results: { type: "string", description: "verify_tool step：UT 运行结果摘要" },
    validation_steps: {
      type: "array",
      description: "review step：验证步骤执行摘要",
      items: validationStepSchema,
    },
    boundary_expansion: {
      ...boundaryExpansionSchema,
      description: "review step：执行边界扩展（仅 verdict=failed 有效）",
    },
    verified_tasks: {
      type: "array",
      description: "verify_task step：验证通过的 task id",
      items: { type: "string" },
    },
    failed_tasks: {
      type: "array",
      description: "verify_task step：验证失败的 task 列表（含原因）",
      items: taskVerifyItem,
    },
  },
  required: ["change_id", "step_id", "verdict"],
  additionalProperties: false,
}

/** 6 个 opx_* 工具的 JSON Schema 注册表（工具名 → 参数 schema）。 */
export const TOOL_SCHEMAS: Record<string, JSONSchema> = {
  opx_orch_init: orchInitSchema,
  opx_orch_set_worktree: setWorktreeSchema,
  opx_status: statusSchema,
  opx_orch_complete_task_group: completeTaskGroupSchema,
  opx_orch_set_unattended: setUnattendedSchema,
  opx_agent_submit: agentSubmitSchema,
}
