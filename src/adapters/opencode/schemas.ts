import { tool } from "@opencode-ai/plugin"
import { SEVERITY_LEVELS } from "../../core/constants.js"
import { CODE_DIMENSIONS } from "../../core/types.js"

export const executionBoundarySchema = tool.schema.object({
  allowed_directories: tool.schema.array(tool.schema.string().min(1)).min(1).describe("developer 只能修改/创建文件的目录列表（含实施与验证所需的测试代码目录）"),
  allowed_packages: tool.schema.array(tool.schema.string().min(1)).min(1).describe("developer 只能新增/修改代码的包路径列表（含对应的测试包路径）"),
  notes: tool.schema.string().describe("实施建议：关键坑位提醒、组件复用指引、设计约束边缘场景、框架应用说明（如对象映射框架使用要点）；不含目录/包路径（见 allowed_directories/allowed_packages），无则留空"),
})

export const boundaryExpansionSchema = tool.schema.object({
  allowed_directories: tool.schema.array(tool.schema.string().min(1)).optional().describe("reviewer 声明的额外允许目录"),
  allowed_packages: tool.schema.array(tool.schema.string().min(1)).optional().describe("reviewer 声明的额外允许包路径"),
})

export const reviewIssue = tool.schema.object({
  severity: tool.schema.enum(SEVERITY_LEVELS).describe("严重级别（Critical/High/Medium/Low/Info）"),
  file: tool.schema.string().min(1).describe("问题所在文件路径（相对于 worktree）"),
  line: tool.schema.number().int().min(0).describe("问题所在行号（0=整文件/待新建文件，如 tool 改进 issue 指向待建配置文件）"),
  description: tool.schema.string().min(1).describe("问题描述"),
  suggestion: tool.schema.string().optional().describe("修复建议"),
  root_cause_guess: tool.schema.string().optional().describe("根因猜测（仅特定维度需要）"),
})

export const requestExemptItem = tool.schema.object({
  issue_id: tool.schema.string().min(1).describe("申请豁免的 issue ID"),
  reason: tool.schema.string().min(1).describe("豁免理由"),
})

export const rejectedIssueItem = tool.schema.object({
  issue_id: tool.schema.string().min(1).describe("驳回的 issue ID"),
  reason: tool.schema.string().min(1).describe("驳回原因"),
})

export const taskVerifyItem = tool.schema.object({
  task_id: tool.schema.string().min(1).describe("子任务 ID（task 清单中 task 项的 id）"),
  reason: tool.schema.string().min(1).describe("失败理由"),
})

export const toolIssueItem = tool.schema.object({
  dimension: tool.schema.enum(CODE_DIMENSIONS).describe("issue 所属维度（5 维之一）"),
  severity: tool.schema.enum(SEVERITY_LEVELS).describe("严重级别"),
  file: tool.schema.string().min(1).describe("问题所在文件路径"),
  line: tool.schema.number().int().min(0).describe("问题所在行号（0=整文件/待新建文件，如 tool 改进 issue 指向待建配置文件）"),
  description: tool.schema.string().min(1).describe("问题描述"),
  suggestion: tool.schema.string().optional().describe("修复建议"),
})

export const taskVerifyResult = tool.schema.object({
  task_id: tool.schema.string().min(1).describe("子任务 ID"),
  reason: tool.schema.string().min(1).describe("失败理由"),
})

export const validationStepSchema = tool.schema.object({
  step: tool.schema.string().min(1).describe("验证步骤名称，对应 opx_status 操作指引中的步骤描述"),
  completed: tool.schema.boolean().describe("是否完成"),
  evidence: tool.schema.string().optional().describe("执行结果摘要或证据，含关键输出指标"),
  skip_reason: tool.schema.string().optional().describe("跳过原因（仅 completed=false 时必填）"),
})

export const blockerItem = tool.schema.object({
  source_role: tool.schema.string().min(1),
  task_id: tool.schema.string().min(1).optional(),
  category: tool.schema.string().min(1),
  description: tool.schema.string().min(1),
  evidence: tool.schema.string().min(1),
  attempted_actions: tool.schema.string().min(1),
  options: tool.schema.array(tool.schema.string().min(1)).optional(),
})
